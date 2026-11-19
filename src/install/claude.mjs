import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getHomeDir } from '../core/config.mjs';
import {
  backupFile,
  getPackageRoot,
  mergePostToolUseHook,
  readJsonObject,
  removeSkilltallyHooks,
  syncRuntime,
  writeJsonAtomic,
} from './runtime.mjs';

export function detectClaude(homeDir = homedir()) {
  return existsSync(join(homeDir, '.claude'));
}

export function hasClaudePluginInstalled(homeDir = homedir()) {
  const pluginsDir = join(homeDir, '.claude', 'plugins');
  if (existsSync(join(pluginsDir, 'skilltally'))) return true;

  const cacheDir = join(pluginsDir, 'cache');
  if (existsSync(cacheDir)) {
    try {
      for (const mkt of readdirSync(cacheDir, { withFileTypes: true })) {
        if (!mkt.isDirectory() && !mkt.isSymbolicLink()) continue;
        if (existsSync(join(cacheDir, mkt.name, 'skilltally'))) return true;
      }
    } catch {}
  }

  const installedFile = join(pluginsDir, 'installed_plugins.json');
  if (existsSync(installedFile)) {
    try {
      const data = JSON.parse(readFileSync(installedFile, 'utf8'));
      const keys = Object.keys(data?.plugins || data || {});
      if (keys.some((k) => k === 'skilltally' || k.startsWith('skilltally@'))) return true;
    } catch {}
  }

  return false;
}

export function installClaude({
  homeDir = homedir(),
  dataHome = getHomeDir(),
  pkgRoot = getPackageRoot(),
  dryRun = false,
  force = false,
} = {}) {
  if (hasClaudePluginInstalled(homeDir) && !force) {
    return {
      host: 'claude',
      status: 'skipped',
      reason: 'Claude plugin already installed (use --force to also add settings hook)',
    };
  }

  const runtime = syncRuntime({ pkgRoot, dataHome, dryRun });
  const command = `node "${runtime.target.replace(/\\/g, '/')}" --host claude`;
  const settingsPath = join(homeDir, '.claude', 'settings.json');
  const doc = readJsonObject(settingsPath);
  const { nextDoc, changed, action } = mergePostToolUseHook(doc, {
    matcher: 'Skill|Read|View|Bash',
    command,
    async: true,
    timeout: 5,
    statusMessage: 'skilltally',
  });

  let backup = null;
  if (changed) {
    backup = backupFile(settingsPath, dataHome, 'claude-settings', dryRun);
    if (!dryRun) {
      writeJsonAtomic(settingsPath, nextDoc, 0o600);
    }
  }

  return {
    host: 'claude',
    status: changed ? (action === 'added' ? 'installed' : 'updated') : 'unchanged',
    target: settingsPath,
    backup,
  };
}

export function uninstallClaude({
  homeDir = homedir(),
  dataHome = getHomeDir(),
  dryRun = false,
} = {}) {
  const settingsPath = join(homeDir, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    return { host: 'claude', status: 'not_installed', target: settingsPath };
  }

  const doc = readJsonObject(settingsPath);
  const { nextDoc, changed, removedCount } = removeSkilltallyHooks(doc);
  if (!changed) {
    return { host: 'claude', status: 'not_installed', target: settingsPath };
  }

  const backup = backupFile(settingsPath, dataHome, 'claude-settings', dryRun);
  if (!dryRun) {
    writeJsonAtomic(settingsPath, nextDoc, 0o600);
  }

  return {
    host: 'claude',
    status: 'uninstalled',
    removedCount,
    target: settingsPath,
    backup,
  };
}
