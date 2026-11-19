import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getHomeDir } from '../core/config.mjs';
import {
  backupFile,
  getPackageRoot,
  isSkilltallyHandler,
  mergePostToolUseHook,
  readJsonObject,
  removeSkilltallyHooks,
  syncRuntime,
  writeJsonAtomic,
} from './runtime.mjs';

export function detectCodex(homeDir = homedir()) {
  return existsSync(join(homeDir, '.codex'));
}

function readCodexToml(homeDir) {
  const tomlPath = join(homeDir, '.codex', 'config.toml');
  if (!existsSync(tomlPath)) return '';
  try {
    return readFileSync(tomlPath, 'utf8');
  } catch {
    return '';
  }
}

export function hasCodexPluginInstalled(homeDir = homedir()) {
  const cacheDir = join(homeDir, '.codex', 'plugins', 'cache');
  if (existsSync(cacheDir)) {
    try {
      for (const mkt of readdirSync(cacheDir, { withFileTypes: true })) {
        if (!mkt.isDirectory() && !mkt.isSymbolicLink()) continue;
        if (existsSync(join(cacheDir, mkt.name, 'skilltally'))) return true;
      }
    } catch {}
  }

  const raw = readCodexToml(homeDir);
  if (raw) {
    let inSkilltally = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.replace(/#.*$/, '').trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('[')) {
        inSkilltally = /^\[plugins\.(?:"skilltally@[^"]+"|'skilltally@[^']+'|skilltally)\]$/.test(trimmed);
        continue;
      }
      if (inSkilltally && /^enabled\s*=\s*true\b/.test(trimmed)) return true;
    }
  }

  return false;
}

export function checkCodexHookTrust(homeDir = homedir()) {
  const raw = readCodexToml(homeDir);
  const hooksPath = join(homeDir, '.codex', 'hooks.json');
  let hasUserHook = false;
  try {
    const doc = readJsonObject(hooksPath);
    for (const g of doc?.hooks?.PostToolUse || []) {
      if (Array.isArray(g?.hooks) && g.hooks.some(isSkilltallyHandler)) {
        hasUserHook = true;
        break;
      }
    }
  } catch {}

  if (!raw) return hasUserHook ? 'untrusted' : 'unknown';

  let inRelevantState = false;
  let sawSection = false;
  let sawTrustedHash = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[')) {
      if (/^\[hooks\.state\./.test(trimmed) && (trimmed.includes('skilltally') || trimmed.includes('hooks.json:post_tool_use'))) {
        inRelevantState = true;
        sawSection = true;
      } else {
        inRelevantState = false;
      }
      continue;
    }
    if (inRelevantState && /^trusted_hash\s*=/.test(trimmed)) {
      sawTrustedHash = true;
    }
  }

  if (sawSection) return sawTrustedHash ? 'trusted' : 'untrusted';
  return hasUserHook ? 'untrusted' : 'unknown';
}

export function installCodex({
  homeDir = homedir(),
  dataHome = getHomeDir(),
  pkgRoot = getPackageRoot(),
  dryRun = false,
  force = false,
} = {}) {
  if (hasCodexPluginInstalled(homeDir) && !force) {
    return {
      host: 'codex',
      status: 'skipped',
      reason: 'Codex plugin already installed (use --force to also add hooks.json entry)',
    };
  }

  const runtime = syncRuntime({ pkgRoot, dataHome, dryRun });
  const command = `node "${runtime.target.replace(/\\/g, '/')}" --host codex`;
  const hooksPath = join(homeDir, '.codex', 'hooks.json');
  const doc = readJsonObject(hooksPath);
  const { nextDoc, changed, action } = mergePostToolUseHook(doc, {
    matcher: 'exec|exec_command|shell|shell_command|local_shell|Bash',
    command,
    async: true,
    timeout: 5,
    statusMessage: 'skilltally',
  });

  let backup = null;
  if (changed) {
    backup = backupFile(hooksPath, dataHome, 'codex-hooks', dryRun);
    if (!dryRun) {
      writeJsonAtomic(hooksPath, nextDoc, 0o600);
    }
  }

  return {
    host: 'codex',
    status: changed ? (action === 'added' ? 'installed' : 'updated') : 'unchanged',
    target: hooksPath,
    backup,
    note: 'Run codex and open /hooks to review and trust the skilltally PostToolUse hook.',
  };
}

export function uninstallCodex({
  homeDir = homedir(),
  dataHome = getHomeDir(),
  dryRun = false,
} = {}) {
  const hooksPath = join(homeDir, '.codex', 'hooks.json');
  if (!existsSync(hooksPath)) {
    return { host: 'codex', status: 'not_installed', target: hooksPath };
  }

  const doc = readJsonObject(hooksPath);
  const { nextDoc, changed, removedCount } = removeSkilltallyHooks(doc);
  if (!changed) {
    return { host: 'codex', status: 'not_installed', target: hooksPath };
  }

  const backup = backupFile(hooksPath, dataHome, 'codex-hooks', dryRun);
  if (!dryRun) {
    writeJsonAtomic(hooksPath, nextDoc, 0o600);
  }

  return {
    host: 'codex',
    status: 'uninstalled',
    removedCount,
    target: hooksPath,
    backup,
  };
}
