#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runBackfill } from '../src/backfill/index.mjs';
import { getHomeDir, loadConfig } from '../src/core/config.mjs';
import { readAllEvents } from '../src/core/store.mjs';
import { scanInventory } from '../src/inventory/scan.mjs';
import { aggregateStats, parseSince } from '../src/report/aggregate.mjs';
import { formatBackfill, formatInventory, formatStats, formatUnused } from '../src/report/format.mjs';
import { main as runTrack } from './track.mjs';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

function getVersion() {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  } catch {
    return '0.1.0';
  }
}

function printHelp() {
  console.log(`skilltally v${getVersion()} — Local skill usage analytics across Antigravity, Claude Code, Codex & Gemini CLI

Usage:
  skilltally stats     [--since 30d|all|YYYY-MM-DD] [--host <h>] [--project <p>] [--by-source] [--metric activations|reads] [--json]
  skilltally top       [-n 20] [--since 30d] [--host <h>] [--project <p>] [--by-source] [--metric activations|reads] [--json]
  skilltally unused    [--since 90d] [--host <h>] [--all] [--json]
  skilltally backfill  [--host all|antigravity|codex] [--since DATE] [--dry-run] [--json]
  skilltally inventory [--no-project] [--json]
  skilltally track     --host <antigravity|claude|codex|gemini|auto>

Options:
  -h, --help      Show this help
  -v, --version   Show version`);
}

function parseCliFlags(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      since: { type: 'string' },
      host: { type: 'string' },
      project: { type: 'string' },
      metric: { type: 'string', default: 'activations' },
      limit: { type: 'string', short: 'n' },
      'by-source': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      'no-project': { type: 'boolean', default: false },
    },
  });
}

function run() {
  const argv = process.argv.slice(2);
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;

  if (sub === 'track') {
    try {
      runTrack();
    } catch {}
    process.stdout.write('{}');
    process.exit(0);
  }

  const { values } = parseCliFlags(sub ? argv.slice(1) : argv);

  if (values.version) {
    console.log(getVersion());
    return;
  }

  if (values.help || !sub) {
    printHelp();
    if (!sub && !values.help) process.exitCode = 0;
    return;
  }

  const dataHome = getHomeDir();
  const config = loadConfig(dataHome);

  if (sub === 'backfill') {
    const sinceDate = values.since ? parseSince(values.since) : null;
    const summary = runBackfill({
      dataHome,
      host: values.host || 'all',
      since: sinceDate,
      dryRun: Boolean(values['dry-run']),
    });
    if (values.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(formatBackfill(summary));
    }
    return;
  }

  if (sub === 'inventory') {
    const inv = scanInventory({ includeProject: !values['no-project'] });
    if (values.json) {
      console.log(JSON.stringify(inv.skills, null, 2));
    } else {
      console.log(formatInventory(inv));
    }
    return;
  }

  if (sub === 'stats' || sub === 'top') {
    const defaultSince = sub === 'top' ? '30d' : '30d';
    const since = values.since ?? defaultSince;
    const limit = values.limit !== undefined ? Number(values.limit) : sub === 'top' ? 20 : null;
    if (limit !== null && (!Number.isFinite(limit) || limit < 1)) {
      throw new Error(`Invalid -n/--limit value: "${values.limit}"`);
    }
    const metric = values.metric === 'reads' ? 'reads' : 'activations';
    const { events, corruptLines } = readAllEvents(dataHome);
    const inventory = scanInventory({ includeProject: true });
    const report = aggregateStats({
      events,
      inventory,
      config,
      since,
      host: values.host || null,
      project: values.project || null,
      bySource: Boolean(values['by-source']),
      metric,
    });
    if (values.json) {
      console.log(JSON.stringify({ ...report, corruptLines }, null, 2));
    } else {
      console.log(
        formatStats(report, {
          limit,
          heading: sub === 'top' ? `skilltally top ${limit}` : 'skilltally',
          bySource: Boolean(values['by-source']),
        })
      );
      if (corruptLines > 0) {
        console.error(`Warning: ignored ${corruptLines} malformed event line(s) in ${dataHome}`);
      }
    }
    return;
  }

  if (sub === 'unused') {
    const since = values.since ?? '90d';
    const { events } = readAllEvents(dataHome);
    const inventory = scanInventory({ includeProject: true });
    const report = aggregateStats({
      events,
      inventory,
      config,
      since,
      host: values.host || null,
    });
    if (values.json) {
      console.log(JSON.stringify({ window: report.window, inventory: report.inventory, unused: report.unused }, null, 2));
    } else {
      console.log(formatUnused(report, { showAll: Boolean(values.all) }));
    }
    return;
  }

  console.error(`Unknown command: "${sub}"\n`);
  printHelp();
  process.exitCode = 1;
}

try {
  run();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
