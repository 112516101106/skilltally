import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { detectSkillCalls, extractUsageMetrics, sanitizePromptPreview, unwrapArg } from '../core/detect.mjs';

const TARGET_TOOLS = new Set(['read_file', 'view_file', 'run_command']);
const PRODUCT_DIRS = ['antigravity', 'antigravity-cli', 'antigravity-ide'];

function findTranscripts(homeDir) {
  const results = [];
  for (const product of PRODUCT_DIRS) {
    const brainDir = join(homeDir, '.gemini', product, 'brain');
    if (!existsSync(brainDir)) continue;
    let convs;
    try {
      convs = readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of convs) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const transcript = join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (existsSync(transcript)) {
        results.push({
          host: product,
          sessionId: entry.name,
          transcriptPath: transcript,
          fullPath: join(brainDir, entry.name, '.system_generated', 'logs', 'transcript_full.jsonl'),
        });
      }
    }
  }
  return results;
}

function loadFullRecord(fullLinesCache, fullPath, lineIdx, stepIndex) {
  if (fullLinesCache.lines === undefined) {
    if (existsSync(fullPath)) {
      try {
        fullLinesCache.lines = readFileSync(fullPath, 'utf8').split('\n');
      } catch {
        fullLinesCache.lines = null;
      }
    } else {
      fullLinesCache.lines = null;
    }
  }
  const lines = fullLinesCache.lines;
  if (!lines) return null;

  if (lineIdx < lines.length && lines[lineIdx]) {
    try {
      const candidate = JSON.parse(lines[lineIdx]);
      if (candidate?.step_index === stepIndex) return candidate;
    } catch {}
  }

  for (const raw of lines) {
    if (!raw || !raw.includes('"tool_calls"')) continue;
    try {
      const candidate = JSON.parse(raw);
      if (candidate?.step_index === stepIndex) return candidate;
    } catch {}
  }
  return null;
}

export function backfillAntigravity({ homeDir = homedir(), since = null, storePrompts = false } = {}) {
  const transcripts = findTranscripts(homeDir);
  const sinceMs = since instanceof Date ? since.getTime() : since ? Date.parse(since) : null;
  const events = [];

  for (const item of transcripts) {
    let raw;
    try {
      raw = readFileSync(item.transcriptPath, 'utf8');
    } catch {
      continue;
    }
    if (!raw || (!raw.includes('SKILL.md') && !raw.includes('truncated_fields') && !raw.includes('<SKILL>'))) {
      continue;
    }

    const lines = raw.split('\n');
    const fullCache = { lines: undefined };
    const convEvents = [];
    const pendingUserSkills = [];
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

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      if (!line) continue;

      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const ts = obj.created_at;
      const stepIdx = obj.step_index ?? lineIdx;

      if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
        turnId += 1;
        lastUserPrompt = obj.content;
        recordTurnTs(turnId, ts);

        if (obj.content.includes('<SKILL>')) {
          if (sinceMs !== null && ts) {
            const tsMs = Date.parse(ts);
            if (Number.isFinite(tsMs) && tsMs < sinceMs) continue;
          }
          const promptHits = detectSkillCalls({
            tool: 'USER_INPUT',
            args: {},
            prompt: obj.content,
            cwd: '',
            homeDir,
            allowShell: false,
          });
          promptHits.forEach((h, hitIdx) => {
            pendingUserSkills.push({
              v: 1,
              id: `${item.host}:${item.sessionId}:${stepIdx}#${hitIdx}`,
              ts: ts || new Date(0).toISOString(),
              host: item.host,
              skill: h.skill,
              ...(h.skill_path ? { skill_path: h.skill_path } : {}),
              source: h.source,
              via: h.via,
              tool: 'USER_INPUT',
              session_id: item.sessionId,
              _turnId: turnId,
              _promptText: lastUserPrompt,
              origin: 'backfill',
              ok: obj.status !== 'ERROR',
            });
          });
        }
        continue;
      }

      recordTurnTs(turnId, ts);
      const stepUsage = extractUsageMetrics(obj.usageMetadata ?? obj.usage);
      if (stepUsage) turnUsageMap.set(turnId, stepUsage);

      if (!line.includes('SKILL.md') && !line.includes('truncated_fields')) continue;

      if (Array.isArray(obj.truncated_fields) && obj.truncated_fields.includes('tool_calls')) {
        const fullObj = loadFullRecord(fullCache, item.fullPath, lineIdx, obj.step_index);
        if (fullObj) obj = fullObj;
      }

      const toolCalls = obj.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;

      if (sinceMs !== null && ts) {
        const tsMs = Date.parse(ts);
        if (Number.isFinite(tsMs) && tsMs < sinceMs) continue;
      }

      let stepHitIdx = 0;

      for (const tc of toolCalls) {
        if (!tc || !TARGET_TOOLS.has(tc.name)) continue;
        const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
        const cwdRaw = unwrapArg(args.Cwd);
        const cwd = typeof cwdRaw === 'string' ? cwdRaw : '';
        const hits = detectSkillCalls({
          tool: tc.name,
          args,
          cwd,
          homeDir,
          allowShell: true,
        });
        for (const h of hits) {
          convEvents.push({
            v: 1,
            id: `${item.host}:${item.sessionId}:${stepIdx}#${stepHitIdx++}`,
            ts: ts || new Date(0).toISOString(),
            host: item.host,
            skill: h.skill,
            ...(h.skill_path ? { skill_path: h.skill_path } : {}),
            source: h.source,
            via: h.via,
            tool: tc.name,
            session_id: item.sessionId,
            ...(cwd ? { project: basename(cwd) } : {}),
            _turnId: turnId,
            _usage: stepUsage,
            _promptText: lastUserPrompt,
            origin: 'backfill',
            ok: obj.status !== 'ERROR',
          });
        }
      }
    }

    const readSkillSet = new Set(convEvents.map((e) => e.skill));
    for (const uEv of pendingUserSkills) {
      if (!readSkillSet.has(uEv.skill)) {
        convEvents.push(uEv);
      }
    }

    for (const ev of convEvents) {
      const tid = ev._turnId;
      const usage = ev._usage || turnUsageMap.get(tid) || null;
      const pText = ev._promptText;
      delete ev._turnId;
      delete ev._usage;
      delete ev._promptText;

      const tsMs = ev.ts ? Date.parse(ev.ts) : NaN;
      const endMs = turnEndMsMap.get(tid);
      const durationSeconds =
        Number.isFinite(tsMs) &&
        Number.isFinite(endMs) &&
        endMs >= tsMs &&
        endMs - tsMs <= 86400_000
          ? Math.round((endMs - tsMs) / 1000)
          : 0;
      if (durationSeconds > 0) ev.duration_seconds = durationSeconds;
      if (usage) Object.assign(ev, usage);
      const preview = storePrompts && pText ? sanitizePromptPreview(pText) : '';
      if (preview) ev.prompt_preview = preview;
      events.push(ev);
    }
  }

  return {
    files: transcripts.length,
    events,
  };
}
