import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { backfillClaude } from '../src/backfill/claude.mjs';
import { extractUsageMetrics, sanitizePromptPreview } from '../src/core/detect.mjs';
import { runPrune } from '../src/install/prune.mjs';
import { scanInventory } from '../src/inventory/scan.mjs';
import { handleMcpRequest } from '../src/mcp/server.mjs';
import { aggregateStats, encodeSparkline } from '../src/report/aggregate.mjs';
import { buildChains } from '../src/report/chains.mjs';
import { generateDashboardHtml } from '../src/report/dashboard.mjs';
import { formatChains, formatInsights, formatPrune, formatStats, formatUnused } from '../src/report/format.mjs';
import { buildTimeline } from '../src/report/timeline.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cliScript = join(root, 'bin', 'cli.mjs');

test('aggregateStats computes sparklines, trigger ratios, project affinity, and Context ROI', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');
  assert.equal(encodeSparkline([0, 0, 0]), '···');
  assert.equal(encodeSparkline([0, 1, 4, 8]), '·▁▄█');

  const inventory = {
    skills: [
      {
        name: 'brainstorming',
        dir_name: 'brainstorming',
        path: '/p/brainstorming/SKILL.md',
        source: 'plugin:superpowers',
        hosts: ['claude', 'antigravity'],
        desc_chars: 200,
        est_tokens: 50,
        enabled: true,
      },
      {
        name: 'manual-only-skill',
        dir_name: 'manual-only-skill',
        path: '/p/manual-only-skill/SKILL.md',
        source: 'personal',
        hosts: ['codex'],
        desc_chars: 400,
        est_tokens: 100,
        enabled: true,
      },
      {
        name: 'dead-bloat',
        dir_name: 'dead-bloat',
        path: '/p/dead-bloat/SKILL.md',
        source: 'plugin:bloat',
        hosts: ['antigravity'],
        desc_chars: 800,
        est_tokens: 200,
        enabled: true,
      },
    ],
    index: {
      byPath: new Map([
        ['/p/brainstorming/SKILL.md', { name: 'brainstorming', source: 'plugin:superpowers', est_tokens: 50, desc_chars: 200 }],
        ['/p/manual-only-skill/SKILL.md', { name: 'manual-only-skill', source: 'personal', est_tokens: 100, desc_chars: 400 }],
      ]),
      byDirName: new Map([
        ['brainstorming', { name: 'brainstorming', source: 'plugin:superpowers', est_tokens: 50, desc_chars: 200 }],
        ['manual-only-skill', { name: 'manual-only-skill', source: 'personal', est_tokens: 100, desc_chars: 400 }],
      ]),
      byName: new Map([
        ['brainstorming', { name: 'brainstorming', source: 'plugin:superpowers', est_tokens: 50, desc_chars: 200 }],
        ['manual-only-skill', { name: 'manual-only-skill', source: 'personal', est_tokens: 100, desc_chars: 400 }],
      ]),
    },
  };

  const events = [
    {
      v: 1,
      id: 'c:1',
      ts: '2026-11-18T10:00:00Z',
      host: 'claude',
      skill: 'brainstorming',
      via: 'skill_tool',
      session_id: 's1',
      project: 'alpha',
      model: 'claude-sonnet-4',
      origin: 'hook',
      ok: true,
    },
    {
      v: 1,
      id: 'c:2',
      ts: '2026-11-19T10:00:00Z',
      host: 'antigravity',
      skill: 'brainstorming',
      via: 'read',
      session_id: 's2',
      project: 'beta',
      model: 'gemini-2.5-pro',
      origin: 'hook',
      ok: true,
    },
    {
      v: 1,
      id: 'c:3',
      ts: '2026-11-19T12:00:00Z',
      host: 'codex',
      skill: 'manual-only-skill',
      via: 'mention',
      session_id: 's3',
      project: 'solo-repo',
      model: 'gpt-5',
      origin: 'hook',
      ok: true,
    },
  ];

  const report = aggregateStats({ events, inventory, since: '30d', now });
  assert.equal(report.totals.sessions, 3);
  assert.equal(report.totals.autoReads, 2);
  assert.equal(report.totals.manualReads, 1);
  assert.equal(report.inventory.enabledEstTokens, 350);
  assert.equal(report.inventory.usedEstTokens, 150);

  const brain = report.rows.find((r) => r.skill === 'brainstorming');
  assert.equal(brain.sparkline.length, 14);
  assert.match(brain.sparkline, /█/);
  assert.equal(brain.manualRatio, 0);
  assert.equal(brain.tokenCostPerActivation, Math.round((3 * 50) / 2));

  const manual = report.rows.find((r) => r.skill === 'manual-only-skill');
  assert.equal(manual.manualRatio, 1);
  assert.equal(manual.tokenCostPerActivation, 300);

  assert.equal(report.insights.manualOnlySkills.length, 1);
  assert.equal(report.insights.manualOnlySkills[0].skill, 'manual-only-skill');
  assert.equal(report.insights.projectScopeCandidates.length, 1);
  assert.equal(report.insights.projectScopeCandidates[0].project, 'solo-repo');
  assert.equal(report.insights.highCostSkills[0].skill, 'manual-only-skill');

  const statsOut = formatStats(report);
  assert.match(statsOut, /triggers: auto 2 · manual 1/);
  assert.match(statsOut, /trend \(14d\)/);

  const unusedOut = formatUnused(report);
  assert.match(unusedOut, /context tax: \[.*\] 57% unused/);

  const insightsOut = formatInsights(report);
  assert.match(insightsOut, /Context Tax & ROI Efficiency/);
  assert.match(insightsOut, /Manual-only skills/);
  assert.match(insightsOut, /manual-only-skill/);
  assert.match(insightsOut, /only in "solo-repo"/);
  assert.match(insightsOut, /Model Breakdown/);
});

