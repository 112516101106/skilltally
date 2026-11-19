import { homedir } from 'node:os';
import { getHomeDir } from '../core/config.mjs';
import { dedupeEvents } from '../core/normalize.mjs';
import { writeBackfillEvents } from '../core/store.mjs';
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

  const wantAgy = host === 'all' || String(host).startsWith('antigravity');
  const wantCodex = host === 'all' || host === 'codex';
  const wantClaude = host === 'all' || host === 'claude';
  const wantGemini = host === 'all' || host === 'gemini';

  if (wantAgy) {
    const res = backfillAntigravity({ homeDir, since });
    const filtered =
      host === 'all' || host === 'antigravity'
        ? res.events
        : res.events.filter((e) => e.host === host);
    collected.push(...filtered);
    hostsSummary.antigravity = {
      files: res.files,
      events: filtered.length,
      uniqueSkills: new Set(filtered.map((e) => e.skill)).size,
    };
  }

  if (wantCodex) {
    const res = backfillCodex({ homeDir, since });
    collected.push(...res.events);
    hostsSummary.codex = {
      files: res.files,
      events: res.events.length,
      uniqueSkills: new Set(res.events.map((e) => e.skill)).size,
      skippedZst: res.skippedZst,
    };
  }

  if (wantClaude) {
    const res = backfillClaude({ homeDir, since });
    collected.push(...res.events);
    hostsSummary.claude = {
      files: res.files,
      events: res.events.length,
      uniqueSkills: new Set(res.events.map((e) => e.skill)).size,
    };
  }

  if (wantGemini) {
    const res = backfillGemini({ homeDir, since });
    collected.push(...res.events);
    hostsSummary.gemini = {
      files: res.files,
      events: res.events.length,
      uniqueSkills: new Set(res.events.map((e) => e.skill)).size,
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
