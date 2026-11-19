#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runBackfill } from '../src/backfill/index.mjs';
import { getHomeDir, loadConfig } from '../src/core/config.mjs';
import { getDebugStatus, setDebugMode } from '../src/core/debug.mjs';
import { readAllEvents } from '../src/core/store.mjs';
import { runDoctor } from '../src/install/doctor.mjs';
import { runInstall, runUninstall } from '../src/install/index.mjs';
import { scanInventory } from '../src/inventory/scan.mjs';
import { aggregateStats, parseSince } from '../src/report/aggregate.mjs';
import { exportEvents } from '../src/report/export.mjs';
import {
  formatBackfill,
  formatDebug,
  formatDoctor,
  formatInstall,
  formatInventory,
  formatStats,
  formatTimeline,
  formatUninstall,
  formatUnused,
} from '../src/report/format.mjs';
import { buildTimeline } from '../src/report/timeline.mjs';
import { main as runTrack } from './track.mjs';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

function getVersion() {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  } catch {
    return '1.0.1';
  }
}

function printHelp() {
  console.log(`skilltally v${getVersion()} — Local skill usage analytics across Antigravity, Claude Code, Codex & Gemini CLI

Usage:
  skilltally install   [--host all|antigravity|claude|codex|gemini] [--dry-run] [--force] [--json]
  skilltally uninstall [--host all|antigravity|claude|codex|gemini] [--purge] [--dry-run] [--json]
  skilltally doctor    [--json]
  skilltally stats     [--since 30d|all|YYYY-MM-DD] [--host <h>] [--project <p>] [--by-source] [--metric activations|reads] [--json]
  skilltally top       [-n 20] [--since 30d] [--host <h>] [--project <p>] [--by-source] [--metric activations|reads] [--json]
  skilltally unused    [--since 90d] [--host <h>] [--all] [--json]
  skilltally timeline  [--skill <name>] [--by day|week|month] [--since 30d|all] [--host <h>] [--project <p>] [--json]
  skilltally export    [--format json|csv] [-o <file>] [--since all|30d] [--host <h>] [--project <p>] [--include-failed]
  skilltally backfill  [--host all|antigravity|codex|claude|gemini] [--since DATE] [--dry-run] [--json]
  skilltally inventory [--no-project] [--json]
  skilltally debug     [on|off|status] [--json]
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
      skill: { type: 'string' },
      by: { type: 'string' },
      format: { type: 'string' },
      output: { type: 'string', short: 'o' },
      metric: { type: 'string', default: 'activations' },
      limit: { type: 'string', short: 'n' },
      'by-source': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      'no-project': { type: 'boolean', default: false },
      'include-failed': { type: 'boolean', default: false },
      purge: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
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

  const { values, positionals } = parseCliFlags(sub ? argv.slice(1) : argv);

  if (values.version) {
    console.log(getVersion());
    return;
  }

  if (values.help || !sub) {
    printHelp();
    return;
  }

  const dataHome = getHomeDir();
  const config = loadConfig(dataHome);

  if (sub === 'install') {
    const res = runInstall({
      dataHome,
      pkgRoot: pkgDir,
      host: values.host || 'all',
      dryRun: Boolean(values['dry-run']),
      force: Boolean(values.force),
    });
    if (values.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(formatInstall(res));
    }
    if (res.exitCode) process.exitCode = res.exitCode;
    return;
  }

  if (sub === 'uninstall') {
    const res = runUninstall({
      dataHome,
      host: values.host || 'all',
      purge: Boolean(values.purge),
      dryRun: Boolean(values['dry-run']),
    });
    if (values.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(formatUninstall(res));
    }
    return;
  }

  if (sub === 'doctor') {
    const report = runDoctor({ dataHome, pkgRoot: pkgDir });
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctor(report));
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (sub === 'debug') {
    const action = (positionals[0] || 'status').toLowerCase();
    let status;
    if (action === 'on') {
      status = setDebugMode(dataHome, true);
    } else if (action === 'off') {
      status = setDebugMode(dataHome, false);
    } else if (action === 'status') {
      status = getDebugStatus(dataHome);
    } else {
      throw new Error(`Invalid debug action "${action}" (expected: on, off, status)`);
    }
    if (values.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(formatDebug(status));
    }
    return;
  }

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

  if (sub === 'timeline') {
    const since = values.since ?? '30d';
    const by = values.by ?? 'day';
    const { events } = readAllEvents(dataHome);
    const inventory = scanInventory({ includeProject: true });
    const timeline = buildTimeline({
      events,
      inventory,
      config,
      skill: values.skill || null,
      by,
      since,
      host: values.host || null,
      project: values.project || null,
    });
    if (values.json) {
      console.log(JSON.stringify(timeline, null, 2));
    } else {
      console.log(formatTimeline(timeline));
    }
    return;
  }

  if (sub === 'export') {
    const since = values.since ?? 'all';
    const format = values.format ?? 'json';
    const { events } = readAllEvents(dataHome);
    const inventory = scanInventory({ includeProject: true });
    const out = exportEvents({
      events,
      inventory,
      config,
      format,
      since,
      host: values.host || null,
      project: values.project || null,
      includeFailed: Boolean(values['include-failed']),
    });
    if (values.output) {
      mkdirSync(dirname(values.output), { recursive: true });
      writeFileSync(values.output, out.content, 'utf8');
      console.log(`Exported ${out.count} ${out.format.toUpperCase()} event(s) to ${values.output}`);
    } else {
      process.stdout.write(out.content);
    }
    return;
  }

  if (sub === 'stats' || sub === 'top') {
    const since = values.since ?? '30d';
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
      console.log(
        JSON.stringify({ window: report.window, inventory: report.inventory, unused: report.unused }, null, 2)
      );
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
