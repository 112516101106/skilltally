import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { runBackfill } from '../src/backfill/index.mjs';
import { readAllEvents } from '../src/core/store.mjs';
import { dedupeEvents } from '../src/core/normalize.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = join(root, 'test', 'fixtures');

test('backfills Antigravity (including truncated_fields and antigravity-ide) and Codex (.jsonl + .zst)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-backfill-test-'));
  const homeDir = join(tmp, 'home');
  const dataHome = join(tmp, 'data');

  try {
    // Antigravity main transcript + transcript_full
    const agyLogs = join(homeDir, '.gemini', 'antigravity', 'brain', 'conv-1', '.system_generated', 'logs');
    mkdirSync(agyLogs, { recursive: true });
    copyFileSync(join(fixturesDir, 'antigravity', 'transcript-sample.jsonl'), join(agyLogs, 'transcript.jsonl'));
    copyFileSync(join(fixturesDir, 'antigravity', 'transcript_full-sample.jsonl'), join(agyLogs, 'transcript_full.jsonl'));

    // Antigravity IDE transcript
    const ideLogs = join(homeDir, '.gemini', 'antigravity-ide', 'brain', 'conv-ide', '.system_generated', 'logs');
    mkdirSync(ideLogs, { recursive: true });
    writeFileSync(
      join(ideLogs, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 1,
        status: 'DONE',
        created_at: '2026-11-11T08:00:00Z',
        tool_calls: [
          {
            name: 'read_file',
            args: { Path: '"/Users/tester/.gemini/config/skills/seo-audit/SKILL.md"' },
          },
        ],
      }) + '\n'
    );

    // Codex .jsonl rollout
    const codexDir = join(homeDir, '.codex', 'sessions', '2026', '11', '05');
    mkdirSync(codexDir, { recursive: true });
    copyFileSync(
      join(fixturesDir, 'codex', 'rollout-sample.jsonl'),
      join(codexDir, 'rollout-2026-11-05T05-18-00-00000000-0000-4000-8000-000000000001.jsonl')
    );

    // Codex .jsonl.zst archive when Node supports zstdCompressSync
    let expectedCodexEvents = 3;
    if (typeof zlib.zstdCompressSync === 'function') {
      const archived = join(homeDir, '.codex', 'archived_sessions');
      mkdirSync(archived, { recursive: true });
      const zstContent = [
        JSON.stringify({
          timestamp: '2026-10-01T10:00:00Z',
          type: 'session_meta',
          payload: { id: 'sess-zst-1', cwd: '/Users/tester/proj' },
        }),
        JSON.stringify({
          timestamp: '2026-10-01T10:01:00Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call_z1',
            arguments: JSON.stringify({ cmd: 'cat /Users/tester/.agents/skills/zst-skill/SKILL.md' }),
          },
        }),
      ].join('\n');
      writeFileSync(
        join(archived, 'rollout-2026-10-01T10-00-00-sess-zst-1.jsonl.zst'),
        zlib.zstdCompressSync(Buffer.from(zstContent, 'utf8'))
      );
      expectedCodexEvents = 4;
    }

    const summary = runBackfill({ homeDir, dataHome, host: 'all' });
    assert.equal(summary.hosts.antigravity.files, 2);
    // transcript-sample has 4 genuine reads (using-superpowers, requesting-code-review, clean-code, agy-customizations)
    // and rejects edit_file, head *, grep, python3; plus 1 from antigravity-ide = 5.
    assert.equal(summary.hosts.antigravity.events, 5);
    assert.equal(summary.hosts.codex.events, expectedCodexEvents);
    assert.equal(summary.hosts.codex.skippedZst, 0);

    const { events } = readAllEvents(dataHome);
    const agySkills = events.filter((e) => e.host.startsWith('antigravity')).map((e) => e.skill);
    assert.deepEqual(agySkills.sort(), [
      'agy-customizations',
      'clean-code',
      'requesting-code-review',
      'seo-audit',
      'using-superpowers',
    ]);
    assert.equal(events.some((e) => e.host === 'antigravity-ide' && e.skill === 'seo-audit'), true);

    const missingCodex = events.find((e) => e.host === 'codex' && e.skill === 'missing-skill');
    assert.equal(missingCodex?.ok, false);

    // Re-running backfill overwrites events.backfill.jsonl idempotently
    const second = runBackfill({ homeDir, dataHome, host: 'all' });
    assert.equal(second.totalEvents, summary.totalEvents);
    assert.equal(readAllEvents(dataHome).events.length, events.length);

    // Hook event overrides duplicate backfill event in same window
    const hookEv = {
      ...events[0],
      id: 'antigravity:conv-1:hook_override#0',
      origin: 'hook',
    };
    const merged = dedupeEvents([...events, hookEv]);
    assert.equal(merged.length, events.length);
    assert.equal(merged.find((e) => e.id === hookEv.id)?.origin, 'hook');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
