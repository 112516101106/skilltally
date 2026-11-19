import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function getDebugStatus(dataHome) {
  const markerPath = join(dataHome, '.debug');
  const logPath = join(dataHome, 'debug.jsonl');
  const enabled = existsSync(markerPath);
  const logExists = existsSync(logPath);

  let logBytes = 0;
  let logLines = 0;
  if (logExists) {
    try {
      logBytes = statSync(logPath).size;
      const raw = readFileSync(logPath, 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim()) logLines += 1;
      }
    } catch {}
  }

  return {
    enabled,
    markerPath,
    logPath,
    logExists,
    logBytes,
    logLines,
  };
}

export function setDebugMode(dataHome, enabled) {
  const markerPath = join(dataHome, '.debug');
  const logPath = join(dataHome, 'debug.jsonl');
  let deletedLog = false;

  if (enabled) {
    mkdirSync(dataHome, { recursive: true, mode: 0o700 });
    writeFileSync(
      markerPath,
      JSON.stringify({ enabledAt: new Date().toISOString() }) + '\n',
      { mode: 0o600 }
    );
  } else {
    if (existsSync(markerPath)) {
      rmSync(markerPath, { force: true });
    }
    if (existsSync(logPath)) {
      rmSync(logPath, { force: true });
      deletedLog = true;
    }
  }

  return {
    ...getDebugStatus(dataHome),
    deletedLog,
  };
}
