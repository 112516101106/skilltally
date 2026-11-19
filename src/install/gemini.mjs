import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getHomeDir } from '../core/config.mjs';
import {
  backupFile,
  getPackageRoot,
  mergeEventHook,
  readJsonObject,
  removeSkilltallyHooksForEvent,
  syncRuntime,
  writeJsonAtomic,
} from './runtime.mjs';

export function detectGemini(homeDir = homedir()) {
  return (
    existsSync(join(homeDir, '.gemini', 'settings.json')) ||
    existsSync(join(homeDir, '.gemini', 'skills')) ||
    existsSync(join(homeDir, '.gemini', 'extensions'))
  );
}

export function installGemini({
  homeDir = homedir(),
  dataHome = getHomeDir(),
  pkgRoot = getPackageRoot(),
  dryRun = false,
} = {}) {
  const runtime = syncRuntime({ pkgRoot, dataHome, dryRun });
  const command = `node "${runtime.target.replace(/\\/g, '/')}" --host gemini`;
  const settingsPath = join(homeDir, '.gemini', 'settings.json');
  const doc = readJsonObject(settingsPath);

  const { nextDoc, changed, action } = mergeEventHook(doc, 'AfterTool', {
    matcher: 'activate_skill|read_file|view_file|read_many_files|run_shell_command',
    handler: {
      name: 'skilltally',
      type: 'command',
      command,
      description: 'Track skill activations locally',
      timeout: 5000,
    },
  });

  let backup = null;
  if (changed) {
    backup = backupFile(settingsPath, dataHome, 'gemini-settings', dryRun);
    if (!dryRun) {
      writeJsonAtomic(settingsPath, nextDoc, 0o600);
    }
  }

  const hooksDisabled = doc?.hooksConfig?.enabled === false;
  return {
    host: 'gemini',
    status: changed ? (action === 'added' ? 'installed' : 'updated') : 'unchanged',
    target: settingsPath,
    backup,
    ...(hooksDisabled
      ? { note: 'hooksConfig.enabled is false in ~/.gemini/settings.json; enable hooks to record events.' }
      : {}),
  };
}

export function uninstallGemini({
  homeDir = homedir(),
  dataHome = getHomeDir(),
  dryRun = false,
} = {}) {
  const settingsPath = join(homeDir, '.gemini', 'settings.json');
  if (!existsSync(settingsPath)) {
    return { host: 'gemini', status: 'not_installed', target: settingsPath };
  }

  const doc = readJsonObject(settingsPath);
  const { nextDoc, changed, removedCount } = removeSkilltallyHooksForEvent(doc, 'AfterTool');
  if (!changed) {
    return { host: 'gemini', status: 'not_installed', target: settingsPath };
  }

  const backup = backupFile(settingsPath, dataHome, 'gemini-settings', dryRun);
  if (!dryRun) {
    writeJsonAtomic(settingsPath, nextDoc, 0o600);
  }

  return {
    host: 'gemini',
    status: 'uninstalled',
    removedCount,
    target: settingsPath,
    backup,
  };
}
