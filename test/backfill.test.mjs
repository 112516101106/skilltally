import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { backfillAntigravity } from '../src/backfill/antigravity.mjs';
import { backfillClaude } from '../src/backfill/claude.mjs';
import { backfillCodex } from '../src/backfill/codex.mjs';
import { backfillGemini } from '../src/backfill/gemini.mjs';
import { runBackfill } from '../src/backfill/index.mjs';
import { readAllEvents } from '../src/core/store.mjs';
import { dedupeEvents } from '../src/core/normalize.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = join(root, 'test', 'fixtures');

test('backfills Antigravity (including truncated_fields and antigravity-ide), Codex (.jsonl + .zst), Claude, and Gemini', () => {
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
        JSON.stringify({
          timestamp: '2026-10-01T10:02:00Z',
          type: 'response_item',
          payload: {
            type: 'message',
            id: 'msg_u1',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '[$explicit-skill](/Users/tester/.agents/skills/explicit-skill/SKILL.md) run task',
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: '2026-10-01T10:02:00Z',
          type: 'response_item',
          payload: {
            type: 'message',
            id: 'msg_u2',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<skill>\n<name>explicit-skill</name>\n<path>/Users/tester/.agents/skills/explicit-skill/SKILL.md</path>\n</skill>',
              },
            ],
          },
        }),
      ].join('\n');
      writeFileSync(
        join(archived, 'rollout-2026-10-01T10-00-00-sess-zst-1.jsonl.zst'),
        zlib.zstdCompressSync(Buffer.from(zstContent, 'utf8'))
      );
      expectedCodexEvents = 5;
    }

    // Claude project transcript
    const claudeProj = join(homeDir, '.claude', 'projects', '-Users-tester-projects-demo-app');
    mkdirSync(claudeProj, { recursive: true });
    copyFileSync(
      join(fixturesDir, 'claude', 'session-sample.jsonl'),
      join(claudeProj, '00000000-0000-4000-8000-000000000002.jsonl')
    );

    const claudeRaw = backfillClaude({ homeDir });
    assert.equal(claudeRaw.files, 1);
    assert.equal(claudeRaw.events.length, 5); // Skill + Read + Skill(pdf) + Bash(clean-code) + Read(missing), Edit ignored
    assert.equal(claudeRaw.events.find((e) => e.skill === 'missing')?.ok, false);

    // Gemini CLI .json + .jsonl chat transcripts
    const geminiChats = join(homeDir, '.gemini', 'tmp', 'projhash1', 'chats');
    mkdirSync(geminiChats, { recursive: true });
    copyFileSync(
      join(fixturesDir, 'gemini', 'session-sample.json'),
      join(geminiChats, 'session-2026-11-14-00000000-0000-4000-8000-000000000003.json')
    );
    writeFileSync(
      join(geminiChats, 'session-2026-11-15-jsonl.jsonl'),
      JSON.stringify({
        sessionId: 'gem-jsonl-1',
        timestamp: '2026-11-15T10:00:00Z',
        toolCalls: [{ id: 'gj1', name: 'activate_skill', args: { name: 'docx' }, status: 'success' }],
      }) + '\n'
    );

    const gemRaw = backfillGemini({ homeDir });
    assert.equal(gemRaw.files, 2);
    assert.equal(gemRaw.events.length, 4);
    assert.equal(gemRaw.events.find((e) => e.skill === 'missing-skill')?.ok, false);

    const summary = runBackfill({ homeDir, dataHome, host: 'all' });
    assert.equal(summary.hosts.antigravity.files, 2);
    // transcript-sample has 4 genuine reads (using-superpowers, requesting-code-review, clean-code, agy-customizations)
    // and rejects edit_file, head *, grep, python3; plus 1 from antigravity-ide = 5.
    assert.equal(summary.hosts.antigravity.events, 5);
    assert.equal(summary.hosts.codex.events, expectedCodexEvents);
    assert.equal(summary.hosts.codex.skippedZst, 0);
    assert.equal(summary.hosts.claude.files, 1);
    assert.equal(summary.hosts.claude.events, 5);
    assert.equal(summary.hosts.gemini.files, 2);
    assert.equal(summary.hosts.gemini.events, 4);

    const { events } = readAllEvents(dataHome);
    // Soft 5s dedupe collapses Claude Skill("superpowers:brainstorming") + Read 1s later into 1 event
    const claudeEvents = events.filter((e) => e.host === 'claude');
    assert.equal(claudeEvents.length, 4);
    assert.deepEqual(
      claudeEvents.map((e) => e.skill),
      ['brainstorming', 'pdf', 'clean-code', 'missing']
    );
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

