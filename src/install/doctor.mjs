import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import zlib from 'node:zlib';
import { getHomeDir } from '../core/config.mjs';
import { readAllEvents } from '../core/store.mjs';
import { detectAntigravity, getAntigravityPluginTarget } from './antigravity.mjs';
import { detectClaude, hasClaudePluginInstalled } from './claude.mjs';
import { checkCodexHookTrust, detectCodex, hasCodexPluginInstalled } from './codex.mjs';
import { detectGemini } from './gemini.mjs';
import { extractHookCommandPath, getPackageRoot, isSkilltallyHandler, readJsonObject } from './runtime.mjs';

function collectSkilltallyHookCommands(hooksJsonObj) {
  const commands = [];
  if (!hooksJsonObj || typeof hooksJsonObj !== 'object') return commands;

  // Antigravity root hooks.json style: { "<name>": { PostToolUse: [...] } }
  for (const val of Object.values(hooksJsonObj)) {
    if (val && typeof val === 'object' && Array.isArray(val.PostToolUse)) {
      for (const group of val.PostToolUse) {
        for (const h of group?.hooks || []) {
          if (typeof h?.command === 'string') commands.push(h.command);
        }
      }
    }
  }

  // Claude / Codex / Gemini style: { hooks: { PostToolUse: [...], AfterTool: [...] } }
  for (const eventName of ['PostToolUse', 'AfterTool']) {
    if (Array.isArray(hooksJsonObj?.hooks?.[eventName])) {
      for (const group of hooksJsonObj.hooks[eventName]) {
        for (const h of group?.hooks || []) {
          if (isSkilltallyHandler(h) && typeof h.command === 'string') {
            commands.push(h.command);
          }
        }
      }
    }
  }

  return commands;
}

function checkCommandPathsExist(commands, baseDir) {
  if (commands.length === 0) return null;
  for (const cmd of commands) {
    const rawPath = extractHookCommandPath(cmd);
    if (!rawPath) return false;
    const resolved = isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
    if (!existsSync(resolved)) return false;
  }
  return true;
}

