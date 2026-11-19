import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { detectSkillCalls } from '../core/detect.mjs';

const TARGET_TOOLS = new Set([
  'activate_skill',
  'read_file',
  'view_file',
  'read_many_files',
  'run_shell_command',
]);

function findGeminiChatFiles(homeDir) {
  const tmpRoot = join(homeDir, '.gemini', 'tmp');
  if (!existsSync(tmpRoot)) return [];
  const files = [];
  let projDirs;
  try {
    projDirs = readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const proj of projDirs) {
    if (!proj.isDirectory() && !proj.isSymbolicLink()) continue;
    const chatsDir = join(tmpRoot, proj.name, 'chats');
    if (!existsSync(chatsDir)) continue;
    let chatEntries;
    try {
      chatEntries = readdirSync(chatsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of chatEntries) {
      if (f.isFile() && (f.name.endsWith('.json') || f.name.endsWith('.jsonl'))) {
        files.push(join(chatsDir, f.name));
      }
    }
  }
  return files.sort();
}

function parseChatFile(filePath, raw) {
  if (filePath.endsWith('.jsonl')) {
    const messages = [];
    let sessionId = basename(filePath, '.jsonl');
    let startTime = null;
    let cwd = '';
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.sessionId) sessionId = obj.sessionId;
        if (!startTime && obj.timestamp) startTime = obj.timestamp;
        if (!cwd && obj.cwd) cwd = obj.cwd;
        messages.push(obj);
      } catch {}
    }
    return { sessionId, startTime, cwd, messages };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { sessionId: basename(filePath, '.json'), startTime: null, cwd: '', messages: [] };
  }

  if (Array.isArray(parsed)) {
    return {
      sessionId: basename(filePath, '.json'),
      startTime: parsed[0]?.timestamp || null,
      cwd: '',
      messages: parsed,
    };
  }

  return {
    sessionId: parsed?.sessionId || basename(filePath, '.json'),
    startTime: parsed?.startTime || null,
    cwd: parsed?.cwd || '',
    messages: Array.isArray(parsed?.messages) ? parsed.messages : [],
  };
}

export function backfillGemini({ homeDir = homedir(), since = null } = {}) {
  const files = findGeminiChatFiles(homeDir);
  const sinceMs = since instanceof Date ? since.getTime() : since ? Date.parse(since) : null;
  const events = [];

  for (const file of files) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!raw || (!raw.includes('"activate_skill"') && !raw.includes('SKILL.md'))) continue;

    const { sessionId, startTime, cwd: fileCwd, messages } = parseChatFile(file, raw);
    let callIdx = 0;

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const toolCalls = Array.isArray(msg.toolCalls)
        ? msg.toolCalls
        : Array.isArray(msg.tool_calls)
          ? msg.tool_calls
          : [];
      if (toolCalls.length === 0) continue;

      const msgCwd = msg.cwd || fileCwd || '';
      for (const tc of toolCalls) {
        if (!tc || !TARGET_TOOLS.has(tc.name)) continue;
        const idx = callIdx++;
        const ts = tc.timestamp || msg.timestamp || startTime;
        if (sinceMs !== null && ts) {
          const tsMs = Date.parse(ts);
          if (Number.isFinite(tsMs) && tsMs < sinceMs) continue;
        }

        const args = tc.args ?? tc.input ?? {};
        const hits = detectSkillCalls({
          tool: tc.name,
          args: typeof args === 'object' && args !== null ? args : {},
          cwd: msgCwd,
          homeDir,
          allowShell: true,
        });

        const ok = tc.status !== 'error' && tc.status !== 'cancelled';
        hits.forEach((h, hitIdx) => {
          events.push({
            v: 1,
            id: `gemini:${sessionId}:${tc.id || idx}#${hitIdx}`,
            ts: ts || new Date(0).toISOString(),
            host: 'gemini',
            skill: h.skill,
            ...(h.skill_path ? { skill_path: h.skill_path } : {}),
            source: h.source || 'unknown',
            via: h.via,
            tool: tc.name,
            session_id: sessionId,
            ...(msgCwd ? { project: basename(msgCwd) } : {}),
            ...(msg.model ? { model: msg.model } : {}),
            origin: 'backfill',
            ok,
          });
        });
      }
    }
  }

  return {
    files: files.length,
    events,
  };
}
