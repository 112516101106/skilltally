import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvEscape, exportEvents } from '../src/report/export.mjs';
import { formatTimeline } from '../src/report/format.mjs';
import { buildTimeline, isoWeekBucket } from '../src/report/timeline.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cliScript = join(root, 'bin', 'cli.mjs');

test('isoWeekBucket handles year boundaries and buildTimeline aggregates day/week/month', () => {
  assert.equal(isoWeekBucket(new Date('2025-12-29T00:00:00.000Z')), '2026-W01');
  assert.equal(isoWeekBucket(new Date('2026-11-12T12:00:00.000Z')), '2026-W46');

  const now = new Date('2026-11-19T12:00:00.000Z');
  const events = [
    { v: 1, id: 'a:1', ts: '2026-11-10T09:00:00Z', host: 'antigravity', skill: 'pdf', session_id: 's1', origin: 'hook', ok: true },
    { v: 1, id: 'a:2', ts: '2026-11-10T09:05:00Z', host: 'antigravity', skill: 'pdf', session_id: 's1', origin: 'hook', ok: true },
    { v: 1, id: 'a:3', ts: '2026-11-12T10:00:00Z', host: 'codex', skill: 'clean-code', session_id: 's2', origin: 'backfill', ok: true },
    { v: 1, id: 'a:4', ts: '2026-10-05T10:00:00Z', host: 'claude', skill: 'pdf', session_id: 's3', origin: 'hook', ok: true },
    { v: 1, id: 'a:5', ts: '2026-11-12T11:00:00Z', host: 'codex', skill: 'pdf', session_id: 's4', origin: 'hook', ok: false },
  ];

  const byDay = buildTimeline({ events, by: 'day', since: '30d', now });
  assert.equal(byDay.totals.buckets, 2);
  assert.equal(byDay.totals.activations, 2);
  assert.equal(byDay.totals.reads, 3);
  assert.deepEqual(byDay.rows[0], { bucket: '2026-11-10', activations: 1, reads: 2, uniqueSkills: 1 });
  assert.deepEqual(byDay.rows[1], { bucket: '2026-11-12', activations: 1, reads: 1, uniqueSkills: 1 });

  const byWeekPdf = buildTimeline({ events, skill: 'pdf', by: 'week', since: 'all', now });
  assert.equal(byWeekPdf.totals.buckets, 2);
  assert.equal(byWeekPdf.rows[0].bucket, '2026-W41');
  assert.equal(byWeekPdf.rows[1].bucket, '2026-W46');

  const byMonth = buildTimeline({ events, by: 'month', since: 'all', now });
  assert.deepEqual(
    byMonth.rows.map((r) => [r.bucket, r.activations, r.reads]),
    [
      ['2026-10', 1, 1],
      ['2026-11', 2, 3],
    ]
  );

  const formatted = formatTimeline(byDay);
  assert.match(formatted, /2026-11-10/);
  assert.match(formatted, /totals: 2 activations/);

  const empty = buildTimeline({ events: [], by: 'day', since: '30d', now });
  assert.match(formatTimeline(empty), /No skill events found/);
});

test('exportEvents formats RFC-4180 CSV & JSON and CLI export -o writes file', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');

  const events = [
    {
      v: 1,
      id: 'c:1',
      ts: '2026-11-12T10:00:00Z',
      host: 'claude',
      skill: 'pdf',
      source: 'plugin:docs',
      via: 'skill_tool',
      tool: 'Skill',
      session_id: 's1',
      project: 'my, "proj"',
      model: 'claude-sonnet-4',
      origin: 'hook',
      ok: true,
    },
    {
      v: 1,
      id: 'c:2',
      ts: '2026-11-13T10:00:00Z',
      host: 'codex',
      skill: 'missing',
      source: 'personal',
      via: 'shell_read',
      tool: 'exec',
      session_id: 's2',
      project: 'app',
      origin: 'backfill',
      ok: false,
    },
  ];

  const csvOut = exportEvents({ events, format: 'csv', since: 'all' });
  assert.equal(csvOut.count, 1);
  assert.match(csvOut.content, /^ts,host,skill,source,via,tool,session_id,project,model,origin,ok\n/);
  assert.match(csvOut.content, /"my, ""proj"""/);

  const jsonAll = exportEvents({ events, format: 'json', since: 'all', includeFailed: true, host: 'codex' });
  assert.equal(jsonAll.count, 1);
  assert.equal(JSON.parse(jsonAll.content)[0].skill, 'missing');

  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-cli-exp-'));
  try {
    const outFile = join(tmp, 'nested', 'out.csv');
    const dataHome = join(tmp, 'data');
    const res = spawnSync(
      process.execPath,
      [cliScript, 'export', '--format', 'csv', '-o', outFile],
      { encoding: 'utf8', env: { ...process.env, SKILLTALLY_HOME: dataHome } }
    );
    assert.equal(res.status, 0);
    assert.equal(existsSync(outFile), true);
    assert.match(readFileSync(outFile, 'utf8'), /^ts,host,skill/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
