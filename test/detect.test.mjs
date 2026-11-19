import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSkillCalls,
  normalizeHookPayload,
  resolveHost,
  resolveSource,
} from '../src/core/detect.mjs';

test('detects Antigravity view_file and read_file with double-encoded paths', () => {
  const hits = detectSkillCalls({
    tool: 'view_file',
    args: {
      AbsolutePath: '"/Users/tester/.gemini/config/plugins/superpowers/skills/requesting-code-review/SKILL.md"',
    },
    homeDir: '/Users/tester',
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].skill, 'requesting-code-review');
  assert.equal(hits[0].source, 'plugin:superpowers');
  assert.equal(hits[0].via, 'read');
});

test('detects shell read commands and rejects wildcards, mutators, and diagnostic tools', () => {
  const catHits = detectSkillCalls({
    tool: 'run_command',
    args: { CommandLine: '"cat /Users/tester/.agents/skills/agent-browser/SKILL.md"' },
    homeDir: '/Users/tester',
  });
  assert.equal(catHits.length, 1);
  assert.equal(catHits[0].skill, 'agent-browser');
  assert.equal(catHits[0].source, 'personal');
  assert.equal(catHits[0].via, 'shell_read');

  const multiHits = detectSkillCalls({
    tool: 'Bash',
    args: { command: 'cat a/skills/x/SKILL.md b/skills/y/SKILL.md' },
  });
  assert.deepEqual(
    multiHits.map((h) => [h.skill, h.via]),
    [
      ['x', 'shell_read'],
      ['y', 'shell_read'],
    ]
  );

  const negativeCases = [
    ['run_command', { CommandLine: 'ls ~/.agents/skills/b/' }],
    ['run_command', { CommandLine: 'head -n 15 /Users/tester/.agents/skills/*/SKILL.md' }],
    ['run_command', { CommandLine: 'grep -rl foo /Users/tester/.agents/skills/*/SKILL.md' }],
    ['run_command', { CommandLine: 'python3 -c "print(\'/a/skills/fake/SKILL.md\')"' }],
    ['run_command', { CommandLine: 'sed -i "" "s/a/b/" /Users/tester/.agents/skills/foo/SKILL.md' }],
    ['run_command', { CommandLine: 'cat /tmp/in.md > /Users/tester/.agents/skills/foo/SKILL.md' }],
    ['edit_file', { Path: '/Users/tester/.agents/skills/foo/SKILL.md' }],
    ['write_file', { Path: '/Users/tester/.agents/skills/foo/SKILL.md' }],
    ['replace_file_content', { TargetFile: '/Users/tester/.agents/skills/foo/SKILL.md' }],
    ['apply_patch', { path: '/Users/tester/.agents/skills/foo/SKILL.md' }],
    ['Edit', { file_path: '/Users/tester/.agents/skills/foo/SKILL.md' }],
    ['Write', { file_path: '/Users/tester/.agents/skills/foo/SKILL.md' }],
  ];

  for (const [tool, args] of negativeCases) {
    const res = detectSkillCalls({ tool, args, homeDir: '/Users/tester' });
    assert.equal(res.length, 0, `Expected 0 hits for ${tool} ${JSON.stringify(args)}`);
  }
});

test('detects Claude Skill tool, Gemini activate_skill, Codex exec, and Windows paths', () => {
  const claudeNs = detectSkillCalls({
    tool: 'Skill',
    args: { skill: 'superpowers:brainstorming' },
  });
  assert.deepEqual(claudeNs, [
    {
      skill: 'brainstorming',
      raw_skill: 'superpowers:brainstorming',
      source: 'plugin:superpowers',
      via: 'skill_tool',
    },
  ]);

  const claudePlain = detectSkillCalls({ tool: 'Skill', args: { skill: 'pdf' } });
  assert.deepEqual(claudePlain, [{ skill: 'pdf', via: 'skill_tool' }]);

  const gemini = detectSkillCalls({ tool: 'activate_skill', args: { name: 'docx' } });
  assert.deepEqual(gemini, [{ skill: 'docx', via: 'activate_skill' }]);

  const codexExec = detectSkillCalls({
    tool: 'exec',
    args: {
      input:
        'const r = await tools.exec_command({cmd:"cat /Users/tester/.agents/skills/agent-browser/SKILL.md"});',
    },
    homeDir: '/Users/tester',
  });
  assert.equal(codexExec.length, 1);
  assert.equal(codexExec[0].skill, 'agent-browser');

  const win = detectSkillCalls({
    tool: 'Read',
    args: { file_path: 'C:\\Users\\u\\.claude\\skills\\z\\SKILL.md' },
    homeDir: 'C:\\Users\\u',
  });
  assert.equal(win.length, 1);
  assert.equal(win[0].skill, 'z');
  assert.equal(win[0].source, 'personal');
});

test('resolveSource handles plugin cache marketplace hierarchy and personal vs project precedence', () => {
  assert.equal(
    resolveSource(
      '/Users/tester/.codex/plugins/cache/openai-api-curated/superpowers/5fd93af4/skills/tdd/SKILL.md',
      '/Users/tester',
      '/Users/tester'
    ),
    'plugin:superpowers'
  );
  assert.equal(
    resolveSource(
      '/Users/tester/.gemini/config/plugins/science/skills/chembl/SKILL.md',
      '',
      '/Users/tester'
    ),
    'plugin:science'
  );
  assert.equal(
    resolveSource(
      '/Users/tester/.gemini/antigravity/builtin/skills/swarm/SKILL.md',
      '',
      '/Users/tester'
    ),
    'builtin'
  );
  // Even when cwd equals homeDir, personal skills stay personal
  assert.equal(
    resolveSource(
      '/Users/tester/.agents/skills/clean-code/SKILL.md',
      '/Users/tester',
      '/Users/tester'
    ),
    'personal'
  );
  assert.equal(
    resolveSource(
      '/Users/tester/projects/app/.agents/skills/local-skill/SKILL.md',
      '/Users/tester/projects/app',
      '/Users/tester'
    ),
    'project'
  );
  assert.equal(resolveSource('a/skills/x/SKILL.md', '', '/Users/tester'), 'unknown');
});

test('resolveHost and normalizeHookPayload handle all 4 hosts', () => {
  assert.equal(
    resolveHost('auto', {
      toolCall: { name: 'view_file' },
      transcriptPath: '/Users/u/.gemini/antigravity-ide/brain/1/transcript.jsonl',
    }),
    'antigravity-ide'
  );
  assert.equal(
    resolveHost('auto', { hook_event_name: 'AfterTool', tool_name: 'activate_skill' }, {}),
    'gemini'
  );
  assert.equal(resolveHost('auto', { tool_name: 'exec' }, { CODEX_THREAD_ID: 't1' }), 'codex');
  assert.equal(
    resolveHost('auto', { tool_name: 'Skill' }, { CLAUDE_PLUGIN_ROOT: '/p' }),
    'claude'
  );

  const norm = normalizeHookPayload('antigravity', {
    toolCall: { id: 'c1', name: 'view_file', args: { Path: '/a/SKILL.md' } },
    conversationId: 'conv1',
    cwd: '/tmp/proj',
    modelName: 'm1',
  });
  assert.equal(norm.tool, 'view_file');
  assert.equal(norm.callId, 'c1');
  assert.equal(norm.sessionId, 'conv1');
  assert.equal(norm.cwd, '/tmp/proj');
  assert.equal(norm.model, 'm1');
  assert.equal(norm.failed, false);
});
