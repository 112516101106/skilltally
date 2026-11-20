import { homedir } from 'node:os';
import { getHomeDir, loadConfig } from '../core/config.mjs';
import { canonicalizeEvent, dedupeEvents } from '../core/normalize.mjs';
import { writeBackfillEvents } from '../core/store.mjs';
import { scanInventory } from '../inventory/scan.mjs';
import { backfillAntigravity } from './antigravity.mjs';
import { backfillClaude } from './claude.mjs';
import { backfillCodex } from './codex.mjs';
import { backfillGemini } from './gemini.mjs';

export function runBackfill({
  homeDir = homedir(),
  dataHome = getHomeDir(),
  host = 'all',
  since = null,
  dryRun = false,
} = {}) {
  const hostsSummary = {};
  const collected = [];
  const config = loadConfig(dataHome);
  const storePrompts = Boolean(config.store_prompts);
  const aliases = config.aliases || {};
  const inv = scanInventory({ homeDir, includeProject: false });

  const canonicalizeList = (list) => list.map((e) => canonicalizeEvent(e, inv.index, aliases));

  const wantAgy = host === 'all' || String(host).startsWith('antigravity');
  const wantCodex = host === 'all' || host === 'codex';
  const wantClaude = host === 'all' || host === 'claude';
  const wantGemini = host === 'all' || host === 'gemini';

  if (wantAgy) {
    const res = backfillAntigravity({ homeDir, since, storePrompts });
    const filtered = canonicalizeList(
      host === 'all' || host === 'antigravity'
        ? res.events
        : res.events.filter((e) => e.host === host)
    );
    collected.push(...filtered);
    hostsSummary.antigravity = {
      files: res.files,
      events: filtered.length,
      uniqueSkills: new Set(filtered.map((e) => e.skill)).size,
    };
  }

  if (wantCodex) {
    const res = backfillCodex({ homeDir, since, storePrompts });
    const canon = canonicalizeList(res.events);
    collected.push(...canon);
    hostsSummary.codex = {
      files: res.files,
      events: canon.length,
      uniqueSkills: new Set(canon.map((e) => e.skill)).size,
      skippedZst: res.skippedZst,
    };
  }

  if (wantClaude) {
    const res = backfillClaude({ homeDir, since, storePrompts });
    const canon = canonicalizeList(res.events);
    collected.push(...canon);
    hostsSummary.claude = {
      files: res.files,
      events: canon.length,
      uniqueSkills: new Set(canon.map((e) => e.skill)).size,
    };
  }

  if (wantGemini) {
    const res = backfillGemini({ homeDir, since, storePrompts });
    const canon = canonicalizeList(res.events);
    collected.push(...canon);
    hostsSummary.gemini = {
      files: res.files,
      events: canon.length,
      uniqueSkills: new Set(canon.map((e) => e.skill)).size,
    };
  }

  const events = dedupeEvents(collected);
  let outputPath = null;
  if (!dryRun) {
    outputPath = writeBackfillEvents(dataHome, events);
  }

  return {
    totalEvents: events.length,
    uniqueSkills: new Set(events.map((e) => e.skill)).size,
    dryRun,
    outputPath,
    hosts: hostsSummary,
  };
}
