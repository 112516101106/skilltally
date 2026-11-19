import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { detectSkillCalls } from '../core/detect.mjs';

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

export function backfillClaude({ homeDir = homedir(), since = null } = {}) {
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
    if (!raw || (!raw.includes('"Skill"') && !raw.includes('SKILL.md'))) continue;

    let sessionId = basename(file, '.jsonl');
    let cwd = '';
    const pendingCalls = [];
    const failedIds = new Set();

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
      if (!Array.isArray(content)) continue;

      if (obj.type === 'user') {
        for (const block of content) {
          if (block?.type === 'tool_result' && block.is_error === true && block.tool_use_id) {
            failedIds.add(block.tool_use_id);
          }
        }
        continue;
      }

      if (obj.type !== 'assistant') continue;
      const model = obj.message?.model;

      for (const block of content) {
        if (block?.type !== 'tool_use' || !TARGET_TOOLS.has(block.name)) continue;
        pendingCalls.push({
          idx: pendingCalls.length,
          ts: obj.timestamp,
          tool: block.name,
          callId: block.id,
          input: block.input && typeof block.input === 'object' ? block.input : {},
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
        cwd: call.cwd,
        homeDir,
        allowShell: true,
      });

      const ok = call.callId ? !failedIds.has(call.callId) : true;
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
