import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { getHomeDir } from '../core/config.mjs';
import { detectAntigravity, installAntigravity, uninstallAntigravity } from './antigravity.mjs';
import { detectClaude, installClaude, uninstallClaude } from './claude.mjs';
import { detectCodex, installCodex, uninstallCodex } from './codex.mjs';
import { detectGemini, installGemini, uninstallGemini } from './gemini.mjs';
import { getPackageRoot } from './runtime.mjs';

const HOSTS = {
  antigravity: {
    detect: detectAntigravity,
    install: installAntigravity,
    uninstall: uninstallAntigravity,
  },
  claude: {
    detect: detectClaude,
    install: installClaude,
    uninstall: uninstallClaude,
  },
  codex: {
    detect: detectCodex,
    install: installCodex,
    uninstall: uninstallCodex,
  },
  gemini: {
    detect: detectGemini,
    install: installGemini,
    uninstall: uninstallGemini,
  },
};

export function runInstall({
  homeDir = homedir(),
  dataHome = getHomeDir(),
  pkgRoot = getPackageRoot(),
  host = 'all',
  dryRun = false,
  force = false,
} = {}) {
  const normalizedHost = String(host || 'all').toLowerCase();
  if (normalizedHost !== 'all' && !Object.prototype.hasOwnProperty.call(HOSTS, normalizedHost)) {
    throw new Error(`Unsupported host "${host}" (expected: all, antigravity, claude, codex, gemini)`);
  }

  const targets = normalizedHost === 'all' ? Object.keys(HOSTS) : [normalizedHost];
  const results = [];
  let exitCode = 0;

  for (const h of targets) {
    const adapter = HOSTS[h];
    const detected = adapter.detect(homeDir);
    if (!detected && !force) {
      results.push({
        host: h,
        status: 'not_detected',
        ...(normalizedHost !== 'all'
          ? { reason: `${h} config directory not found (use --force to create it)` }
          : {}),
      });
      if (normalizedHost !== 'all') exitCode = 2;
      continue;
    }

    const res = adapter.install({ homeDir, dataHome, pkgRoot, dryRun, force });
    results.push(res);
  }

  return {
    dryRun,
    exitCode,
    results,
  };
}

export function runUninstall({
  homeDir = homedir(),
  dataHome = getHomeDir(),
  host = 'all',
  purge = false,
  dryRun = false,
} = {}) {
  const normalizedHost = String(host || 'all').toLowerCase();
  if (normalizedHost !== 'all' && !Object.prototype.hasOwnProperty.call(HOSTS, normalizedHost)) {
    throw new Error(`Unsupported host "${host}" (expected: all, antigravity, claude, codex, gemini)`);
  }

  const targets = normalizedHost === 'all' ? Object.keys(HOSTS) : [normalizedHost];
  const results = [];

  for (const h of targets) {
    results.push(HOSTS[h].uninstall({ homeDir, dataHome, dryRun }));
  }

  let purged = false;
  if (purge && existsSync(dataHome)) {
    if (!dryRun) {
      rmSync(dataHome, { recursive: true, force: true });
    }
    purged = true;
  }

  return {
    dryRun,
    purgeRequested: Boolean(purge),
    purged,
    dataHome,
    results,
  };
}
