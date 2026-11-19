import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function getPackageRoot() {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

export function getRuntimeTrackPath(dataHome) {
  return join(dataHome, 'runtime', 'track.mjs');
}

export function syncRuntime({ pkgRoot = getPackageRoot(), dataHome, dryRun = false }) {
  const src = join(pkgRoot, 'bin', 'track.mjs');
  if (!existsSync(src)) {
    throw new Error(`Missing tracker entry at ${src}`);
  }
  const target = getRuntimeTrackPath(dataHome);
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(src, target);
    chmodSync(target, 0o755);
  }
  return { target, synced: !dryRun };
}

export function backupFile(filePath, dataHome, label, dryRun = false) {
  if (!existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(dataHome, 'backups', `${label}-${stamp}.bak`);
  if (!dryRun) {
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    copyFileSync(filePath, backupPath);
    chmodSync(backupPath, 0o600);
  }
  return backupPath;
}

export function readJsonObject(filePath) {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed;
}

export function writeJsonAtomic(filePath, obj, mode = 0o600) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, filePath);
}

export function isSkilltallyHandler(h) {
  if (!h || typeof h !== 'object') return false;
  if (h.statusMessage === 'skilltally' || h.name === 'skilltally') return true;
  if (
    typeof h.command === 'string' &&
    h.command.includes('skilltally') &&
    (h.command.includes('track.mjs') || h.command.includes('agy-fast-track.sh'))
  ) {
    return true;
  }
  return false;
}

export function extractHookCommandPath(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(/["']([^"']*(?:track\.mjs|agy-fast-track\.sh))["']/) ||
    command.match(/(\S*(?:track\.mjs|agy-fast-track\.sh))/);
  return match ? match[1] : null;
}

function handlersEqual(a, b) {
  return (
    a?.type === b?.type &&
    a?.command === b?.command &&
    Boolean(a?.async) === Boolean(b?.async) &&
    a?.timeout === b?.timeout &&
    a?.statusMessage === b?.statusMessage
  );
}

export function mergePostToolUseHook(
  doc,
  { matcher, command, async = true, timeout = 5, statusMessage = 'skilltally' }
) {
  const nextDoc = structuredClone(doc && typeof doc === 'object' ? doc : {});
  const desired = {
    type: 'command',
    command,
    ...(async ? { async: true } : {}),
    timeout,
    statusMessage,
  };

  if (!nextDoc.hooks || typeof nextDoc.hooks !== 'object' || Array.isArray(nextDoc.hooks)) {
    nextDoc.hooks = {};
  }
  const list = Array.isArray(nextDoc.hooks.PostToolUse) ? nextDoc.hooks.PostToolUse : [];

  let existingCount = 0;
  let exactMatch = false;
  for (const group of list) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (isSkilltallyHandler(h)) {
        existingCount += 1;
        if (group.matcher === matcher && handlersEqual(h, desired)) {
          exactMatch = true;
        }
      }
    }
  }

  if (existingCount === 1 && exactMatch) {
    return { nextDoc, changed: false, action: 'unchanged' };
  }

  const cleaned = [];
  for (const group of list) {
    if (!group || typeof group !== 'object') continue;
    const hooks = Array.isArray(group.hooks) ? group.hooks.filter((h) => !isSkilltallyHandler(h)) : [];
    if (hooks.length > 0) {
      cleaned.push({ ...group, hooks });
    }
  }

  cleaned.push({
    matcher,
    hooks: [desired],
  });
  nextDoc.hooks.PostToolUse = cleaned;

  return {
    nextDoc,
    changed: true,
    action: existingCount > 0 ? 'updated' : 'added',
  };
}

export function removeSkilltallyHooks(doc) {
  const nextDoc = structuredClone(doc && typeof doc === 'object' ? doc : {});
  const list = nextDoc?.hooks?.PostToolUse;
  if (!Array.isArray(list)) {
    return { nextDoc, changed: false, removedCount: 0 };
  }

  let removedCount = 0;
  const cleaned = [];
  for (const group of list) {
    if (!group || typeof group !== 'object') continue;
    const hooks = Array.isArray(group.hooks) ? group.hooks : [];
    const kept = hooks.filter((h) => {
      if (isSkilltallyHandler(h)) {
        removedCount += 1;
        return false;
      }
      return true;
    });
    if (kept.length > 0) {
      cleaned.push({ ...group, hooks: kept });
    }
  }

  if (removedCount === 0) {
    return { nextDoc, changed: false, removedCount: 0 };
  }

  if (cleaned.length > 0) {
    nextDoc.hooks.PostToolUse = cleaned;
  } else {
    delete nextDoc.hooks.PostToolUse;
    if (Object.keys(nextDoc.hooks).length === 0) {
      delete nextDoc.hooks;
    }
  }

  return { nextDoc, changed: true, removedCount };
}
