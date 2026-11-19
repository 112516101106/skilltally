import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAntigravity, uninstallAntigravity } from '../src/install/antigravity.mjs';
import { installClaude, uninstallClaude } from '../src/install/claude.mjs';
import { checkCodexHookTrust, installCodex, uninstallCodex } from '../src/install/codex.mjs';
import { installGemini, uninstallGemini } from '../src/install/gemini.mjs';
import { runDoctor } from '../src/install/doctor.mjs';
import { runInstall, runUninstall } from '../src/install/index.mjs';
import { getPackageRoot } from '../src/install/runtime.mjs';

const pkgRoot = getPackageRoot();

test('Antigravity install/uninstall preserves dev symlinks, skips config.json, and handles dry-run', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-agy-inst-'));
  const homeDir = join(tmp, 'home');
  try {
    mkdirSync(join(homeDir, '.gemini', 'config', 'plugins'), { recursive: true });
    const cfgPath = join(homeDir, '.gemini', 'config', 'config.json');
    const initialCfg = JSON.stringify({ plugins: {}, userSettings: { theme: 'dark' } });
    writeFileSync(cfgPath, initialCfg);

    const dry = installAntigravity({ homeDir, pkgRoot, dryRun: true });
    assert.equal(dry.status, 'installed');
    assert.equal(existsSync(dry.target), false);

    const inst = installAntigravity({ homeDir, pkgRoot, dryRun: false });
    assert.equal(inst.status, 'installed');
    assert.equal(inst.mode, 'plugin');
    assert.equal(existsSync(join(inst.target, '.skilltally-managed')), true);
    assert.equal(existsSync(join(inst.target, 'hooks.json')), true);
    assert.equal(readFileSync(cfgPath, 'utf8'), initialCfg);

    const upd = installAntigravity({ homeDir, pkgRoot, dryRun: false });
    assert.equal(upd.status, 'updated');

    const uninst = uninstallAntigravity({ homeDir });
    assert.equal(uninst.status, 'uninstalled');
    assert.equal(existsSync(inst.target), false);

    // Symlink preservation & safe unlink (does NOT delete pkgRoot)
    symlinkSync(pkgRoot, inst.target);
    const symInst = installAntigravity({ homeDir, pkgRoot });
    assert.equal(symInst.status, 'unchanged');
    assert.equal(symInst.mode, 'symlink');
    assert.equal(lstatSync(inst.target).isSymbolicLink(), true);

    const symUninst = uninstallAntigravity({ homeDir });
    assert.equal(symUninst.status, 'uninstalled');
    assert.equal(symUninst.mode, 'symlink');
    assert.equal(existsSync(join(pkgRoot, 'package.json')), true);
    assert.equal(readFileSync(cfgPath, 'utf8'), initialCfg);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Claude Code install/uninstall creates backup, stays idempotent, respects plugin skip & --force', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-cc-inst-'));
  const homeDir = join(tmp, 'home');
  const dataHome = join(tmp, 'data');
  try {
    const claudeDir = join(homeDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: 'dark',
        hooks: {
          PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
        },
      })
    );

    const r1 = installClaude({ homeDir, dataHome, pkgRoot });
    assert.equal(r1.status, 'installed');
    assert.ok(r1.backup && existsSync(r1.backup));
    assert.equal(existsSync(join(dataHome, 'runtime', 'track.mjs')), true);

    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(saved.theme, 'dark');
    assert.equal(saved.hooks.PostToolUse.length, 2);

    // Idempotent 2nd run
    const r2 = installClaude({ homeDir, dataHome, pkgRoot });
    assert.equal(r2.status, 'unchanged');

    // Uninstall removes only skilltally hook and keeps user hook
    const u1 = uninstallClaude({ homeDir, dataHome });
    assert.equal(u1.status, 'uninstalled');
    assert.equal(u1.removedCount, 1);
    const afterUninstall = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(afterUninstall.hooks.PostToolUse.length, 1);
    assert.equal(afterUninstall.hooks.PostToolUse[0].matcher, 'Edit');

    // Plugin-installed skip & --force override
    mkdirSync(join(claudeDir, 'plugins', 'cache', 'skilltally', 'skilltally', '0.2.0'), { recursive: true });
    const skipped = installClaude({ homeDir, dataHome, pkgRoot });
    assert.equal(skipped.status, 'skipped');
    const forced = installClaude({ homeDir, dataHome, pkgRoot, force: true });
    assert.equal(forced.status, 'installed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Codex install/uninstall preserves hooks, checks trust status, and cleans up cleanly', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-cx-inst-'));
  const homeDir = join(tmp, 'home');
  const dataHome = join(tmp, 'data');
  try {
    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    const hooksPath = join(homeDir, '.codex', 'hooks.json');
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        },
      })
    );

    const r1 = installCodex({ homeDir, dataHome, pkgRoot });
    assert.equal(r1.status, 'installed');
    assert.ok(r1.note && r1.note.includes('/hooks'));
    assert.equal(checkCodexHookTrust(homeDir), 'untrusted');

    writeFileSync(
      join(homeDir, '.codex', 'config.toml'),
      '[hooks.state."user:hooks.json:post_tool_use:0:0"]\ntrusted_hash = "sha256:abc"\n'
    );
    assert.equal(checkCodexHookTrust(homeDir), 'trusted');

    const r2 = installCodex({ homeDir, dataHome, pkgRoot });
    assert.equal(r2.status, 'unchanged');

    const u1 = uninstallCodex({ homeDir, dataHome });
    assert.equal(u1.status, 'uninstalled');
    const after = JSON.parse(readFileSync(hooksPath, 'utf8'));
    assert.equal(after.hooks.PostToolUse, undefined);
    assert.equal(after.hooks.SessionStart.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runInstall, runUninstall --purge, and runDoctor handle multi-host lifecycle & warnings', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-lifecycle-'));
  const homeDir = join(tmp, 'home');
  const dataHome = join(tmp, 'data');
  try {
    // Explicit missing host returns exitCode 2
    const missing = runInstall({ homeDir, dataHome, pkgRoot, host: 'claude' });
    assert.equal(missing.exitCode, 2);
    assert.equal(missing.results[0].status, 'not_detected');

    // Setup Antigravity + Claude dirs, leave Codex absent
    mkdirSync(join(homeDir, '.gemini', 'config', 'plugins'), { recursive: true });
    mkdirSync(join(homeDir, '.claude'), { recursive: true });

    const allDry = runInstall({ homeDir, dataHome, pkgRoot, host: 'all', dryRun: true });
    assert.equal(allDry.exitCode, 0);
    assert.equal(allDry.results.find((r) => r.host === 'codex').status, 'not_detected');
    assert.equal(existsSync(dataHome), false);

    const allInst = runInstall({ homeDir, dataHome, pkgRoot, host: 'all' });
    assert.equal(allInst.exitCode, 0);
    assert.equal(allInst.results.find((r) => r.host === 'antigravity').status, 'installed');
    assert.equal(allInst.results.find((r) => r.host === 'claude').status, 'installed');
    assert.equal(allInst.results.find((r) => r.host === 'codex').status, 'not_detected');

    const doc1 = runDoctor({ homeDir, dataHome, pkgRoot });
    assert.equal(doc1.ok, true);
    assert.equal(doc1.selfTest.ok, true);
    assert.equal(doc1.hosts.antigravity.installed, true);
    assert.equal(doc1.hosts.antigravity.hookPathValid, true);
    assert.equal(doc1.hosts.claude.installed, true);
    assert.equal(doc1.hosts.claude.duplicateHook, false);

    // Simulate duplicate hook on Claude (plugin + settings)
    mkdirSync(join(homeDir, '.claude', 'plugins', 'skilltally'), { recursive: true });
    const docDup = runDoctor({ homeDir, dataHome, pkgRoot });
    assert.equal(docDup.hosts.claude.duplicateHook, true);

    // Simulate broken path on Claude hook -> doctor should fail
    writeFileSync(
      join(homeDir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Skill|Read',
              hooks: [{ type: 'command', command: 'node "/nonexistent/skilltally/track.mjs" --host claude', statusMessage: 'skilltally' }],
            },
          ],
        },
      })
    );
    const docBroken = runDoctor({ homeDir, dataHome, pkgRoot });
    assert.equal(docBroken.ok, false);
    assert.equal(docBroken.hosts.claude.hookPathValid, false);

    // Uninstall with --purge cleans up dataHome completely
    const uninst = runUninstall({ homeDir, dataHome, host: 'all', purge: true });
    assert.equal(uninst.purged, true);
    assert.equal(existsSync(dataHome), false);
    assert.equal(readdirSync(join(homeDir, '.gemini', 'config', 'plugins')).length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Gemini CLI install/uninstall preserves settings, uses 5000ms AfterTool hook, and reports hooksConfig.enabled=false', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skilltally-gem-inst-'));
  const homeDir = join(tmp, 'home');
  const dataHome = join(tmp, 'data');
  try {
    mkdirSync(join(homeDir, '.gemini'), { recursive: true });
    const settingsPath = join(homeDir, '.gemini', 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: 'Default',
        mcpServers: { myServer: { command: 'node' } },
        hooksConfig: { enabled: false },
        hooks: {
          AfterTool: [{ matcher: 'write_file', hooks: [{ name: 'user-lint', type: 'command', command: 'echo lint' }] }],
        },
      })
    );

    const r1 = installGemini({ homeDir, dataHome, pkgRoot });
    assert.equal(r1.status, 'installed');
    assert.ok(r1.backup && existsSync(r1.backup));
    assert.ok(r1.note && r1.note.includes('hooksConfig.enabled'));

    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(saved.theme, 'Default');
    assert.deepEqual(saved.mcpServers, { myServer: { command: 'node' } });
    assert.equal(saved.hooks.AfterTool.length, 2);
    const skilltallyGroup = saved.hooks.AfterTool.find((g) => g.matcher === 'activate_skill');
    assert.equal(skilltallyGroup.hooks[0].timeout, 5000);
    assert.equal(skilltallyGroup.hooks[0].name, 'skilltally');

    // Idempotent 2nd run
    const r2 = installGemini({ homeDir, dataHome, pkgRoot });
    assert.equal(r2.status, 'unchanged');

    // Doctor reports Gemini installed & hooksConfigDisabled=true
    const doc = runDoctor({ homeDir, dataHome, pkgRoot });
    assert.equal(doc.ok, true);
    assert.equal(doc.hosts.gemini.detected, true);
    assert.equal(doc.hosts.gemini.installed, true);
    assert.equal(doc.hosts.gemini.hookPathValid, true);
    assert.equal(doc.hosts.gemini.hooksConfigDisabled, true);

    // Uninstall removes only skilltally AfterTool hook
    const u1 = uninstallGemini({ homeDir, dataHome });
    assert.equal(u1.status, 'uninstalled');
    assert.equal(u1.removedCount, 1);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(after.hooks.AfterTool.length, 1);
    assert.equal(after.hooks.AfterTool[0].matcher, 'write_file');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
