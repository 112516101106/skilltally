#!/usr/bin/env node
// skilltally standalone hook entry & shared detection primitives.
// Contract when executed directly: NEVER throw, ALWAYS exit 0, ALWAYS print "{}".
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SKILL_PATH_RE =
  /((?:[A-Za-z]:|~)?[^\s"'`<>|;(){}\[\]]*?[\\/]skills[\\/]([A-Za-z0-9][A-Za-z0-9._-]{0,127})[\\/]SKILL\.md)(?=$|[\s"'`<>|;),}\]])/gi;
const EXPLICIT_SKILL_LINK_RE =
  /\[[\$@\/]?([A-Za-z0-9][A-Za-z0-9._-]{0,127})\]\(([^()\s]*?[\\/]skills[\\/][A-Za-z0-9][A-Za-z0-9._-]{0,127}[\\/]SKILL\.md)\)/gi;
const CODEX_SKILL_TAG_RE =
  /<skill>\s*<name>([^<\r\n]+)<\/name>\s*<path>([^<\r\n]*?[\\/]SKILL\.md)<\/path>/gi;
const AGY_SKILL_TAG_RE =
  /<SKILL>[\s\S]*?read and use the "([^"]+)" skill\.\s*The path to the skill file is:\s*([^\s<]+?[\\/]SKILL\.md)\s*<\/SKILL>/gi;
const CLAUDE_SKILL_BASEDIR_RE =
  /Base directory for this skill:\s*([^\r\n<]+?[\\/]skills[\\/]([A-Za-z0-9][A-Za-z0-9._-]{0,127}))\/?(?=\r?\n|$|<)/gi;

const PATH_KEYS = ['Path', 'AbsolutePath', 'TargetFile', 'file_path', 'path', 'absolute_path'];
const ARRAY_PATH_KEYS = ['paths', 'include', 'files'];
const LINE_START_KEYS = ['StartLine', 'start_line', 'offset'];
const BYTE_OFFSET_KEYS = ['ByteOffset', 'byte_offset'];
const CMD_KEYS = ['CommandLine', 'command', 'cmd', 'input', 'argv'];
const WRITE_TOOL_RE = /^(write|edit|replace|apply_patch|multiedit|notebookedit|create_file|delete_file)/i;
const READ_CMD_RE = /^(cat|sed|head|tail|less|more|bat|nl|awk|type|Get-Content)\b/i;
const MUTATE_CMD_RE = /(?:^|\s)(?:sed|awk)\s+(?:[^\n]*\s)?(?:-i\S*|--in-place\b)|>{1,2}\s*[^\s]*SKILL\.md/i;
const CODEX_EXEC_CMD_RE = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
const DEDUPE_WINDOW_MS = 30_000;

function isContinuationReadArgs(safeArgs) {
  for (const key of LINE_START_KEYS) {
    const raw = safeArgs[key];
    if (raw === undefined || raw === null) continue;
    const unwrapped = unwrapArg(raw);
    if (typeof unwrapped === 'string' && unwrapped.trim() === '') continue;
    const n = Number(unwrapped);
    if (Number.isFinite(n) && n > 1) return true;
  }
  for (const key of BYTE_OFFSET_KEYS) {
    const raw = safeArgs[key];
    if (raw === undefined || raw === null) continue;
    const unwrapped = unwrapArg(raw);
    if (typeof unwrapped === 'string' && unwrapped.trim() === '') continue;
    const n = Number(unwrapped);
    if (Number.isFinite(n) && n > 0) return true;
  }
  return false;
}