test('buildChains detects ordered transitions, 3-step workflows, and Jaccard pairs', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');
  const events = [
    // Session 1: brainstorming -> brainstorming (collapsed) -> writing-plans -> verification
    { v: 1, id: '1', ts: '2026-11-18T10:00:00Z', host: 'claude', skill: 'brainstorming', session_id: 's1', ok: true },
    { v: 1, id: '2', ts: '2026-11-18T10:01:00Z', host: 'claude', skill: 'brainstorming', session_id: 's1', ok: true },
    { v: 1, id: '3', ts: '2026-11-18T10:05:00Z', host: 'claude', skill: 'writing-plans', session_id: 's1', ok: true },
    { v: 1, id: '4', ts: '2026-11-18T10:15:00Z', host: 'claude', skill: 'verification', session_id: 's1', ok: true },
    // Session 2: brainstorming -> writing-plans -> verification
    { v: 1, id: '5', ts: '2026-11-19T10:00:00Z', host: 'claude', skill: 'brainstorming', session_id: 's2', ok: true },
    { v: 1, id: '6', ts: '2026-11-19T10:04:00Z', host: 'claude', skill: 'writing-plans', session_id: 's2', ok: true },
    { v: 1, id: '7', ts: '2026-11-19T10:10:00Z', host: 'claude', skill: 'verification', session_id: 's2', ok: true },
    // Session 3: single skill only
    { v: 1, id: '8', ts: '2026-11-19T12:00:00Z', host: 'codex', skill: 'brainstorming', session_id: 's3', ok: true },
  ];

  const chains = buildChains({ events, since: '30d', now });
  assert.equal(chains.totals.sessions, 3);
  assert.equal(chains.totals.multiSkillSessions, 2);

  const bw = chains.transitions.find((t) => t.from === 'brainstorming' && t.to === 'writing-plans');
  assert.ok(bw);
  assert.equal(bw.sessions, 2);
  assert.equal(bw.probability, 0.67);
  assert.equal(bw.avgGapSeconds, 270);

  assert.equal(chains.sequences.length, 1);
  assert.equal(chains.sequences[0].label, 'brainstorming -> writing-plans -> verification');
  assert.equal(chains.sequences[0].sessions, 2);

  const pair = chains.pairs.find(
    (p) => p.skills[0] === 'brainstorming' && p.skills[1] === 'writing-plans'
  );
  assert.ok(pair);
  assert.equal(pair.sessions, 2);
  assert.equal(pair.jaccard, 0.67);

  const formatted = formatChains(chains);
  assert.match(formatted, /brainstorming -> writing-plans/);
  assert.match(formatted, /brainstorming \+ writing-plans/);
  assert.match(formatted, /brainstorming -> writing-plans -> verification/);
});

