import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const trackScript = join(root, 'bin', 'track.mjs');
const fastTrack = join(root, 'hooks', 'agy-fast-track.sh');
const fixturesDir = join(root, 'test', 'fixtures');

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'skilltally-track-test-'));
}

test('bin/track.mjs records hit fixtures across all 4 hosts with --host auto', () => {
  const home = makeTempHome();
  try {
    const cases = [
      ['antigravity/hook-view-file.json', 'antigravity', 'requesting-code-review', 'plugin:superpowers', {}],
      ['codex/hook-post-tool-exec.json', 'codex', 'agent-browser', 'personal', { CODEX_THREAD_ID: 'th-1' }],
      ['claude/hook-skill-tool.json', 'claude', 'brainstorming', 'plugin:superpowers', { CLAUDE_PLUGIN_ROOT: '/tmp/p' }],
      ['gemini/hook-activate-skill.json', 'gemini', 'pdf', 'unknown', {}],
    ];

    for (const [fixture, expectedHost, expectedSkill, expectedSource, extraEnv] of cases) {
      const input = readFileSync(join(fixturesDir, fixture), 'utf8');
      const res = spawnSync(process.execPath, [trackScript, '--host', 'auto'], {
        input,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: '/Users/tester',
          USERPROFILE: '/Users/tester',
          SKILLTALLY_HOME: home,
          ...extraEnv,
        },
      });
      assert.equal(res.status, 0);
      assert.equal(res.stdout, '{}');
      const lines = readFileSync(join(home, 'events.jsonl'), 'utf8').trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]);
      assert.equal(last.host, expectedHost);
      assert.equal(last.skill, expectedSkill);
      assert.equal(last.source, expectedSource);
      assert.equal(last.origin, 'hook');
    }

    // Codex UserPromptSubmit explicit [$skill](path/to/SKILL.md) hook payload
    const promptInput = JSON.stringify({
      session_id: '00000000-0000-4000-8000-000000000001',
      turn_id: 'turn-001',
      transcript_path: '/Users/tester/.codex/sessions/2026/11/19/rollout.jsonl',
      cwd: '/Users/tester/projects/demo-app',
      model: 'gpt-6.1-sol',
      hook_event_name: 'UserPromptSubmit',
      prompt: '[$my-backup](/Users/tester/.agents/skills/my-backup/SKILL.md) run backup now\n',
    });
    const promptRes = spawnSync(process.execPath, [trackScript, '--host', 'codex'], {
      input: promptInput,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: '/Users/tester',
        USERPROFILE: '/Users/tester',
        SKILLTALLY_HOME: home,
      },
    });
    assert.equal(promptRes.status, 0);
    assert.equal(promptRes.stdout, '{}');
    const allLines = readFileSync(join(home, 'events.jsonl'), 'utf8').trim().split('\n');
    const lastEv = JSON.parse(allLines[allLines.length - 1]);
    assert.equal(lastEv.host, 'codex');
    assert.equal(lastEv.skill, 'my-backup');
    assert.equal(lastEv.source, 'personal');
    assert.equal(lastEv.via, 'mention');
    assert.equal(lastEv.tool, 'UserPromptSubmit');
    assert.equal(lastEv.origin, 'hook');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('bin/track.mjs swallows empty/corrupt stdin and logs debug when SKILLTALLY_DEBUG=1', () => {
  const home = makeTempHome();
  try {
    for (const input of ['', '   ', '{invalid-json']) {
      const res = spawnSync(process.execPath, [trackScript, '--host', 'antigravity'], {
        input,
        encoding: 'utf8',
        env: { ...process.env, SKILLTALLY_HOME: home },
      });
      assert.equal(res.status, 0);
      assert.equal(res.stdout, '{}');
    }
    assert.equal(existsSync(join(home, 'events.jsonl')), false);

    const dbgRes = spawnSync(process.execPath, [trackScript, '--host', 'antigravity'], {
      input: readFileSync(join(fixturesDir, 'antigravity/hook-miss.json'), 'utf8'),
      encoding: 'utf8',
      env: { ...process.env, SKILLTALLY_HOME: home, SKILLTALLY_DEBUG: '1' },
    });
    assert.equal(dbgRes.status, 0);
    assert.equal(dbgRes.stdout, '{}');
    assert.equal(existsSync(join(home, 'events.jsonl')), false);
    assert.equal(existsSync(join(home, 'debug.jsonl')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  'hooks/agy-fast-track.sh fast-paths misses and forwards hits to track.mjs',
  { skip: process.platform === 'win32' },
  () => {
  const home = makeTempHome();
  try {
    const missRes = spawnSync(fastTrack, [], {
      input: readFileSync(join(fixturesDir, 'antigravity/hook-miss.json'), 'utf8'),
      encoding: 'utf8',
      env: { ...process.env, SKILLTALLY_HOME: home },
    });
    assert.equal(missRes.status, 0);
    assert.equal(missRes.stdout, '{}');
    assert.equal(existsSync(join(home, 'events.jsonl')), false);

    const hitRes = spawnSync(fastTrack, [], {
      input: readFileSync(join(fixturesDir, 'antigravity/hook-view-file.json'), 'utf8'),
      encoding: 'utf8',
      env: { ...process.env, SKILLTALLY_HOME: home },
    });
    assert.equal(hitRes.status, 0);
    assert.equal(hitRes.stdout, '{}');
    const lines = readFileSync(join(home, 'events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.skill, 'requesting-code-review');
    assert.equal(ev.host, 'antigravity');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('bin/track.mjs deduplicates same-session reads within 30s and ignores paginated continuation reads', () => {
  const home = makeTempHome();
  try {
    const env = {
      ...process.env,
      HOME: '/Users/tester',
      USERPROFILE: '/Users/tester',
      SKILLTALLY_HOME: home,
    };
    const makeRead = (id, startLine, endLine) =>
      JSON.stringify({
        toolCall: {
          id,
          name: 'read_file',
          args: {
            Path: '"/Users/tester/.gemini/config/skills/find-skills/SKILL.md"',
            StartLine: startLine,
            EndLine: endLine,
          },
        },
        conversationId: 'conv-dedupe-001',
        hookEventName: 'PostToolUse',
        cwd: '/Users/tester/projects/demo-app',
      });

    // Chunk 1 -> written (1 line)
    const r1 = spawnSync(process.execPath, [trackScript, '--host', 'antigravity'], {
      input: makeRead('call_1', 1, 100),
      encoding: 'utf8',
      env,
    });
    assert.equal(r1.status, 0);

    // Chunk 2 (continuation StartLine=100) -> ignored (still 1 line)
    const rCont = spawnSync(process.execPath, [trackScript, '--host', 'antigravity'], {
      input: makeRead('call_2', 100, 141),
      encoding: 'utf8',
      env,
    });
    assert.equal(rCont.status, 0);

    // Repeat full read in same session within 30s -> deduped at write-time (still 1 line)
    const rDup = spawnSync(process.execPath, [trackScript, '--host', 'antigravity'], {
      input: makeRead('call_3', 1, 100),
      encoding: 'utf8',
      env,
    });
    assert.equal(rDup.status, 0);

    const lines = readFileSync(join(home, 'events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).skill, 'find-skills');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
