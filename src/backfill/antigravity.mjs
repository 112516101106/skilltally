import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { detectSkillCalls, unwrapArg } from '../core/detect.mjs';

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

export function backfillAntigravity({ homeDir = homedir(), since = null } = {}) {
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

    const lines = raw.split('\n');
    const fullCache = { lines: undefined };

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      if (!line) continue;
      if (!line.includes('SKILL.md') && !line.includes('truncated_fields')) continue;

      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (Array.isArray(obj.truncated_fields) && obj.truncated_fields.includes('tool_calls')) {
        const fullObj = loadFullRecord(fullCache, item.fullPath, lineIdx, obj.step_index);
        if (fullObj) obj = fullObj;
      }

      const toolCalls = obj.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;

      const ts = obj.created_at;
      if (sinceMs !== null && ts) {
        const tsMs = Date.parse(ts);
        if (Number.isFinite(tsMs) && tsMs < sinceMs) continue;
      }

      const stepIdx = obj.step_index ?? lineIdx;
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
          events.push({
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
            origin: 'backfill',
            ok: obj.status !== 'ERROR',
          });
        }
      }
    }
  }

  return {
    files: transcripts.length,
    events,
  };
}