test('generateDashboardHtml and CLI dashboard produce valid self-contained HTML', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');
  const events = [
    { v: 1, id: 'd:1', ts: '2026-11-18T10:00:00Z', host: 'antigravity', skill: 'pdf', session_id: 's1', via: 'read', project: 'proj-a', ok: true },
  ];
  const inventory = {
    skills: [
      { name: 'pdf', dir_name: 'pdf', path: '/a/pdf/SKILL.md', source: 'personal', hosts: ['antigravity'], desc_chars: 160, est_tokens: 40, enabled: true },
      { name: 'unused-doc', dir_name: 'unused-doc', path: '/a/unused-doc/SKILL.md', source: 'plugin:docs', hosts: ['antigravity'], desc_chars: 400, est_tokens: 100, enabled: true },
    ],
    index: { byPath: new Map(), byDirName: new Map(), byName: new Map() },
  };
  const stats = aggregateStats({ events, inventory, since: '30d', now });
  const timeline = buildTimeline({ events, inventory, since: '30d', now });
  const chains = buildChains({ events, inventory, since: '30d', now });

  const html = generateDashboardHtml({ stats, timeline, chains, inventory });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /id="skilltally-data"/);
  assert.match(html, /svg-treemap/);
  assert.match(html, /svg-timeline/);
  assert.match(html, /svg-chains/);
  assert.match(html, /mermaid-dialog/);
  assert.match(html, /unused-doc/);

  // Validate inline JS syntax and embedded JSON payload
  const dataMatch = html.match(/<script id="skilltally-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(dataMatch);
  const embedded = JSON.parse(dataMatch[1]);
  assert.equal(embedded.stats.totals.sessions, 1);
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scriptMatches.length, 1);
  assert.doesNotThrow(() => new vm.Script(scriptMatches[0][1]));

  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-dash-'));
  try {
    const dataHome = join(tmp, 'data');
    mkdirSync(dataHome, { recursive: true });
    writeFileSync(join(dataHome, 'events.jsonl'), JSON.stringify(events[0]) + '\n');
    const outFile = join(tmp, 'out', 'dash.html');

    const dashRes = spawnSync(
      process.execPath,
      [cliScript, 'dashboard', '-o', outFile, '--since', 'all', '--json'],
      { encoding: 'utf8', env: { ...process.env, SKILLTALLY_HOME: dataHome } }
    );
    assert.equal(dashRes.status, 0);
    const parsed = JSON.parse(dashRes.stdout);
    assert.equal(parsed.path, outFile);
    assert.equal(existsSync(outFile), true);
    assert.match(readFileSync(outFile, 'utf8'), /skilltally Analytics/);

    const chainsRes = spawnSync(
      process.execPath,
      [cliScript, 'chains', '--since', 'all', '--json'],
      { encoding: 'utf8', env: { ...process.env, SKILLTALLY_HOME: dataHome } }
    );
    assert.equal(chainsRes.status, 0);
    assert.equal(JSON.parse(chainsRes.stdout).totals.sessions, 1);

    const insightsRes = spawnSync(
      process.execPath,
      [cliScript, 'insights', '--since', 'all', '--json'],
      { encoding: 'utf8', env: { ...process.env, SKILLTALLY_HOME: dataHome } }
    );
    assert.equal(insightsRes.status, 0);
    assert.equal(JSON.parse(insightsRes.stdout).totals.sessions, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runPrune previews dry-run, disables 100%-unused plugins & Codex skills with backups, and keeps partially-used plugins', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-prune-'));
  const homeDir = join(tmp, 'home');
  const dataHome = join(tmp, 'data');

  try {
    // Antigravity plugin 1: 100% unused (2 unused skills)
    const unusedP1 = join(homeDir, '.gemini', 'config', 'plugins', 'dead-science', 'skills', 's1');
    const unusedP2 = join(homeDir, '.gemini', 'config', 'plugins', 'dead-science', 'skills', 's2');
    mkdirSync(unusedP1, { recursive: true });
    mkdirSync(unusedP2, { recursive: true });
    writeFileSync(join(unusedP1, 'SKILL.md'), '---\nname: s1\ndescription: ' + 'a'.repeat(200) + '\n---\n');
    writeFileSync(join(unusedP2, 'SKILL.md'), '---\nname: s2\ndescription: ' + 'b'.repeat(200) + '\n---\n');

    // Antigravity plugin 2: partially used (1 used, 1 unused -> must NOT be disabled)
    const partialU = join(homeDir, '.gemini', 'config', 'plugins', 'partial-plug', 'skills', 'used-one');
    const partialUnused = join(homeDir, '.gemini', 'config', 'plugins', 'partial-plug', 'skills', 'unused-two');
    mkdirSync(partialU, { recursive: true });
    mkdirSync(partialUnused, { recursive: true });
    writeFileSync(join(partialU, 'SKILL.md'), '---\nname: used-one\ndescription: Used skill.\n---\n');
    writeFileSync(join(partialUnused, 'SKILL.md'), '---\nname: unused-two\ndescription: Unused skill.\n---\n');

    const agyCfgPath = join(homeDir, '.gemini', 'config', 'config.json');
    mkdirSync(dirname(agyCfgPath), { recursive: true });
    writeFileSync(agyCfgPath, JSON.stringify({ plugins: { 'partial-plug': { enabled: true } } }, null, 2));

    // Codex personal unused skill
    const codexSkillDir = join(homeDir, '.codex', 'skills', 'codex-bloat');
    mkdirSync(codexSkillDir, { recursive: true });
    writeFileSync(
      join(codexSkillDir, 'SKILL.md'),
      '---\nname: codex-bloat\ndescription: ' + 'c'.repeat(400) + '\n---\n'
    );
    const codexTomlPath = join(homeDir, '.codex', 'config.toml');
    writeFileSync(codexTomlPath, 'model = "gpt-5"\n');

    // Event marking 'used-one' as active
    mkdirSync(dataHome, { recursive: true });
    writeFileSync(
      join(dataHome, 'events.jsonl'),
      JSON.stringify({
        v: 1,
        id: 'a:1',
        ts: '2026-11-18T10:00:00Z',
        host: 'antigravity',
        skill: 'used-one',
        session_id: 's1',
        ok: true,
      }) + '\n'
    );

    const now = new Date('2026-11-20T12:00:00.000Z');

    // 1. Dry run must not mutate disk
    const dryRes = runPrune({ homeDir, dataHome, since: '90d', dryRun: true, now });
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.disabledPlugins.length, 1);
    assert.equal(dryRes.disabledPlugins[0].plugin, 'dead-science');
    assert.equal(dryRes.savedTokensPerSession, 100);
    assert.equal(JSON.parse(readFileSync(agyCfgPath, 'utf8')).plugins['dead-science'], undefined);
    assert.equal(existsSync(join(dataHome, 'backups')), false);

    // 2. Live prune disables dead-science and leaves partial-plug untouched
    const livePluginsRes = runPrune({ homeDir, dataHome, since: '90d', dryRun: false, now });
    assert.equal(livePluginsRes.disabledPlugins.length, 1);
    const agyCfgAfter = JSON.parse(readFileSync(agyCfgPath, 'utf8'));
    assert.equal(agyCfgAfter.plugins['dead-science'].enabled, false);
    assert.equal(agyCfgAfter.plugins['partial-plug'].enabled, true);
    assert.equal(readdirSync(join(dataHome, 'backups')).length, 1);

    // 3. Targeted skill prune on Codex
    const skillPruneRes = runPrune({
      homeDir,
      dataHome,
      since: '90d',
      skills: ['codex-bloat'],
      dryRun: false,
      now,
    });
    assert.equal(skillPruneRes.disabledSkills.length, 1);
    assert.equal(skillPruneRes.disabledSkills[0].name, 'codex-bloat');
    const tomlAfter = readFileSync(codexTomlPath, 'utf8');
    assert.match(tomlAfter, /\[\[skills\.config\]\]/);
    assert.match(tomlAfter, /enabled = false/);

    // Verify scanInventory now recognizes both as disabled
    const invAfter = scanInventory({ homeDir, includeProject: false });
    const byName = new Map(invAfter.skills.map((s) => [s.name, s]));
    assert.equal(byName.get('s1').enabled, false);
    assert.equal(byName.get('codex-bloat').enabled, false);
    assert.equal(byName.get('used-one').enabled, true);

    const formatted = formatPrune(livePluginsRes);
    assert.match(formatted, /plugin:dead-science/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('MCP server handles initialize, tools/list, tools/call, and stdio framing via CLI', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-mcp-'));
  const homeDir = join(tmp, 'home');
  const dataHome = join(tmp, 'data');

  try {
    mkdirSync(dataHome, { recursive: true });
    writeFileSync(
      join(dataHome, 'events.jsonl'),
      [
        { v: 1, id: 'm:1', ts: '2026-11-18T10:00:00Z', host: 'claude', skill: 'pdf', via: 'skill_tool', session_id: 's1', project: 'app', ok: true },
        { v: 1, id: 'm:2', ts: '2026-11-18T10:05:00Z', host: 'claude', skill: 'clean-code', via: 'read', session_id: 's1', project: 'app', ok: true },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n'
    );

    const init = handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { dataHome, pkgVersion: '1.1.0', homeDir });
    assert.equal(init.result.serverInfo.name, 'skilltally');
    assert.equal(init.result.serverInfo.version, '1.1.0');

    assert.equal(handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, { dataHome, homeDir }), null);

    const list = handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { dataHome, homeDir });
    const toolNames = list.result.tools.map((t) => t.name);
    assert.deepEqual(toolNames, [
      'skilltally_stats',
      'skilltally_unused',
      'skilltally_timeline',
      'skilltally_chains',
      'skilltally_insights',
    ]);

    for (const [idx, name] of toolNames.entries()) {
      const res = handleMcpRequest(
        { jsonrpc: '2.0', id: 10 + idx, method: 'tools/call', params: { name, arguments: { since: 'all' } } },
        { dataHome, homeDir }
      );
      assert.equal(Boolean(res.result.isError), false);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.ok(parsed.window);
    }

    // End-to-end stdio invocation with newline-delimited AND Content-Length framed messages
    const msg1 = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const msg2 = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'skilltally_chains', arguments: { since: 'all' } } });
    const stdinPayload =
      `Content-Length: ${Buffer.byteLength(msg1, 'utf8')}\r\n\r\n${msg1}` +
      `${msg2}\n`;

    const cliRes = spawnSync(process.execPath, [cliScript, 'mcp'], {
      input: stdinPayload,
      encoding: 'utf8',
      env: { ...process.env, SKILLTALLY_HOME: dataHome, HOME: homeDir, USERPROFILE: homeDir },
    });
    assert.equal(cliRes.status, 0);
    assert.match(cliRes.stdout, /Content-Length:/);
    assert.match(cliRes.stdout, /"serverInfo":\{"name":"skilltally"/);
    assert.match(cliRes.stdout, /\\"from\\": \\"pdf\\"/);
    assert.match(cliRes.stdout, /\\"to\\": \\"clean-code\\"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sanitizePromptPreview, extractUsageMetrics, backfillClaude, aggregateStats, and dashboard handle v1.2.0 telemetry', () => {
  // 1. Prompt sanitization redacts secrets, emails, paths, and skill wrappers
  const raw =
    '<SKILL>read and use the "pdf" skill. The path to the skill file is: /Users/alice/.gemini/skills/pdf/SKILL.md</SKILL> ' +
    'Parse /Users/alice/docs/secret.pdf with sk-ant-api03-secretkey1234567890 for alice@example.com';
  const clean = sanitizePromptPreview(raw, 120);
  assert.doesNotMatch(clean, /<SKILL>/);
  assert.doesNotMatch(clean, /sk-ant-api03/);
  assert.doesNotMatch(clean, /alice@example\.com/);
  assert.doesNotMatch(clean, /\/Users\/alice/);
  assert.match(clean, /\[PATH\]/);
  assert.match(clean, /\[REDACTED\]/);
  assert.match(clean, /\[EMAIL\]/);

  // 2. extractUsageMetrics normalizes Claude, Codex, and Gemini payloads
  assert.deepEqual(
    extractUsageMetrics({
      input_tokens: 1200,
      output_tokens: 400,
      cache_read_input_tokens: 4800,
      cache_creation_input_tokens: 200,
    }),
    {
      input_tokens: 1200,
      output_tokens: 400,
      cache_read_tokens: 4800,
      cache_creation_tokens: 200,
      total_tokens: 6600,
    }
  );
  assert.deepEqual(
    extractUsageMetrics({
      input_tokens: 1000,
      cached_input_tokens: 800,
      output_tokens: 200,
      total_tokens: 1200,
    }),
    {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 800,
      cache_creation_tokens: 0,
      total_tokens: 1200,
    }
  );
  assert.equal(extractUsageMetrics({}), null);

  // 3. Claude backfill extracts usage, duration_seconds, and redacted prompt_preview
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-v120-'));
  const homeDir = join(tmp, 'home');
  const dataHome = join(tmp, 'data');

  try {
    const projDir = join(homeDir, '.claude', 'projects', 'demo');
    mkdirSync(projDir, { recursive: true });
    const sessionLines = [
      JSON.stringify({
        type: 'user',
        sessionId: 'sess-tok-1',
        cwd: '/Users/tester/app',
        timestamp: '2026-11-18T10:00:00.000Z',
        message: { role: 'user', content: 'Review PR for user@example.com with sk-1234567890abcdef' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-tok-1',
        cwd: '/Users/tester/app',
        timestamp: '2026-11-18T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4',
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 8500,
            cache_creation_input_tokens: 500,
          },
          content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'code-review' } }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-tok-1',
        cwd: '/Users/tester/app',
        timestamp: '2026-11-18T10:02:35.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      }),
    ].join('\n');
    writeFileSync(join(projDir, 'sess-tok-1.jsonl'), sessionLines + '\n');

    // Heavy skill body in inventory (>= 1500 body_tokens)
    const heavySkillDir = join(homeDir, '.claude', 'skills', 'heavy-guide');
    mkdirSync(heavySkillDir, { recursive: true });
    writeFileSync(
      join(heavySkillDir, 'SKILL.md'),
      '---\nname: heavy-guide\ndescription: Large guide.\n---\n' + 'word '.repeat(1600)
    );

    const bfOff = backfillClaude({ homeDir, storePrompts: false });
    assert.equal(bfOff.events.length, 1);
    assert.equal(bfOff.events[0].prompt_preview, undefined);
    assert.equal(bfOff.events[0].duration_seconds, 150);
    assert.equal(bfOff.events[0].cache_read_tokens, 8500);
    assert.equal(bfOff.events[0].total_tokens, 10500);

    const bfOn = backfillClaude({ homeDir, storePrompts: true });
    assert.equal(bfOn.events.length, 1);
    assert.match(bfOn.events[0].prompt_preview, /Review PR for \[EMAIL\] with \[REDACTED\]/);

    // Live hook tail reader with store_prompts=true in SKILLTALLY_HOME/config.json
    mkdirSync(dataHome, { recursive: true });
    writeFileSync(join(dataHome, 'config.json'), JSON.stringify({ store_prompts: true }));
    const hookPayload = JSON.stringify({
      session_id: 'sess-tok-1',
      tool_use_id: 'tu_live_1',
      tool_name: 'Skill',
      tool_input: { skill: 'heavy-guide' },
      transcript_path: join(projDir, 'sess-tok-1.jsonl'),
      cwd: '/Users/tester/app',
    });
    const trackRes = spawnSync(process.execPath, [join(root, 'bin', 'track.mjs'), '--host', 'claude'], {
      input: hookPayload,
      encoding: 'utf8',
      env: { ...process.env, SKILLTALLY_HOME: dataHome, HOME: homeDir, USERPROFILE: homeDir },
    });
    assert.equal(trackRes.status, 0);
    const liveEv = JSON.parse(readFileSync(join(dataHome, 'events.jsonl'), 'utf8').trim().split('\n')[0]);
    assert.equal(liveEv.total_tokens, 10500);
    assert.match(liveEv.prompt_preview, /Review PR for \[EMAIL\]/);

    // 4. aggregateStats + formatInsights + dashboard rendering
    const inv = scanInventory({ homeDir, includeProject: false });
    const heavyEntry = inv.skills.find((s) => s.name === 'heavy-guide');
    assert.ok(heavyEntry.body_tokens >= 1500);

    const now = new Date('2026-11-20T12:00:00.000Z');
    const report = aggregateStats({
      events: [...bfOn.events, liveEv],
      inventory: inv,
      since: '30d',
      now,
    });
    assert.equal(report.totals.tokens.total, 21000);
    assert.equal(report.totals.tokens.cacheHitRate, 0.85);
    assert.equal(report.totals.tokens.lifetimeTokens, 21000);
    assert.equal(report.totals.tokens.peakSessionTokens, 21000);
    assert.ok(report.totals.duration.longestTaskSeconds >= 150);
    assert.equal(report.insights.heavyBodySkills.length, 1);
    assert.equal(report.insights.heavyBodySkills[0].skill, 'heavy-guide');
    assert.equal(report.insights.slowestSkills[0].skill, 'code-review');
    assert.equal(report.insights.promptPatterns.length, 1);

    const insightsTxt = formatInsights(report);
    assert.match(insightsTxt, /Token Telemetry & Heavy SKILL\.md Bodies/);
    assert.match(insightsTxt, /cache hit: 85%/);
    assert.match(insightsTxt, /Skill Execution Duration/);
    assert.match(insightsTxt, /Common Prompt Triggers/);

    const timeline = buildTimeline({ events: bfOn.events, inventory: inv, by: 'day', since: '30d', now });
    const chains = buildChains({ events: bfOn.events, inventory: inv, since: '30d', now });
    const html = generateDashboardHtml({ stats: report, timeline, dailyTimeline: timeline, chains, inventory: inv });
    assert.match(html, /Lifetime tokens/);
    assert.match(html, /Peak tokens/);
    assert.match(html, /Longest task/);
    assert.match(html, /Longest streak/);
    assert.match(html, /Current streak/);
    assert.match(html, /Total skill reads/);
    assert.doesNotMatch(html, /Total skills used/);
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch);
    assert.doesNotThrow(() => new vm.Script(scriptMatch[1]));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanInventory handles .system, semver sort, duplicate marketplaces, and aggregateStats fixes token/cache/duration/used inflation', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-audit-agg-'));
  const homeDir = join(tmp, 'home');
  try {
    // Nested .system skill + multi-version Codex cache + orphan plugin-install + duplicate marketplace
    const sysSkill = join(homeDir, '.codex', 'skills', '.system', 'review-agent');
    mkdirSync(sysSkill, { recursive: true });
    writeFileSync(join(sysSkill, 'SKILL.md'), '---\nname: review-agent\ndescription: System reviewer.\n---\n');

    const v09 = join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated-remote', 'my-plugin', '0.1.9', 'skills', 's-ver');
    const v11 = join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated-remote', 'my-plugin', '0.1.11', 'skills', 's-ver');
    mkdirSync(v09, { recursive: true });
    mkdirSync(v11, { recursive: true });
    writeFileSync(join(v09, 'SKILL.md'), '---\nname: s-ver\ndescription: Old version description.\n---\n');
    writeFileSync(join(v11, 'SKILL.md'), '---\nname: s-ver\ndescription: ' + 'n'.repeat(400) + '\n---\n');

    // Explicitly disabled in @plugins-cli, stale copy in @google-labs-code-stitch-skills, plus orphan staging dir
    const cliStitch = join(homeDir, '.codex', 'plugins', 'cache', 'plugins-cli', 'stitch-build', '1.0.0', 'skills', 'stitch-build');
    const dupStitch = join(homeDir, '.codex', 'plugins', 'cache', 'google-labs-code-stitch-skills', 'stitch-build', 'abc', 'skills', 'stitch-build');
    const orphanTmp = join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'plugin-install-5UJ2x0', 'web', 'skills', 'ghost');
    mkdirSync(cliStitch, { recursive: true });
    mkdirSync(dupStitch, { recursive: true });
    mkdirSync(orphanTmp, { recursive: true });
    writeFileSync(join(cliStitch, 'SKILL.md'), '---\nname: stitch-build\ndescription: Stitch.\n---\n');
    writeFileSync(join(dupStitch, 'SKILL.md'), '---\nname: stitch-build\ndescription: Stitch dup.\n---\n');
    writeFileSync(join(orphanTmp, 'SKILL.md'), '---\nname: ghost\ndescription: Orphan.\n---\n');

    // Same skill installed both as personal and in plugin -> usedInstalledCount should not double-count
    const persReview = join(homeDir, '.agents', 'skills', 'review-agent');
    mkdirSync(persReview, { recursive: true });
    writeFileSync(join(persReview, 'SKILL.md'), '---\nname: review-agent\ndescription: Duplicate personal copy.\n---\n');

    writeFileSync(
      join(homeDir, '.codex', 'config.toml'),
      '[plugins."stitch-build@plugins-cli"]\nenabled = false\n'
    );

    const inv = scanInventory({ homeDir, includeProject: false });
    const enabledNames = inv.skills.filter((s) => s.enabled).map((s) => s.name);
    assert.equal(inv.skills.find((s) => s.name === 's-ver').est_tokens, 100); // picked 0.1.11 over 0.1.9
    assert.equal(enabledNames.includes('ghost'), false);
    assert.equal(inv.skills.filter((s) => s.dir_name === 'stitch-build').length, 1);
    assert.equal(inv.skills.find((s) => s.dir_name === 'stitch-build').enabled, false);
    assert.ok(inv.index.byPath.has(realpathSync(join(dupStitch, 'SKILL.md')).replace(/\\/g, '/')));
    assert.ok(inv.index.bySkillAndSource.has('review-agent\0personal'));

    // Events: 2 skills read in the exact same Codex turn sharing identical token snapshot & overlapping duration
    const events = [
      {
        v: 1,
        id: 'cx:s1:c1#0',
        ts: '2026-11-18T10:00:00Z',
        host: 'codex',
        skill: 's-ver',
        source: 'plugin:my-plugin',
        session_id: 's1',
        duration_seconds: 60,
        input_tokens: 10000,
        cache_read_tokens: 9600,
        output_tokens: 200,
        total_tokens: 10200,
        origin: 'backfill',
        ok: true,
      },
      {
        v: 1,
        id: 'cx:s1:c2#0',
        ts: '2026-11-18T10:00:10Z',
        host: 'codex',
        skill: 'review-agent',
        skill_path: join(sysSkill, 'SKILL.md'),
        source: 'personal',
        session_id: 's1',
        duration_seconds: 50,
        input_tokens: 10000,
        cache_read_tokens: 9600,
        output_tokens: 200,
        total_tokens: 10200,
        origin: 'backfill',
        ok: true,
      },
    ];

    const now = new Date('2026-11-20T12:00:00.000Z');
    const report = aggregateStats({ events, inventory: inv, since: '30d', now });
    assert.equal(report.totals.tokens.total, 10200); // deduped across same turn, NOT 20400
    assert.equal(report.totals.tokens.cacheHitRate, 0.96); // 9600 / 10000, NOT 0.49
    assert.equal(report.totals.duration.totalSeconds, 60); // merged [0..60s] and [10..60s], NOT 110s
    assert.equal(report.totals.duration.longestTaskSeconds, 60);
    assert.ok(report.inventory.used <= report.totals.uniqueSkills); // does not double-count both review-agent paths
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
