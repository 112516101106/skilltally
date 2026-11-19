import { canonicalizeEvent, dedupeEvents } from '../core/normalize.mjs';
import { parseSince } from './aggregate.mjs';

const VALID_FORMATS = new Set(['csv', 'json']);
const CSV_HEADERS = [
  'ts',
  'host',
  'skill',
  'source',
  'via',
  'tool',
  'session_id',
  'project',
  'model',
  'origin',
  'ok',
];

export function csvEscape(val) {
  if (val === undefined || val === null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function hostMatches(eventHost, filterHost) {
  if (!filterHost || filterHost === 'all') return true;
  if (eventHost === filterHost) return true;
  if (filterHost === 'antigravity' && String(eventHost).startsWith('antigravity')) return true;
  return false;
}

export function exportEvents({
  events = [],
  inventory = null,
  config = {},
  format = 'json',
  since = 'all',
  host = null,
  project = null,
  includeFailed = false,
  now = new Date(),
} = {}) {
  const fmt = String(format || 'json').toLowerCase();
  if (!VALID_FORMATS.has(fmt)) {
    throw new Error(`Invalid --format value: "${format}" (expected: csv, json)`);
  }

  const sinceDate = since === null ? null : parseSince(since, now);
  const sinceMs = sinceDate ? sinceDate.getTime() : null;
  const aliases = config?.aliases || {};
  const exclSkills = new Set(config?.exclude_skills || []);
  const exclSources = new Set(config?.exclude_sources || []);

  const canonicalized = events.map((ev) => canonicalizeEvent(ev, inventory?.index, aliases));
  const deduped = dedupeEvents(canonicalized);

  const rows = [];
  for (const ev of deduped) {
    if (!includeFailed && ev.ok === false) continue;
    if (!hostMatches(ev.host, host)) continue;
    if (project && ev.project !== project) continue;
    if (exclSkills.has(ev.skill) || exclSources.has(ev.source)) continue;

    if (sinceMs !== null) {
      const tsMs = Date.parse(ev.ts);
      if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;
    }
    rows.push(ev);
  }

  rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));

  if (fmt === 'json') {
    return {
      format: 'json',
      count: rows.length,
      content: JSON.stringify(rows, null, 2) + '\n',
    };
  }

  const lines = [CSV_HEADERS.join(',')];
  for (const r of rows) {
    lines.push(CSV_HEADERS.map((col) => csvEscape(r[col])).join(','));
  }
  return {
    format: 'csv',
    count: rows.length,
    content: lines.join('\n') + '\n',
  };
}
