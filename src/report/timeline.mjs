import { canonicalizeEvent, dedupeEvents } from '../core/normalize.mjs';
import { parseSince } from './aggregate.mjs';

const VALID_BY = new Set(['day', 'week', 'month']);

export function isoWeekBucket(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function bucketOf(isoTs, by) {
  const d = new Date(isoTs);
  if (!Number.isFinite(d.getTime())) return null;
  if (by === 'day') return d.toISOString().slice(0, 10);
  if (by === 'month') return d.toISOString().slice(0, 7);
  if (by === 'week') return isoWeekBucket(d);
  throw new Error(`Invalid --by value: "${by}" (expected: day, week, month)`);
}

function hostMatches(eventHost, filterHost) {
  if (!filterHost || filterHost === 'all') return true;
  if (eventHost === filterHost) return true;
  if (filterHost === 'antigravity' && String(eventHost).startsWith('antigravity')) return true;
  return false;
}

export function buildTimeline({
  events = [],
  inventory = null,
  config = {},
  skill = null,
  by = 'day',
  since = '30d',
  host = null,
  project = null,
  now = new Date(),
} = {}) {
  if (!VALID_BY.has(by)) {
    throw new Error(`Invalid --by value: "${by}" (expected: day, week, month)`);
  }

  const sinceDate = since === null ? null : parseSince(since, now);
  const sinceMs = sinceDate ? sinceDate.getTime() : null;
  const aliases = config?.aliases || {};
  const exclSkills = new Set(config?.exclude_skills || []);
  const exclSources = new Set(config?.exclude_sources || []);
  const targetSkill = skill
    ? canonicalizeEvent({ skill }, inventory?.index, aliases).skill
    : null;

  const canonicalized = events.map((ev) => canonicalizeEvent(ev, inventory?.index, aliases));
  const deduped = dedupeEvents(canonicalized);

  const buckets = new Map();
  let totalReads = 0;

  for (const ev of deduped) {
    if (ev.ok === false) continue;
    if (!hostMatches(ev.host, host)) continue;
    if (project && ev.project !== project) continue;
    if (exclSkills.has(ev.skill) || exclSources.has(ev.source)) continue;
    if (targetSkill && ev.skill !== targetSkill) continue;

    const tsMs = Date.parse(ev.ts);
    if (!Number.isFinite(tsMs)) continue;
    if (sinceMs !== null && tsMs < sinceMs) continue;

    const bKey = bucketOf(ev.ts, by);
    if (!bKey) continue;

    let bucket = buckets.get(bKey);
    if (!bucket) {
      bucket = {
        bucket: bKey,
        activationsSet: new Set(),
        skillsSet: new Set(),
        reads: 0,
      };
      buckets.set(bKey, bucket);
    }

    bucket.reads += 1;
    totalReads += 1;
    const sessKey = `${ev.session_id || ev.id || ev.ts}\0${ev.skill}`;
    bucket.activationsSet.add(sessKey);
    bucket.skillsSet.add(ev.skill);
  }

  const rows = [...buckets.values()]
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
    .map((b) => ({
      bucket: b.bucket,
      activations: b.activationsSet.size,
      reads: b.reads,
      uniqueSkills: b.skillsSet.size,
    }));

  return {
    window: {
      since: since ?? 'all',
      from: sinceDate ? sinceDate.toISOString().slice(0, 10) : null,
      to: now.toISOString().slice(0, 10),
    },
    by,
    skill: targetSkill,
    totals: {
      buckets: rows.length,
      activations: rows.reduce((acc, r) => acc + r.activations, 0),
      reads: totalReads,
    },
    rows,
  };
}
