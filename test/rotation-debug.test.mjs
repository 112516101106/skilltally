import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDebugStatus, setDebugMode } from '../src/core/debug.mjs';
import { listEventFiles, readAllEvents, rotateEventsIfNeeded } from '../src/core/store.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const trackScript = join(root, 'bin', 'track.mjs');
const fastTrack = join(root, 'hooks', 'agy-fast-track.sh');
const fixturesDir = join(root, 'test', 'fixtures');

test('rotateEventsIfNeeded and bin/track.mjs rotate events.jsonl across multiple archives', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-rotate-test-'));
  try {
    mkdirSync(tmp, { recursive: true });
    const now = new Date('2026-11-19T10:00:00.000Z');
    const ev1 = JSON.stringify({ v: 1, id: 'antigravity:s1:1#0', ts: '2026-11-19T09:00:00Z', host: 'antigravity', skill: 'pdf', origin: 'hook', ok: true });
    writeFileSync(join(tmp, 'events.jsonl'), ev1 + '\n');

    const r1 = rotateEventsIfNeeded(tmp, { maxBytes: 10, now });
    assert.equal(r1.rotated, true);
    assert.match(r1.archivePath, /events-2026-11\.jsonl$/);

    // Second rotation in the same month gets -1 suffix
    const ev2 = JSON.stringify({ v: 1, id: 'antigravity:s1:2#0', ts: '2026-11-19T09:05:00Z', host: 'antigravity', skill: 'clean-code', origin: 'hook', ok: true });
    writeFileSync(join(tmp, 'events.jsonl'), ev2 + '\n');
    const r2 = rotateEventsIfNeeded(tmp, { maxBytes: 10, now });
    assert.equal(r2.rotated, true);
    assert.match(r2.archivePath, /events-2026-11-1\.jsonl$/);

    // Live track hook auto-rotates when SKILLTALLY_ROTATE_BYTES threshold is exceeded
    const hitPayload = readFileSync(join(fixturesDir, 'antigravity/hook-view-file.json'), 'utf8');
    writeFileSync(join(tmp, 'events.jsonl'), 'x'.repeat(200) + '\n'); // > 100 bytes
    const res = spawnSync(process.execPath, [trackScript, '--host', 'antigravity'], {
      input: hitPayload,
      encoding: 'utf8',
      env: { ...process.env, SKILLTALLY_HOME: tmp, SKILLTALLY_ROTATE_BYTES: '100' },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '{}');

    const files = listEventFiles(tmp);
    assert.equal(files.length, 4); // 3 rotated archives + fresh events.jsonl
    const { events } = readAllEvents(tmp);
    assert.equal(events.length, 3);
    assert.equal(events.some((e) => e.skill === 'requesting-code-review'), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('debug on|off|status toggles .debug marker, activates fast-track capture, and purges debug.jsonl on off', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-debug-test-'));
  try {
    assert.equal(getDebugStatus(tmp).enabled, false);

    const onStatus = setDebugMode(tmp, true);
    assert.equal(onStatus.enabled, true);
    assert.equal(existsSync(join(tmp, '.debug')), true);

    // Even a miss payload gets logged via fast-track wrapper when .debug marker exists
    const missPayload = readFileSync(join(fixturesDir, 'antigravity/hook-miss.json'), 'utf8');
    const res = spawnSync(fastTrack, [], {
      input: missPayload,
      encoding: 'utf8',
      env: { ...process.env, SKILLTALLY_HOME: tmp },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '{}');
    assert.equal(existsSync(join(tmp, 'events.jsonl')), false);

    const midStatus = getDebugStatus(tmp);
    assert.equal(midStatus.logExists, true);
    assert.equal(midStatus.logLines, 1);

    const offStatus = setDebugMode(tmp, false);
    assert.equal(offStatus.enabled, false);
    assert.equal(offStatus.logExists, false);
    assert.equal(offStatus.deletedLog, true);
    assert.deepEqual(readdirSync(tmp), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
