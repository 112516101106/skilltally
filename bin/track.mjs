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

const PATH_KEYS = ['Path', 'AbsolutePath', 'TargetFile', 'file_path', 'path', 'absolute_path'];
const CMD_KEYS = ['CommandLine', 'command', 'cmd', 'input', 'argv'];
const WRITE_TOOL_RE = /^(write|edit|replace|apply_patch|multiedit|notebookedit|create_file|delete_file)/i;
const READ_CMD_RE = /^(cat|sed|head|tail|less|more|bat|nl|awk|type|Get-Content)\b/i;
const MUTATE_CMD_RE = /(?:^|\s)(?:sed|awk)\s+(?:[^\n]*\s)?(?:-i\S*|--in-place\b)|>{1,2}\s*[^\s]*SKILL\.md/i;
const CODEX_EXEC_CMD_RE = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

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
  if (payload?.hook_event_name === 'AfterTool' || env.GEMINI_PROJECT_DIR) return 'gemini';
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
  return {
    tool: p.tool_name,
    args: p.tool_input ?? {},
    callId: p.tool_use_id ?? p.call_id,
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

export function detectSkillCalls({ tool, args, cwd = '', homeDir = homedir(), allowShell = true }) {
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

  if (WRITE_TOOL_RE.test(tool ?? '')) return [];

  const hits = [];
  const seenPaths = new Set();

  const collectFromText = (text, via) => {
    if (!text.toLowerCase().includes('skill.md')) return;
    SKILL_PATH_RE.lastIndex = 0;
    for (const m of text.matchAll(SKILL_PATH_RE)) {
      const skillPath = m[1];
      const skill = m[2];
      const normKey = skillPath.replace(/\\/g, '/');
      if (seenPaths.has(normKey)) continue;
      seenPaths.add(normKey);
      hits.push({
        skill,
        skill_path: skillPath,
        source: resolveSource(skillPath, cwd, homeDir),
        via,
      });
    }
  };

  for (const key of PATH_KEYS) {
    if (typeof safeArgs[key] === 'string') {
      collectFromText(unwrapArg(safeArgs[key]), 'read');
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
  const hits = detectSkillCalls({ tool: n.tool, args: n.args, cwd: n.cwd });
  if (hits.length === 0) return;

  mkdirSync(home, { recursive: true, mode: 0o700 });
  const storeCwd = readStoreCwdFlag(home);
  const ts = new Date().toISOString();

  const lines = hits.map((h, idx) =>
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

  const eventsPath = join(home, 'events.jsonl');
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
