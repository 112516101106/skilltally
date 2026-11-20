import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { detectSkillCalls, extractUsageMetrics, sanitizePromptPreview } from '../core/detect.mjs';

const TARGET_TOOLS = new Set(['Skill', 'Read', 'View', 'Bash']);

function walkJsonlFiles(dir, out = []) {
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
      walkJsonlFiles(full, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

export function backfillClaude({ homeDir = homedir(), since = null, storePrompts = false } = {}) {
  const files = walkJsonlFiles(join(homeDir, '.claude', 'projects')).sort();
  const sinceMs = since instanceof Date ? since.getTime() : since ? Date.parse(since) : null;
  const events = [];

  for (const file of files) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!raw || (!raw.includes('"Skill"') && !raw.includes('SKILL.md') && !raw.includes('Base directory for this skill:'))) continue;

    let sessionId = basename(file, '.jsonl');
    let cwd = '';
    const pendingCalls = [];
    const failedIds = new Set();
    let turnId = 0;
    let lastUserPrompt = '';
    const turnEndMsMap = new Map();
    const turnUsageMap = new Map();

    const recordTurnTs = (id, tsStr) => {
      if (!tsStr) return;
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

      if (obj.sessionId) sessionId = obj.sessionId;
      if (obj.cwd) cwd = obj.cwd;

      const content = obj.message?.content;
      if (obj.type === 'user') {
        if (typeof content === 'string') {
          turnId += 1;
          lastUserPrompt = content;
          recordTurnTs(turnId, obj.timestamp);
          if (content.includes('Base directory for this skill:') || content.includes('SKILL.md') || content.includes('<skill>')) {
            pendingCalls.push({
              idx: pendingCalls.length,
              ts: obj.timestamp,
              turnId,
              tool: 'UserPromptSubmit',
              callId: obj.uuid || `user_${pendingCalls.length}`,
              input: {},
              prompt: content,
              promptText: content,
              cwd,
              model: undefined,
            });
          }
          continue;
        }
        if (!Array.isArray(content)) continue;
        const textParts = [];
        for (const block of content) {
          if (block?.type === 'tool_result' && block.is_error === true && block.tool_use_id) {
            failedIds.add(block.tool_use_id);
          } else if (block?.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          }
        }
        if (textParts.length > 0) {
          turnId += 1;
          lastUserPrompt = textParts.join(' ');
        }
        recordTurnTs(turnId, obj.timestamp);
        for (const block of content) {
          if (
            block?.type === 'text' &&
            typeof block.text === 'string' &&
            (block.text.includes('Base directory for this skill:') ||
              block.text.includes('SKILL.md') ||
              block.text.includes('<skill>'))
          ) {
            pendingCalls.push({
              idx: pendingCalls.length,
              ts: obj.timestamp,
              turnId,
              tool: 'UserPromptSubmit',
              callId: obj.uuid || `user_${pendingCalls.length}`,
              input: {},
              prompt: block.text,
              promptText: lastUserPrompt,
              cwd,
              model: undefined,
            });
          }
        }
        continue;
      }

      recordTurnTs(turnId, obj.timestamp);
      if (obj.type !== 'assistant') continue;

      const model = obj.message?.model;
      const msgUsage = extractUsageMetrics(obj.message?.usage ?? obj.usage);
      if (msgUsage) {
        turnUsageMap.set(turnId, msgUsage);
      }

      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== 'tool_use' || !TARGET_TOOLS.has(block.name)) continue;
        pendingCalls.push({
          idx: pendingCalls.length,
          ts: obj.timestamp,
          turnId,
          tool: block.name,
          callId: block.id,
          input: block.input && typeof block.input === 'object' ? block.input : {},
          usage: msgUsage,
          promptText: lastUserPrompt,
          cwd,
          model,
        });
      }
    }

    for (const call of pendingCalls) {
      if (sinceMs !== null && call.ts) {
        const tsMs = Date.parse(call.ts);
        if (Number.isFinite(tsMs) && tsMs < sinceMs) continue;
      }

      const hits = detectSkillCalls({
        tool: call.tool,
        args: call.input,
        prompt: call.prompt,
        cwd: call.cwd,
        homeDir,
        allowShell: call.tool !== 'UserPromptSubmit',
      });

      const ok = call.callId ? !failedIds.has(call.callId) : true;
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
        events.push({
          v: 1,
          id: `claude:${sessionId}:${call.callId || call.idx}#${hitIdx}`,
          ts: call.ts || new Date(0).toISOString(),
          host: 'claude',
          skill: h.skill,
          ...(h.raw_skill && h.raw_skill !== h.skill ? { raw_skill: h.raw_skill } : {}),
          ...(h.skill_path ? { skill_path: h.skill_path } : {}),
          source: h.source || 'unknown',
          via: h.via,
          tool: call.tool,
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
    events,
  };
}
