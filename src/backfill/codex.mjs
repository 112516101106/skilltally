import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import zlib from 'node:zlib';
import { detectSkillCalls, extractUsageMetrics, sanitizePromptPreview } from '../core/detect.mjs';

function walkSessionFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walkSessionFiles(full, out);
    } else if (e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zst'))) {
      out.push(full);
    }
  }
  return out;
}

function readSessionText(filePath) {
  if (!filePath.endsWith('.zst')) {
    return { text: readFileSync(filePath, 'utf8'), skippedZst: false };
  }
  const buf = readFileSync(filePath);
  if (typeof zlib.zstdDecompressSync === 'function') {
    return { text: zlib.zstdDecompressSync(buf).toString('utf8'), skippedZst: false };
  }
  try {
    const out = execFileSync('zstd', ['-dc', filePath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { text: out, skippedZst: false };
  } catch {
    return { text: null, skippedZst: true };
  }
}

function isOutputError(output) {
  if (!output) return false;
  if (typeof output === 'object') {
    if (output.is_error === true) return true;
    if (typeof output.exit_code === 'number' && output.exit_code !== 0) return true;
    return false;
  }
  const str = String(output);
  if (/Process exited with code [1-9]\d*/.test(str)) return true;
  if (/exit status [1-9]\d*/i.test(str)) return true;
  if (/No such file or directory/i.test(str)) return true;
  return false;
}

function sessionIdFromFilename(filePath) {
  const m = basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : basename(filePath);
}

export function backfillCodex({ homeDir = homedir(), since = null, storePrompts = false } = {}) {
  const files = [
    ...walkSessionFiles(join(homeDir, '.codex', 'sessions')),
    ...walkSessionFiles(join(homeDir, '.codex', 'archived_sessions')),
  ].sort();

  const sinceMs = since instanceof Date ? since.getTime() : since ? Date.parse(since) : null;
  const events = [];
  const seenHardwareCalls = new Set();
  let skippedZst = 0;

  for (const file of files) {
    let readRes;
    try {
      readRes = readSessionText(file);
    } catch {
      continue;
    }
    if (readRes.skippedZst) {
      skippedZst += 1;
      continue;
    }
    const raw = readRes.text;
    if (
      !raw ||
      (!raw.includes('SKILL.md') &&
        !raw.includes('<skill>') &&
        !raw.includes('skill://') &&
        !raw.includes('/skills/'))
    ) {
      continue;
    }

    let sessionId = sessionIdFromFilename(file);
    let hasSessionMeta = false;
    let cwd = '';
    let model = undefined;

    const pendingCalls = [];
    const failedCalls = new Set();
    let turnIdx = 0;
    let turnActive = false;
    let turnHasToolOrAssistant = false;
    let turnPrompt = '';
    const turnPromptSkills = new Set();
    const turnEndMsMap = new Map();
    const turnUsageMap = new Map();

    const recordTurnTs = (id, tsStr) => {
      if (!tsStr || id <= 0) return;
      const ms = Date.parse(tsStr);
      if (!Number.isFinite(ms)) return;
      const prev = turnEndMsMap.get(id);
      if (prev === undefined || ms > prev) turnEndMsMap.set(id, ms);
    };

    for (const line of raw.split('\n')) {
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type === 'session_meta' && obj.payload) {
        if (!hasSessionMeta && (obj.payload.id || obj.payload.session_id)) {
          sessionId = obj.payload.id || obj.payload.session_id;
          hasSessionMeta = true;
        }
        if (!cwd && obj.payload.cwd) cwd = obj.payload.cwd;
        continue;
      }

      if (obj.type === 'event_msg' && obj.payload?.type === 'task_started') {
        turnIdx += 1;
        turnActive = true;
        turnHasToolOrAssistant = false;
        turnPromptSkills.clear();
        turnPrompt = '';
        recordTurnTs(turnIdx, obj.timestamp);
        continue;
      }

      if (obj.type === 'event_msg' && (obj.payload?.type === 'task_complete' || obj.payload?.type === 'turn_aborted')) {
        if (turnActive) {
          recordTurnTs(turnIdx, obj.timestamp);
          turnActive = false;
          turnHasToolOrAssistant = false;
        }
        continue;
      }

      if (obj.type === 'turn_context' && obj.payload) {
        if (obj.payload.cwd) cwd = obj.payload.cwd;
        if (obj.payload.model) model = obj.payload.model;
        if (!turnActive || turnHasToolOrAssistant) {
          turnIdx += 1;
          turnActive = true;
          turnHasToolOrAssistant = false;
          turnPromptSkills.clear();
          turnPrompt = '';
        }
        recordTurnTs(turnIdx, obj.timestamp);
        continue;
      }

      if (turnActive) recordTurnTs(turnIdx, obj.timestamp);

      if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
        const u = extractUsageMetrics(obj.payload?.info?.last_token_usage ?? obj.payload?.usage);
        if (u && turnIdx > 0) turnUsageMap.set(turnIdx, u);
        continue;
      }

      if (obj.type !== 'response_item' || !obj.payload) continue;
      if (!turnActive) {
        turnIdx += 1;
        turnActive = true;
        turnHasToolOrAssistant = false;
        turnPromptSkills.clear();
        turnPrompt = '';
        recordTurnTs(turnIdx, obj.timestamp);
      }
      const p = obj.payload;

      const itemUsage = extractUsageMetrics(obj.usage ?? p.usage);
      if (itemUsage) turnUsageMap.set(turnIdx, itemUsage);

      if (p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
        const userTextParts = [];
        for (const part of p.content) {
          if (typeof part?.text === 'string' && part.text.trim()) {
            userTextParts.push(part.text);
          }
        }
        if (userTextParts.length > 0) {
          turnPrompt = userTextParts.join(' ');
        }

        for (const part of p.content) {
          const text = part?.text;
          if (
            typeof text !== 'string' ||
            (!text.includes('<skill>') && !text.includes('SKILL.md'))
          ) {
            continue;
          }
          const promptHits = detectSkillCalls({
            tool: 'UserPromptSubmit',
            args: {},
            prompt: text,
            cwd,
            homeDir,
            allowShell: false,
          });
          const uniqueTurnHits = [];
          for (const h of promptHits) {
            const key = `${h.skill}\0${(h.skill_path || '').replace(/\\/g, '/')}`;
            if (turnPromptSkills.has(key)) continue;
            turnPromptSkills.add(key);
            uniqueTurnHits.push(h);
          }
          if (uniqueTurnHits.length > 0) {
            pendingCalls.push({
              idx: pendingCalls.length,
              ts: obj.timestamp,
              turnId: turnIdx,
              tool: 'UserPromptSubmit',
              callId: p.id || `prompt_${turnIdx}_${pendingCalls.length}`,
              args: {},
              precomputedHits: uniqueTurnHits,
              promptText: turnPrompt,
              cwd,
              model,
            });
          }
        }
        continue;
      }

      if (p.type === 'message' && p.role === 'assistant') {
        turnHasToolOrAssistant = true;
        turnPromptSkills.clear();
        continue;
      }

      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        if (p.call_id && isOutputError(p.output)) {
          failedCalls.add(p.call_id);
        }
        continue;
      }

      if (p.type !== 'function_call' && p.type !== 'custom_tool_call') continue;
      turnHasToolOrAssistant = true;
      turnPromptSkills.clear();

      const textToScan = p.type === 'function_call' ? p.arguments : p.input;
      if (
        typeof textToScan !== 'string' ||
        (!textToScan.includes('SKILL.md') &&
          !textToScan.includes('skill://') &&
          !textToScan.includes('/skills/'))
      ) {
        continue;
      }

      let argsObj = {};
      if (p.type === 'function_call') {
        try {
          const parsed = JSON.parse(textToScan);
          argsObj = parsed && typeof parsed === 'object' ? parsed : { cmd: textToScan };
        } catch {
          argsObj = { cmd: textToScan };
        }
      } else {
        argsObj = { input: textToScan };
      }

      pendingCalls.push({
        idx: pendingCalls.length,
        ts: obj.timestamp,
        turnId: turnIdx,
        tool: p.name,
        callId: p.call_id,
        args: argsObj,
        usage: itemUsage,
        promptText: turnPrompt,
        cwd,
        model,
      });
    }

    for (const call of pendingCalls) {
      if (sinceMs !== null && call.ts) {
        const tsMs = Date.parse(call.ts);
        if (Number.isFinite(tsMs) && tsMs < sinceMs) continue;
      }

      const hits =
        call.precomputedHits ||
        detectSkillCalls({
          tool: call.tool,
          args: call.args,
          cwd: call.cwd,
          homeDir,
          allowShell: true,
        });

      const ok = call.callId ? !failedCalls.has(call.callId) : true;
      const callTsMs = call.ts ? Date.parse(call.ts) : NaN;
      const turnEndMs = turnEndMsMap.get(call.turnId);
      const durationSeconds =
        Number.isFinite(callTsMs) &&
        Number.isFinite(turnEndMs) &&
        turnEndMs >= callTsMs &&
        turnEndMs - callTsMs <= 86400_000
          ? Math.round((turnEndMs - callTsMs) / 1000)
          : 0;
      const usage = call.usage || turnUsageMap.get(call.turnId) || null;
      const promptPreview = storePrompts && call.promptText ? sanitizePromptPreview(call.promptText) : '';

      hits.forEach((h, hitIdx) => {
        if (call.callId && !String(call.callId).startsWith('prompt_')) {
          const hwKey = `${call.callId}#${hitIdx}`;
          if (seenHardwareCalls.has(hwKey)) return;
          seenHardwareCalls.add(hwKey);
        }
        events.push({
          v: 1,
          id: `codex:${sessionId}:${call.callId || call.idx}#${hitIdx}`,
          ts: call.ts || new Date(0).toISOString(),
          host: 'codex',
          skill: h.skill,
          ...(h.skill_path ? { skill_path: h.skill_path } : {}),
          source: h.source,
          via: h.via,
          ...(call.tool ? { tool: call.tool } : {}),
          session_id: sessionId,
          ...(call.cwd ? { project: basename(call.cwd) } : {}),
          ...(call.model ? { model: call.model } : {}),
          ...(durationSeconds > 0 ? { duration_seconds: durationSeconds } : {}),
          ...(usage ? usage : {}),
          ...(promptPreview ? { prompt_preview: promptPreview } : {}),
          origin: 'backfill',
          ok,
        });
      });
    }
  }

  return {
    files: files.length,
    skippedZst,
    events,
  };
}