function isContinuationShellSegment(seg) {
  const mSed = seg.match(/\bsed\b[^;&\n]*?(?:^|[\s'"=])(\d+)(?:\s*,\s*(?:\d+|\$|\+\d+))?p(?=['"\s;|&]|$)/i);
  if (mSed && Number(mSed[1]) > 1) return true;

  if (
    (/^tail\b/i.test(seg) || /\|\s*tail\b/i.test(seg)) &&
    !/\btail\s+(?:-[^\s]+\s+)*-n\s*\+?[01]\b/i.test(seg)
  ) {
    return true;
  }

  const mAwkGe = seg.match(/\bawk\b[^;&\n]*?\bNR\s*>=\s*(\d+)/i);
  if (mAwkGe && Number(mAwkGe[1]) > 1) return true;

  const mAwkGt = seg.match(/\bawk\b[^;&\n]*?\bNR\s*>\s*(\d+)/i);
  if (mAwkGt && Number(mAwkGt[1]) >= 1) return true;

  return false;
}

function argValue(flag, argv = process.argv) {
  const i = argv.indexOf(flag);
  return i > 0 ? argv[i + 1] : undefined;
}

export function unwrapArg(val) {
  if (typeof val !== 'string') return val;
  if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return val.slice(1, -1);
    }
  }
  return val;
}

function refineAntigravityHost(payload) {
  const tp = String(payload?.transcriptPath ?? payload?.artifactDirectoryPath ?? '');
  if (/[\\/]antigravity-ide[\\/]/i.test(tp)) return 'antigravity-ide';
  if (/[\\/]antigravity-cli[\\/]/i.test(tp)) return 'antigravity-cli';
  return 'antigravity';
}

export function resolveHost(hostFlag, payload, env = process.env) {
  if (hostFlag && hostFlag !== 'auto') {
    if (hostFlag === 'antigravity') return refineAntigravityHost(payload);
    return hostFlag;
  }
  if (payload?.toolCall) return refineAntigravityHost(payload);
  if (
    payload?.hook_event_name === 'AfterTool' ||
    payload?.hook_event_name === 'BeforeAgent' ||
    env.GEMINI_PROJECT_DIR
  ) {
    return 'gemini';
  }
  const tp = String(payload?.transcript_path ?? '');
  if (
    env.CODEX_THREAD_ID ||
    tp.includes('/.codex/') ||
    tp.includes('\\.codex\\') ||
    (env.PLUGIN_DATA && !env.CLAUDE_PLUGIN_ROOT)
  ) {
    return 'codex';
  }
  if (env.CLAUDE_PLUGIN_ROOT || tp.includes('/.claude/') || tp.includes('\\.claude\\')) {
    return 'claude';
  }
  return 'unknown';
}

export function normalizeHookPayload(host, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (String(host).startsWith('antigravity') || p.toolCall) {
    const cwd = p.cwd ?? (Array.isArray(p.workspacePaths) ? p.workspacePaths[0] : undefined);
    return {
      tool: p.toolCall?.name,
      args: p.toolCall?.args ?? {},
      callId: p.toolCall?.id,
      sessionId: p.conversationId,
      cwd,
      model: p.modelName,
      failed: Boolean(p.error),
    };
  }
  const resp = p.tool_response;
  const failed =
    Boolean(p.error) ||
    resp?.is_error === true ||
    (typeof resp?.exit_code === 'number' && resp.exit_code !== 0);
  const prompt =
    typeof p.prompt === 'string'
      ? p.prompt
      : typeof p.user_prompt === 'string'
        ? p.user_prompt
        : typeof p.userMessage === 'string'
          ? p.userMessage
          : undefined;
  const hookEvent = p.hook_event_name ?? p.hookEventName;
  return {
    tool:
      p.tool_name ??
      (hookEvent === 'UserPromptSubmit' || hookEvent === 'BeforeAgent' ? hookEvent : undefined),
    args: p.tool_input ?? {},
    ...(prompt !== undefined ? { prompt } : {}),
    callId: p.tool_use_id ?? p.call_id ?? p.turn_id ?? p.prompt_id,
    sessionId: p.session_id,
    cwd: p.cwd,
    model: p.model,
    failed,
  };
}

export function resolveSource(skillPath, cwd = '', homeDir = homedir()) {
  if (!skillPath) return 'unknown';
  const normHome = String(homeDir).replace(/\\/g, '/').replace(/\/+$/, '');
  const normCwd = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  let p = String(skillPath).replace(/\\/g, '/');
  if (p.startsWith('~/')) p = `${normHome}${p.slice(1)}`;

  const cacheMatch = p.match(/\/plugins\/cache\/[^/]+\/([^/]+)\//);
  if (cacheMatch) return `plugin:${cacheMatch[1]}`;

  const pluginMatch = p.match(/\/plugins\/([^/]+)\//);
  if (pluginMatch) return `plugin:${pluginMatch[1]}`;

  if (/\/builtin\/skills\//.test(p)) return 'builtin';

  const personalRoots = [
    `${normHome}/.gemini/config/skills/`,
    `${normHome}/.gemini/skills/`,
    `${normHome}/.agents/skills/`,
    `${normHome}/.codex/skills/`,
    `${normHome}/.claude/skills/`,
  ];
  if (personalRoots.some((root) => p.startsWith(root))) return 'personal';

  if (
    (normCwd && p.startsWith(`${normCwd}/`)) ||
    /\/(?:\.agents|\.agent|\.claude|\.gemini)\/skills\//.test(p)
  ) {
    return 'project';
  }

  return 'unknown';
}

function extractCodexCommandStrings(text) {
  const extracted = [];
  for (const m of text.matchAll(CODEX_EXEC_CMD_RE)) {
    const lit = m[1];
    if (lit[0] === '"') {
      try {
        extracted.push(JSON.parse(lit));
      } catch {
        extracted.push(lit.slice(1, -1));
      }
    } else {
      extracted.push(lit.slice(1, -1).replace(/\\(['\\])/g, '$1'));
    }
  }
  return extracted.length > 0 ? extracted : [text];
}

export function detectSkillCalls({
  tool,
  args,
  prompt,
  cwd = '',
  homeDir = homedir(),
  allowShell = true,
}) {
  const safeArgs = args && typeof args === 'object' ? args : {};

  if (tool === 'Skill' && safeArgs.skill) {
    const rawSkill = String(safeArgs.skill).trim();
    if (!rawSkill) return [];
    const colon = rawSkill.indexOf(':');
    if (colon > 0 && colon < rawSkill.length - 1) {
      const ns = rawSkill.slice(0, colon).trim();
      const name = rawSkill.slice(colon + 1).trim();
      if (SKILL_NAME_RE.test(name)) {
        return [{ skill: name, raw_skill: rawSkill, source: `plugin:${ns}`, via: 'skill_tool' }];
      }
    }
    return [{ skill: rawSkill, via: 'skill_tool' }];
  }

  if (tool === 'activate_skill') {
    const raw = safeArgs.name ?? safeArgs.skill;
    if (raw) {
      const name = String(raw).trim();
      if (name) return [{ skill: name, via: 'activate_skill' }];
    }
  }

  const hits = [];
  const seenPaths = new Set();

  const pushPathHit = (skill, skillPath, via) => {
    const cleanSkill = String(skill || '').trim();
    const cleanPath = String(skillPath || '').trim();
    if (!cleanSkill || !cleanPath) return;
    const normKey = cleanPath.replace(/\\/g, '/');
    if (seenPaths.has(normKey)) return;
    seenPaths.add(normKey);
    hits.push({
      skill: cleanSkill,
      skill_path: cleanPath,
      source: resolveSource(cleanPath, cwd, homeDir),
      via,
    });
  };

  if (typeof prompt === 'string' && prompt.trim()) {
    CODEX_SKILL_TAG_RE.lastIndex = 0;
    for (const m of prompt.matchAll(CODEX_SKILL_TAG_RE)) {
      pushPathHit(m[1], m[2], 'mention');
    }
    EXPLICIT_SKILL_LINK_RE.lastIndex = 0;
    for (const m of prompt.matchAll(EXPLICIT_SKILL_LINK_RE)) {
      pushPathHit(m[1], m[2], 'mention');
    }
    AGY_SKILL_TAG_RE.lastIndex = 0;
    for (const m of prompt.matchAll(AGY_SKILL_TAG_RE)) {
      pushPathHit(m[1], m[2], 'slash_command');
    }
    CLAUDE_SKILL_BASEDIR_RE.lastIndex = 0;
    for (const m of prompt.matchAll(CLAUDE_SKILL_BASEDIR_RE)) {
      const baseDir = m[1].trim().replace(/[\\/]+$/, '');
      pushPathHit(m[2], `${baseDir}/SKILL.md`, 'slash_command');
    }
    if (hits.length > 0 && (!tool || tool === 'UserPromptSubmit' || tool === 'BeforeAgent' || tool === 'USER_INPUT')) {
      return hits;
    }
  }

  if (WRITE_TOOL_RE.test(tool ?? '')) return hits;

  const collectFromText = (text, via) => {
    if (!text.toLowerCase().includes('skill.md')) return;
    SKILL_PATH_RE.lastIndex = 0;
    for (const m of text.matchAll(SKILL_PATH_RE)) {
      pushPathHit(m[2], m[1], via);
    }
  };

  if (isContinuationReadArgs(safeArgs)) return [];

  for (const key of PATH_KEYS) {
    if (typeof safeArgs[key] === 'string') {
      collectFromText(unwrapArg(safeArgs[key]), 'read');
    }
  }
  for (const key of ARRAY_PATH_KEYS) {
    if (Array.isArray(safeArgs[key])) {
      for (const item of safeArgs[key]) {
        if (typeof item === 'string' && !item.includes('*')) {
          collectFromText(unwrapArg(item), 'read');
        }
      }
    }
  }
  if (hits.length > 0) return hits;

  if (!allowShell) return [];

  const shellInputs = [];
  if (typeof args === 'string') shellInputs.push(args);
  for (const key of CMD_KEYS) {
    const val = safeArgs[key];
    if (Array.isArray(val)) shellInputs.push(val.map(String).join(' '));
    else if (typeof val === 'string') shellInputs.push(val);
  }

  for (const rawVal of shellInputs) {
    const text = unwrapArg(rawVal);
    if (!text.toLowerCase().includes('skill.md')) continue;
    const candidates = extractCodexCommandStrings(text);
    for (const cand of candidates) {
      for (const rawSeg of cand.split(/&&|\|\||;|\n/)) {
        if (!rawSeg.toLowerCase().includes('skill.md')) continue;
        const seg = rawSeg.trim().replace(/^(?:[A-Za-z_]\w*=\S+\s+)+/, '');
        if (!READ_CMD_RE.test(seg)) continue;
        if (MUTATE_CMD_RE.test(seg)) continue;
        if (isContinuationShellSegment(seg)) continue;
        collectFromText(seg, 'shell_read');
      }
    }
  }

  return hits;
}

function readStoreCwdFlag(home) {
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    return cfg?.store_cwd === true;
  } catch {
    return false;
  }
}

function maybeRotateEvents(home, eventsPath) {
  const maxBytes = Number(process.env.SKILLTALLY_ROTATE_BYTES) || 20 * 1024 * 1024;
  if (!existsSync(eventsPath)) return;
  try {
    if (statSync(eventsPath).size < maxBytes) return;
    const month = new Date().toISOString().slice(0, 7);
    let archivePath = join(home, `events-${month}.jsonl`);
    let suffix = 1;
    while (existsSync(archivePath)) {
      archivePath = join(home, `events-${month}-${suffix}.jsonl`);
      suffix += 1;
    }
    renameSync(eventsPath, archivePath);
  } catch {}
}

function readRecentSessionSkills(eventsPath, host, sessionId, nowMs) {
  const recent = new Set();
  if (!sessionId || !existsSync(eventsPath)) return recent;
  try {
    const raw = readFileSync(eventsPath, 'utf8');
    const lines = raw.trim().split('\n');
    const tail = lines.slice(-64);
    for (const line of tail) {
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.ok === false || ev.host !== host || ev.session_id !== sessionId || !ev.skill) {
        continue;
      }
      const evMs = Date.parse(ev.ts);
      if (Number.isFinite(evMs) && Math.abs(nowMs - evMs) <= DEDUPE_WINDOW_MS) {
        recent.add(ev.skill);
      }
    }
  } catch {}
  return recent;
}

export function main() {
  const hostFlag = argValue('--host') ?? 'auto';
  const raw = readFileSync(0, 'utf8');
  const home = process.env.SKILLTALLY_HOME || join(homedir(), '.skilltally');
  const debugOn = process.env.SKILLTALLY_DEBUG === '1' || existsSync(join(home, '.debug'));

  if (debugOn) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(home, 'debug.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), host: hostFlag, raw }) + '\n',
      { mode: 0o600 }
    );
  }

  if (!raw || !raw.trim()) return;
  const payload = JSON.parse(raw);
  const host = resolveHost(hostFlag, payload);
  const n = normalizeHookPayload(host, payload);
  const hits = detectSkillCalls({ tool: n.tool, args: n.args, prompt: n.prompt, cwd: n.cwd });
  if (hits.length === 0) return;

  const eventsPath = join(home, 'events.jsonl');
  const ts = new Date().toISOString();
  const nowMs = Date.parse(ts);
  const recentSkills = !n.failed ? readRecentSessionSkills(eventsPath, host, n.sessionId, nowMs) : new Set();
  const seenBatch = new Set();
  const uniqueHits = [];
  for (const h of hits) {
    if (n.sessionId && (recentSkills.has(h.skill) || seenBatch.has(h.skill))) continue;
    seenBatch.add(h.skill);
    uniqueHits.push(h);
  }
  if (uniqueHits.length === 0) return;

  mkdirSync(home, { recursive: true, mode: 0o700 });
  const storeCwd = readStoreCwdFlag(home);

  const lines = uniqueHits.map((h, idx) =>
    JSON.stringify({
      v: 1,
      id: `${host}:${n.sessionId ?? '-'}:${n.callId ?? ts}#${idx}`,
      ts,
      host,
      skill: h.skill,
      ...(h.raw_skill && h.raw_skill !== h.skill ? { raw_skill: h.raw_skill } : {}),
      ...(h.skill_path ? { skill_path: h.skill_path } : {}),
      source: h.source ?? resolveSource(h.skill_path, n.cwd),
      via: h.via,
      ...(n.tool ? { tool: n.tool } : {}),
      ...(n.sessionId ? { session_id: n.sessionId } : {}),
      ...(n.cwd ? { project: basename(n.cwd) } : {}),
      ...(storeCwd && n.cwd ? { cwd: n.cwd } : {}),
      ...(n.model ? { model: n.model } : {}),
      origin: 'hook',
      ok: !n.failed,
    })
  );

  maybeRotateEvents(home, eventsPath);
  appendFileSync(eventsPath, lines.join('\n') + '\n', { mode: 0o600 });
}

let isMain = false;
try {
  if (process.argv[1]) {
    isMain = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  }
} catch {}

if (isMain) {
  try {
    main();
  } catch {
    // Swallow all errors: tracking must never break the agent loop.
  }
  process.stdout.write('{}');
  process.exit(0);
}
