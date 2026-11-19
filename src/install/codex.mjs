import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getHomeDir } from '../core/config.mjs';
import {
  backupFile,
  getPackageRoot,
  isSkilltallyHandler,
  mergePostToolUseHook,
  mergeUserPromptSubmitHook,
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
  const hooksPath = join(homeDir, '.codex', 'hooks.json');
  const requiredHooks = [];
  try {
    const doc = readJsonObject(hooksPath);
    for (const [eventName, snakeName] of [
      ['PostToolUse', 'post_tool_use'],
      ['UserPromptSubmit', 'user_prompt_submit'],
    ]) {
      const groups = doc?.hooks?.[eventName] || [];
      for (let gi = 0; gi < groups.length; gi++) {
        const handlers = groups[gi]?.hooks;
        if (!Array.isArray(handlers)) continue;
        let foundInEvent = false;
        for (let hi = 0; hi < handlers.length; hi++) {
          if (isSkilltallyHandler(handlers[hi])) {
            requiredHooks.push({
              snakeName,
              groupIdx: gi,
              handlerIdx: hi,
              exactKey: `hooks.json:${snakeName}:${gi}:${hi}`,
              legacyRe: new RegExp(`:hooks\\.json:${snakeName}(?:"|'|])`),
            });
            foundInEvent = true;
            break;
          }
        }
        if (foundInEvent) break;
      }
    }
  } catch {}

  const hasPlugin = hasCodexPluginInstalled(homeDir);
  if (requiredHooks.length === 0 && !hasPlugin) return 'unknown';

  const raw = readCodexToml(homeDir);
  if (!raw) return requiredHooks.length > 0 ? 'untrusted' : 'unknown';

  const stateSections = [];
  let currentSection = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[')) {
      if (/^\[hooks\.state\./.test(trimmed)) {
        currentSection = { header: trimmed, hasTrustedHash: false };
        stateSections.push(currentSection);
      } else {
        currentSection = null;
      }
      continue;
    }
    if (currentSection && /^trusted_hash\s*=/.test(trimmed)) {
      currentSection.hasTrustedHash = true;
    }
  }

  if (requiredHooks.length > 0) {
    for (const req of requiredHooks) {
      const matching = stateSections.filter(
        (s) =>
          s.header.includes('skilltally') ||
          s.header.includes(req.exactKey) ||
          req.legacyRe.test(s.header)
      );
      if (!matching.some((s) => s.hasTrustedHash)) return 'untrusted';
    }
    return 'trusted';
  }

  const pluginSections = stateSections.filter((s) => s.header.includes('skilltally'));
  if (pluginSections.length > 0) {
    return pluginSections.some((s) => s.hasTrustedHash) ? 'trusted' : 'untrusted';
  }
  return 'unknown';
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
  const postRes = mergePostToolUseHook(doc, {
    matcher: 'exec|exec_command|shell|shell_command|local_shell|Bash',
    command,
    async: true,
    timeout: 5,
    statusMessage: 'skilltally',
  });
  const promptRes = mergeUserPromptSubmitHook(postRes.nextDoc, {
    command,
    async: true,
    timeout: 5,
    statusMessage: 'skilltally',
  });
  const nextDoc = promptRes.nextDoc;
  const changed = postRes.changed || promptRes.changed;
  const action = postRes.action === 'added' && promptRes.action === 'added' ? 'added' : 'updated';

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
    note: 'Run codex and open /hooks to review and trust the skilltally hooks.',
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