test('handles Codex forked session_meta, post-task_complete idle gaps, Antigravity manual slash preservation & scripts, and Gemini $set.messages', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-audit-bf-'));
  const homeDir = join(tmp, 'home');
  const dataHome = join(tmp, 'data');

  try {
    // 1. Codex parent & forked rollout + post-task_complete multi-day idle event
    const codexSessDir = join(homeDir, '.codex', 'sessions', '2026', '10', '01');
    mkdirSync(codexSessDir, { recursive: true });
    const parentId = '00000000-0000-4000-8000-000000000101';
    const childId = '00000000-0000-4000-8000-000000000102';

    const parentLines = [
      JSON.stringify({ timestamp: '2026-10-01T10:00:00.000Z', type: 'session_meta', payload: { id: parentId, cwd: '/Users/tester/app' } }),
      JSON.stringify({ timestamp: '2026-10-01T10:00:01.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ timestamp: '2026-10-01T10:00:01.500Z', type: 'turn_context', payload: { cwd: '/Users/tester/app', model: 'gpt-6.1-sol' } }),
      JSON.stringify({ timestamp: '2026-10-01T10:00:02.000Z', type: 'response_item', payload: { type: 'message', id: 'msg_parent_1', role: 'user', content: [{ type: 'input_text', text: '<skill>\n<name>superpowers:writing-plans</name>\n<path>/Users/tester/.codex/plugins/cache/superpowers-dev/superpowers/6.3.0/skills/writing-plans/SKILL.md</path>\n</skill>' }] } }),
      JSON.stringify({ timestamp: '2026-10-01T10:00:05.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_shared_parent', arguments: JSON.stringify({ cmd: 'cat /Users/tester/.agents/skills/clean-code/SKILL.md' }) } }),
      JSON.stringify({ timestamp: '2026-10-01T10:00:06.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_shared_parent', output: 'ok' } }),
      JSON.stringify({ timestamp: '2026-10-01T10:00:35.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
      // Re-opened thread 3 days later before next turn_context -> must NOT inflate Turn 1 duration
      JSON.stringify({ timestamp: '2026-10-04T10:00:00.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied' } }),
    ].join('\n');

    const childLines = [
      JSON.stringify({ timestamp: '2026-10-02T10:00:00.000Z', type: 'session_meta', payload: { id: childId, forked_from_id: parentId, cwd: '/Users/tester/app' } }),
      // Replayed parent session_meta MUST NOT overwrite childId!
      JSON.stringify({ timestamp: '2026-10-02T10:00:00.001Z', type: 'session_meta', payload: { id: parentId } }),
      // Replayed parent items with identical msg/call IDs must be deduplicated across fork
      JSON.stringify({ timestamp: '2026-10-02T10:00:00.002Z', type: 'response_item', payload: { type: 'message', id: 'msg_parent_1', role: 'user', content: [{ type: 'input_text', text: '<skill>\n<name>superpowers:writing-plans</name>\n<path>/Users/tester/.codex/plugins/cache/superpowers-dev/superpowers/6.3.0/skills/writing-plans/SKILL.md</path>\n</skill>' }] } }),
      JSON.stringify({ timestamp: '2026-10-02T10:00:00.003Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_shared_parent', arguments: JSON.stringify({ cmd: 'cat /Users/tester/.agents/skills/clean-code/SKILL.md' }) } }),
      // Child's own new turn & skill call
      JSON.stringify({ timestamp: '2026-10-02T10:05:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ timestamp: '2026-10-02T10:05:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_child_own', input: 'const r = await tools.exec_command({"cmd":"cat /Users/tester/.codex/skills/.system/review-agent/SKILL.md"});' } }),
      JSON.stringify({ timestamp: '2026-10-02T10:05:25.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n');

    writeFileSync(join(codexSessDir, `rollout-2026-10-01T10-00-00-${parentId}.jsonl`), parentLines + '\n');
    writeFileSync(join(codexSessDir, `rollout-2026-10-02T10-00-00-${childId}.jsonl`), childLines + '\n');

    const codexRes = backfillCodex({ homeDir });
    assert.equal(codexRes.events.length, 3);
    const wp = codexRes.events.find((e) => e.skill === 'writing-plans');
    assert.ok(wp);
    assert.equal(wp.session_id, parentId);
    assert.equal(wp.duration_seconds, 33); // 10:00:35 - 10:00:02, NOT 86400!
    const cc = codexRes.events.find((e) => e.skill === 'clean-code');
    assert.equal(cc.session_id, parentId);
    assert.equal(cc.duration_seconds, 30);
    const ra = codexRes.events.find((e) => e.skill === 'review-agent');
    assert.ok(ra);
    assert.equal(ra.session_id, childId); // NOT overwritten by replayed parent session_meta!
    assert.equal(ra.duration_seconds, 20);

    // 2. Antigravity manual <SKILL> preservation across read_file + direct script execution
    const agyLogs = join(homeDir, '.gemini', 'antigravity', 'brain', 'conv-manual-1', '.system_generated', 'logs');
    mkdirSync(agyLogs, { recursive: true });
    const agyLines = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-19T10:00:00Z',
        content: '<SKILL>\nPlease read and use the "uniprot-database" skill. The path to the skill file is: /Users/tester/.gemini/config/plugins/science/skills/uniprot_database/SKILL.md\n</SKILL>\nCheck P04637',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-19T10:00:05Z',
        tool_calls: [
          { name: 'read_file', args: { Path: '/Users/tester/.gemini/config/plugins/science/skills/uniprot_database/SKILL.md' } },
          { name: 'run_command', args: { CommandLine: 'python3 ~/.agents/skills/memory-recall/scripts/search_memory.py auth' } },
        ],
      }),
    ].join('\n');
    writeFileSync(join(agyLogs, 'transcript.jsonl'), agyLines + '\n');

    const agyRes = backfillAntigravity({ homeDir });
    assert.equal(agyRes.events.length, 2);
    const uniprotEv = agyRes.events.find((e) => e.skill.includes('uniprot'));
    assert.equal(uniprotEv.via, 'slash_command');
    const memEv = agyRes.events.find((e) => e.skill === 'memory-recall');
    assert.equal(memEv.via, 'shell_read');

    // 3. Gemini CLI .jsonl $set.messages checkpoint format
    const gemChats = join(homeDir, '.gemini', 'tmp', 'proj1', 'chats');
    mkdirSync(gemChats, { recursive: true });
    writeFileSync(
      join(gemChats, 'session-2026-11-19-patch.jsonl'),
      JSON.stringify({ sessionId: 'gem-patch-1', startTime: '2026-11-19T11:00:00Z' }) +
        '\n' +
        JSON.stringify({
          $set: {
            lastUpdated: '2026-11-19T11:01:00Z',
            messages: [
              {
                type: 'gemini',
                timestamp: '2026-11-19T11:00:10Z',
                toolCalls: [{ id: 'tc_gp_1', name: 'activate_skill', args: { name: 'pdf' }, status: 'success' }],
              },
            ],
          },
        }) +
        '\n'
    );
    const gemRes = backfillGemini({ homeDir });
    assert.equal(gemRes.events.length, 1);
    assert.equal(gemRes.events[0].skill, 'pdf');
    assert.equal(gemRes.events[0].session_id, 'gem-patch-1');

    // Full runBackfill ensures canonicalization + hook-vs-slash dedupe preserves manual trigger
    const summary = runBackfill({ homeDir, dataHome, host: 'all' });
    assert.ok(summary.totalEvents >= 6);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
