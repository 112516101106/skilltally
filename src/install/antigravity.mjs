import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getPackageRoot, writeJsonAtomic } from './runtime.mjs';

export function detectAntigravity(homeDir = homedir()) {
  return (
    existsSync(join(homeDir, '.gemini', 'config')) ||
    existsSync(join(homeDir, '.gemini', 'antigravity'))
  );
}

export function getAntigravityPluginTarget(homeDir = homedir()) {
  return join(homeDir, '.gemini', 'config', 'plugins', 'skilltally');
}

function buildAntigravityHooksJson() {
  const cmd =
    process.platform === 'win32'
      ? 'node "./bin/track.mjs" --host antigravity'
      : './hooks/agy-fast-track.sh';
  return {
    skilltally: {
      PostToolUse: [
        {
          matcher: 'read_file|view_file|run_command',
          hooks: [
            {
              type: 'command',
              command: cmd,
              timeout: 5,
            },
          ],
        },
      ],
    },
  };
}

export function installAntigravity({
  homeDir = homedir(),
  pkgRoot = getPackageRoot(),
  dryRun = false,
} = {}) {
  const target = getAntigravityPluginTarget(homeDir);

  let stat = null;
  try {
    stat = lstatSync(target);
  } catch {}

  if (stat?.isSymbolicLink()) {
    try {
      if (realpathSync(target) === realpathSync(pkgRoot)) {
        return { host: 'antigravity', status: 'unchanged', mode: 'symlink', target };
      }
    } catch {}
  }

  const existed = Boolean(stat);
  if (!dryRun) {
    mkdirSync(target, { recursive: true });
    for (const rel of ['package.json', 'plugin.json', 'hooks', 'bin', 'src', 'skills']) {
      const srcPath = join(pkgRoot, rel);
      if (existsSync(srcPath)) {
        cpSync(srcPath, join(target, rel), { recursive: true, force: true });
      }
    }
    for (const exe of [
      join(target, 'hooks', 'agy-fast-track.sh'),
      join(target, 'bin', 'track.mjs'),
      join(target, 'bin', 'cli.mjs'),
    ]) {
      if (existsSync(exe)) chmodSync(exe, 0o755);
    }

    writeJsonAtomic(join(target, 'hooks.json'), buildAntigravityHooksJson(), 0o644);

    let version = '1.0.3';
    try {
      version = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version || version;
    } catch {}
    writeFileSync(
      join(target, '.skilltally-managed'),
      JSON.stringify({ installedAt: new Date().toISOString(), version }, null, 2) + '\n',
      { mode: 0o644 }
    );
  }

  return {
    host: 'antigravity',
    status: existed ? 'updated' : 'installed',
    mode: 'plugin',
    target,
  };
}

export function uninstallAntigravity({ homeDir = homedir(), dryRun = false } = {}) {
  const target = getAntigravityPluginTarget(homeDir);

  let stat = null;
  try {
    stat = lstatSync(target);
  } catch {
    return { host: 'antigravity', status: 'not_installed', target };
  }

  if (stat.isSymbolicLink()) {
    if (!dryRun) {
      try {
        unlinkSync(target);
      } catch {
        rmdirSync(target);
      }
    }
    return { host: 'antigravity', status: 'uninstalled', mode: 'symlink', target };
  }

  if (!dryRun) {
    rmSync(target, { recursive: true, force: true });
  }
  return { host: 'antigravity', status: 'uninstalled', mode: 'plugin', target };
}
