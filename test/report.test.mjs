import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter, scanInventory } from '../src/inventory/scan.mjs';
import { aggregateStats, parseSince } from '../src/report/aggregate.mjs';
import { formatStats, formatUnused } from '../src/report/format.mjs';

test('parseFrontmatter extracts name and folded/literal/quoted descriptions', () => {
  const md1 = `---
name: swarm
description: >-
  Run a swarm of agents
  collaborating together.
metadata:
  icon: hub
---
# Body`;
  assert.deepEqual(parseFrontmatter(md1), {
    name: 'swarm',
    description: 'Run a swarm of agents collaborating together.',
  });

  const md2 = `---
name: "quoted-skill"
description: |
  Line one.
  Line two.
---`;
  assert.deepEqual(parseFrontmatter(md2), {
    name: 'quoted-skill',
    description: 'Line one.\nLine two.',
  });
});

test('scanInventory detects disabled plugins/skills, merges symlinks, and computes Context Tax', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-inv-test-'));
  const homeDir = join(tmp, 'home');
  const cwd = join(tmp, 'workspace');

  try {
    // Active plugin with skill whose frontmatter name differs from folder name
    const swarmSkill = join(homeDir, '.gemini', 'config', 'plugins', 'core', 'skills', 'native_swarm');
    mkdirSync(swarmSkill, { recursive: true });
    writeFileSync(
      join(swarmSkill, 'SKILL.md'),
      '---\nname: swarm\ndescription: Coordinate parallel workers across tasks.\n---\n'
    );

    // Disabled Antigravity plugin via config.json
    const offSkill = join(homeDir, '.gemini', 'config', 'plugins', 'off-plugin', 'skills', 'hidden-skill');
    mkdirSync(offSkill, { recursive: true });
    writeFileSync(join(offSkill, 'SKILL.md'), '---\nname: hidden-skill\ndescription: Disabled plugin skill.\n---\n');
    writeFileSync(
      join(homeDir, '.gemini', 'config', 'config.json'),
      JSON.stringify({ plugins: { 'off-plugin': { enabled: false } } })
    );

    // Personal skill + symlink in ~/.agents/skills pointing to plugin skill
    const personalSkill = join(homeDir, '.agents', 'skills', 'unused-personal');
    mkdirSync(personalSkill, { recursive: true });
    writeFileSync(
      join(personalSkill, 'SKILL.md'),
      '---\nname: unused-personal\ndescription: ' + 'x'.repeat(200) + '\n---\n'
    );
    symlinkSync(
      swarmSkill,
      join(homeDir, '.agents', 'skills', 'native_swarm'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    // Disabled personal skill in Codex config.toml
    const disabledCodex = join(homeDir, '.codex', 'skills', 'hatch-pet');
    mkdirSync(disabledCodex, { recursive: true });
    writeFileSync(join(disabledCodex, 'SKILL.md'), '---\nname: hatch-pet\ndescription: Pet.\n---\n');
    writeFileSync(
      join(homeDir, '.codex', 'config.toml'),
      `[[skills.config]]\npath = "${join(disabledCodex, 'SKILL.md').replace(/\\/g, '/')}"\nenabled = false\n`
    );

    // Project skill
    const projSkill = join(cwd, '.agents', 'skills', 'repo-local');
    mkdirSync(projSkill, { recursive: true });
    writeFileSync(join(projSkill, 'SKILL.md'), '---\nname: repo-local\ndescription: Project only.\n---\n');

    const inv = scanInventory({ homeDir, cwd, includeProject: true });
    const byName = new Map(inv.skills.map((s) => [s.name, s]));

    assert.equal(byName.get('swarm').source, 'plugin:core');
    assert.deepEqual(byName.get('swarm').hosts.sort(), ['antigravity', 'codex']);
    assert.equal(byName.get('swarm').enabled, true);

    assert.equal(byName.get('hidden-skill').enabled, false);
    assert.equal(byName.get('hatch-pet').enabled, false);
    assert.equal(byName.get('repo-local').source, 'project');
    assert.equal(byName.get('unused-personal').est_tokens, 50);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('aggregateStats handles activations vs reads, soft dedupe, aliases, Context Tax, and parseSince', () => {
  const now = new Date('2026-11-19T12:00:00.000Z');
  assert.equal(parseSince('all', now), null);
  assert.equal(parseSince('7d', now).toISOString(), '2026-11-12T12:00:00.000Z');
  assert.equal(parseSince('2026-01-01', now).toISOString(), '2026-01-01T00:00:00.000Z');
  assert.throws(() => parseSince('bogus', now));

  const inventory = {
    skills: [
      { name: 'brainstorming', dir_name: 'brainstorming', path: '/p/brainstorming/SKILL.md', source: 'plugin:superpowers', hosts: ['claude', 'antigravity'], desc_chars: 100, est_tokens: 25, enabled: true },
      { name: 'unused-a', dir_name: 'unused-a', path: '/p/unused-a/SKILL.md', source: 'plugin:science', hosts: ['antigravity'], desc_chars: 400, est_tokens: 100, enabled: true },
      { name: 'disabled-b', dir_name: 'disabled-b', path: '/p/disabled-b/SKILL.md', source: 'plugin:off', hosts: ['antigravity'], desc_chars: 400, est_tokens: 100, enabled: false },
    ],
    index: {
      byPath: new Map([['/p/brainstorming/SKILL.md', { name: 'brainstorming', source: 'plugin:superpowers' }]]),
      byDirName: new Map([['brainstorming', { name: 'brainstorming', source: 'plugin:superpowers' }]]),
      byName: new Map([['brainstorming', { name: 'brainstorming', source: 'plugin:superpowers' }]]),
    },
  };

  const events = [
    // Claude Skill + Read within 2s -> should soft-dedupe into 1 read / 1 activation
    { v: 1, id: 'claude:s1:u1#0', ts: '2026-11-18T10:00:00Z', host: 'claude', skill: 'brainstorming', source: 'plugin:superpowers', session_id: 's1', origin: 'hook', ok: true },
    { v: 1, id: 'claude:s1:u2#0', ts: '2026-11-18T10:00:01Z', host: 'claude', skill: 'brainstorming', skill_path: '/p/brainstorming/SKILL.md', source: 'plugin:superpowers', session_id: 's1', origin: 'hook', ok: true },
    // Same session later -> 2nd read, still 1 activation
    { v: 1, id: 'claude:s1:u3#0', ts: '2026-11-18T10:05:00Z', host: 'claude', skill: 'brain_alias', source: 'unknown', session_id: 's1', origin: 'hook', ok: true },
    // Second session on Antigravity -> 2nd activation
    { v: 1, id: 'antigravity:s2:step1#0', ts: '2026-11-18T11:00:00Z', host: 'antigravity', skill: 'brainstorming', session_id: 's2', origin: 'backfill', ok: true },
    // Failed event -> ignored
    { v: 1, id: 'codex:s3:c1#0', ts: '2026-11-18T12:00:00Z', host: 'codex', skill: 'unused-a', session_id: 's3', origin: 'backfill', ok: false },
    // Old event outside 30d -> ignored
    { v: 1, id: 'codex:s4:c2#0', ts: '2026-09-01T12:00:00Z', host: 'codex', skill: 'unused-a', session_id: 's4', origin: 'backfill', ok: true },
  ];

  const report = aggregateStats({
    events,
    inventory,
    config: { aliases: { brain_alias: 'brainstorming' } },
    since: '30d',
    now,
  });

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].skill, 'brainstorming');
  assert.equal(report.rows[0].activations, 2);
  assert.equal(report.rows[0].reads, 3);
  assert.equal(report.inventory.enabled, 2);
  assert.equal(report.inventory.disabled, 1);
  assert.equal(report.inventory.used, 1);
  assert.equal(report.inventory.unused, 1);
  assert.equal(report.unused.totalEstTokens, 100);

  const statsOut = formatStats(report);
  assert.match(statsOut, /brainstorming/);
  const unusedOut = formatUnused(report);
  assert.match(unusedOut, /plugin:science/);
  assert.match(unusedOut, /~.*100 tok\/session/);
});
