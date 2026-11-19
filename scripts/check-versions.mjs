#!/usr/bin/env node
/**
 * Ensures package.json and all present plugin/extension manifests stay on the same version,
 * and ensures hooks/hooks.json is never created (avoids Claude Code / Gemini CLI collision).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expected = pkg.version;

if (!expected) {
  console.error('package.json missing version');
  process.exit(1);
}

if (existsSync(join(root, 'hooks', 'hooks.json'))) {
  console.error('Forbidden file hooks/hooks.json exists (collides between Claude Code and Gemini CLI)');
  process.exit(1);
}

const candidates = [
  'plugin.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  'gemini-extension.json',
];

const mismatches = [];
const checked = [];

for (const rel of candidates) {
  const full = join(root, rel);
  if (!existsSync(full)) continue;
  const data = JSON.parse(readFileSync(full, 'utf8'));
  checked.push(rel);
  if (data.version !== expected) {
    mismatches.push(`${rel}: found ${JSON.stringify(data.version)}, expected ${JSON.stringify(expected)}`);
  }
}

const claudeMktPath = join(root, '.claude-plugin', 'marketplace.json');
if (existsSync(claudeMktPath)) {
  const mkt = JSON.parse(readFileSync(claudeMktPath, 'utf8'));
  checked.push('.claude-plugin/marketplace.json');
  for (const [idx, entry] of (mkt.plugins || []).entries()) {
    if (entry.version !== expected) {
      mismatches.push(
        `.claude-plugin/marketplace.json plugins[${idx}]: found ${JSON.stringify(entry.version)}, expected ${JSON.stringify(expected)}`
      );
    }
  }
}

if (mismatches.length > 0) {
  console.error('Version mismatch:\n' + mismatches.join('\n'));
  process.exit(1);
}

console.log(`Version OK (${expected}) across package.json and ${checked.join(', ')}`);
