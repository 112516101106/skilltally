import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_ROTATE_BYTES = 20 * 1024 * 1024;

export function listEventFiles(homeDir) {
  if (!existsSync(homeDir)) return [];
  const entries = readdirSync(homeDir, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        (e.name === 'events.jsonl' ||
          e.name === 'events.backfill.jsonl' ||
          /^events-\d{4}-\d{2}(?:-\d+)?\.jsonl$/.test(e.name))
    )
    .map((e) => join(homeDir, e.name))
    .sort();
}

export function rotateEventsIfNeeded(
  homeDir,
  { maxBytes = DEFAULT_ROTATE_BYTES, now = new Date() } = {}
) {
  const eventsPath = join(homeDir, 'events.jsonl');
  if (!existsSync(eventsPath)) {
    return { rotated: false, archivePath: null };
  }

  let size = 0;
  try {
    size = statSync(eventsPath).size;
  } catch {
    return { rotated: false, archivePath: null };
  }
  if (size < maxBytes) {
    return { rotated: false, archivePath: null };
  }

  const month = now.toISOString().slice(0, 7);
  let archivePath = join(homeDir, `events-${month}.jsonl`);
  let suffix = 1;
  while (existsSync(archivePath)) {
    archivePath = join(homeDir, `events-${month}-${suffix}.jsonl`);
    suffix += 1;
  }

  renameSync(eventsPath, archivePath);
  return { rotated: true, archivePath };
}

export function readAllEvents(homeDir) {
  const files = listEventFiles(homeDir);
  const events = [];
  let corruptLines = 0;

  for (const file of files) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object' && obj.skill) {
          events.push(obj);
        } else {
          corruptLines += 1;
        }
      } catch {
        corruptLines += 1;
      }
    }
  }

  return { events, corruptLines, files };
}

export function writeBackfillEvents(homeDir, events) {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const target = join(homeDir, 'events.backfill.jsonl');
  const tmp = join(homeDir, `events.backfill.jsonl.tmp.${process.pid}`);
  const body = events.length > 0 ? events.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, target);
  return target;
}