function runSelfTest(pkgRoot) {
  const trackScript = join(pkgRoot, 'bin', 'track.mjs');
  if (!existsSync(trackScript)) {
    return { ok: false, error: `Missing ${trackScript}` };
  }

  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-doctor-'));
  try {
    const payload = JSON.stringify({
      toolCall: {
        id: 'doctor_self_test',
        name: 'view_file',
        args: { Path: '/Users/tester/.gemini/config/skills/self-test/SKILL.md' },
      },
      conversationId: 'doctor-conv',
      cwd: '/tmp/doctor-check',
    });

    const res = spawnSync(process.execPath, [trackScript, '--host', 'antigravity'], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, SKILLTALLY_HOME: tmp },
    });
    if (res.status !== 0 || res.stdout !== '{}') {
      return { ok: false, error: `Unexpected exit=${res.status}, stdout=${JSON.stringify(res.stdout)}` };
    }

    const evFile = join(tmp, 'events.jsonl');
    if (!existsSync(evFile)) {
      return { ok: false, error: 'Self-test did not write events.jsonl' };
    }
    const ev = JSON.parse(readFileSync(evFile, 'utf8').trim());
    if (ev.skill !== 'self-test' || ev.origin !== 'hook') {
      return { ok: false, error: 'Self-test wrote unexpected event payload' };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function runDoctor({
  homeDir = homedir(),
  dataHome = getHomeDir(),
  pkgRoot = getPackageRoot(),
} = {}) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeOk = Number.isFinite(nodeMajor) && nodeMajor >= 18;
  const zstdNative = typeof zlib.zstdDecompressSync === 'function';

  // Store & events check
  const { events, corruptLines } = readAllEvents(dataHome);
  let hookEvents = 0;
  let backfillEvents = 0;
  let latestTs = null;
  for (const ev of events) {
    if (ev.origin === 'hook') hookEvents += 1;
    else backfillEvents += 1;
    if (ev.ts && (!latestTs || ev.ts > latestTs)) latestTs = ev.ts;
  }

  // Host 1: Antigravity
  const agyDetected = detectAntigravity(homeDir);
  const agyPluginDir = getAntigravityPluginTarget(homeDir);
  let agyPluginExists = false;
  let agyIsSymlink = false;
  try {
    const st = lstatSync(agyPluginDir);
    agyPluginExists = st.isDirectory() || st.isSymbolicLink();
    agyIsSymlink = st.isSymbolicLink();
  } catch {}

  let agyDisabled = false;
  if (agyPluginExists) {
    try {
      const cfg = readJsonObject(join(homeDir, '.gemini', 'config', 'config.json'));
      if (cfg?.plugins?.skilltally?.enabled === false) agyDisabled = true;
    } catch {}
    try {
      const manifest = readJsonObject(join(agyPluginDir, 'plugin.json'));
      if (manifest?.disabled === true && !agyDisabled) {
        const cfg = readJsonObject(join(homeDir, '.gemini', 'config', 'config.json'));
        if (cfg?.plugins?.skilltally?.enabled !== true) agyDisabled = true;
      }
    } catch {}
  }

  let agyPluginCmds = [];
  if (agyPluginExists && existsSync(join(agyPluginDir, 'hooks.json'))) {
    try {
      agyPluginCmds = collectSkilltallyHookCommands(readJsonObject(join(agyPluginDir, 'hooks.json')));
    } catch {}
  }
  let agyGlobalCmds = [];
  const agyGlobalHooksPath = join(homeDir, '.gemini', 'config', 'hooks.json');
  if (existsSync(agyGlobalHooksPath)) {
    try {
      agyGlobalCmds = collectSkilltallyHookCommands(readJsonObject(agyGlobalHooksPath));
    } catch {}
  }

  const agyPluginPathValid = checkCommandPathsExist(agyPluginCmds, agyPluginDir);
  const agyGlobalPathValid = checkCommandPathsExist(agyGlobalCmds, dirname(agyGlobalHooksPath));
  const agyHookPathValid =
    agyPluginPathValid === false || agyGlobalPathValid === false
      ? false
      : agyPluginPathValid === true || agyGlobalPathValid === true
        ? true
        : null;

  const antigravity = {
    detected: agyDetected,
    installed: (agyPluginExists && agyPluginCmds.length > 0) || agyGlobalCmds.length > 0,
    mode: agyPluginExists ? (agyIsSymlink ? 'symlink' : 'plugin') : agyGlobalCmds.length > 0 ? 'global_hooks' : 'none',
    disabled: agyDisabled,
    duplicateHook: agyPluginCmds.length > 0 && agyGlobalCmds.length > 0,
    hookPathValid: agyHookPathValid,
    target: agyPluginExists ? agyPluginDir : agyGlobalHooksPath,
  };

  // Host 2: Claude Code
  const claudeDetected = detectClaude(homeDir);
  const claudePlugin = hasClaudePluginInstalled(homeDir);
  const claudeSettingsPath = join(homeDir, '.claude', 'settings.json');
  let claudeCmds = [];
  if (existsSync(claudeSettingsPath)) {
    try {
      claudeCmds = collectSkilltallyHookCommands(readJsonObject(claudeSettingsPath));
    } catch {}
  }
  const claudeSettingsInstalled = claudeCmds.length > 0;
  const claude = {
    detected: claudeDetected,
    installed: claudePlugin || claudeSettingsInstalled,
    pluginInstalled: claudePlugin,
    settingsInstalled: claudeSettingsInstalled,
    duplicateHook: claudePlugin && claudeSettingsInstalled,
    hookPathValid: checkCommandPathsExist(claudeCmds, dirname(claudeSettingsPath)),
    target: claudeSettingsPath,
  };

  // Host 3: Codex
  const codexDetected = detectCodex(homeDir);
  const codexPlugin = hasCodexPluginInstalled(homeDir);
  const codexHooksPath = join(homeDir, '.codex', 'hooks.json');
  let codexCmds = [];
  if (existsSync(codexHooksPath)) {
    try {
      codexCmds = collectSkilltallyHookCommands(readJsonObject(codexHooksPath));
    } catch {}
  }
  const codexHooksInstalled = codexCmds.length > 0;
  const codex = {
    detected: codexDetected,
    installed: codexPlugin || codexHooksInstalled,
    pluginInstalled: codexPlugin,
    hooksJsonInstalled: codexHooksInstalled,
    duplicateHook: codexPlugin && codexHooksInstalled,
    hookPathValid: checkCommandPathsExist(codexCmds, dirname(codexHooksPath)),
    trustStatus: checkCodexHookTrust(homeDir),
    target: codexHooksPath,
  };

  // Host 4: Gemini CLI
  const geminiDetected = detectGemini(homeDir);
  const geminiSettingsPath = join(homeDir, '.gemini', 'settings.json');
  let geminiCmds = [];
  let geminiHooksDisabled = false;
  if (existsSync(geminiSettingsPath)) {
    try {
      const geminiDoc = readJsonObject(geminiSettingsPath);
      geminiCmds = collectSkilltallyHookCommands(geminiDoc);
      geminiHooksDisabled = geminiDoc?.hooksConfig?.enabled === false;
    } catch {}
  }
  const gemini = {
    detected: geminiDetected,
    installed: geminiCmds.length > 0,
    hookPathValid: checkCommandPathsExist(geminiCmds, dirname(geminiSettingsPath)),
    hooksConfigDisabled: geminiHooksDisabled,
    target: geminiSettingsPath,
  };

  const selfTest = runSelfTest(pkgRoot);
  const hosts = { antigravity, claude, codex, gemini };
  const brokenPaths = Object.values(hosts).some((h) => h.hookPathValid === false);
  const ok = nodeOk && selfTest.ok && !brokenPaths;

  return {
    ok,
    node: { version: process.versions.node, ok: nodeOk, zstdNative },
    dataHome,
    events: {
      total: events.length,
      hook: hookEvents,
      backfill: backfillEvents,
      corruptLines,
      latestTs,
    },
    hosts,
    selfTest,
  };
}
