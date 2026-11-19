import { canonicalizeEvent, dedupeEvents } from '../core/normalize.mjs';

export function parseSince(sinceStr, now = new Date()) {
  if (sinceStr === undefined || sinceStr === null || sinceStr === '' || sinceStr === 'all') {
    return null;
  }
  const s = String(sinceStr).trim();
  if (s === 'all') return null;

  const rel = s.match(/^(\d+)([hdwm])$/i);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const d = new Date(now.getTime());
    if (unit === 'h') {
      d.setTime(d.getTime() - amount * 3600_000);
    } else if (unit === 'd') {
      d.setTime(d.getTime() - amount * 86400_000);
    } else if (unit === 'w') {
      d.setTime(d.getTime() - amount * 7 * 86400_000);
    } else if (unit === 'm') {
      d.setUTCMonth(d.getUTCMonth() - amount);
    }
    return d;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(`${s}T00:00:00.000Z`);
    if (Number.isFinite(ms)) return new Date(ms);
  }

  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return new Date(ms);

  throw new Error(`Invalid --since value: "${sinceStr}" (use e.g. 7d, 30d, 90d, 4w, 6m, 2026-01-01, or all)`);
}

function hostMatches(eventHost, filterHost) {
  if (!filterHost || filterHost === 'all') return true;
  if (eventHost === filterHost) return true;
  if (filterHost === 'antigravity' && String(eventHost).startsWith('antigravity')) return true;
  return false;
}

export function aggregateStats({
  events = [],
  inventory = null,
  config = {},
  since = '30d',
  host = null,
  project = null,
  bySource = false,
  metric = 'activations',
  now = new Date(),
} = {}) {
  const sinceDate = since === null ? null : parseSince(since, now);
  const sinceMs = sinceDate ? sinceDate.getTime() : null;
  const aliases = config?.aliases || {};
  const exclSkills = new Set(config?.exclude_skills || []);
  const exclSources = new Set(config?.exclude_sources || []);

  const canonicalized = events.map((ev) => canonicalizeEvent(ev, inventory?.index, aliases));
  const deduped = dedupeEvents(canonicalized);

  const filtered = [];
  for (const ev of deduped) {
    if (ev.ok === false) continue;
    if (!hostMatches(ev.host, host)) continue;
    if (project && ev.project !== project) continue;
    if (exclSkills.has(ev.skill) || exclSources.has(ev.source)) continue;

    if (sinceMs !== null) {
      const tsMs = Date.parse(ev.ts);
      if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;
    }
    filtered.push(ev);
  }

  const hostTotals = {};
  const groups = new Map();

  for (const ev of filtered) {
    const h = ev.host || 'unknown';
    hostTotals[h] = (hostTotals[h] || 0) + 1;

    const key = bySource ? `${ev.skill}\0${ev.source || 'unknown'}` : ev.skill;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = {
        skill: ev.skill,
        source: ev.source || 'unknown',
        sources: new Set([ev.source || 'unknown']),
        reads: 0,
        sessions: new Set(),
        hosts: new Set(),
        last_used: ev.ts || '',
      };
      groups.set(key, bucket);
    } else if (ev.source) {
      bucket.sources.add(ev.source);
      if (bucket.source === 'unknown' && ev.source !== 'unknown') {
        bucket.source = ev.source;
      }
    }

    bucket.reads += 1;
    bucket.sessions.add(ev.session_id || ev.id || `${ev.ts}:${bucket.reads}`);
    bucket.hosts.add(h);
    if (ev.ts && (!bucket.last_used || ev.ts > bucket.last_used)) {
      bucket.last_used = ev.ts;
    }
  }

  const rows = [...groups.values()].map((b) => ({
    skill: b.skill,
    source: b.source,
    sources: [...b.sources].sort(),
    activations: b.sessions.size,
    reads: b.reads,
    last_used: b.last_used,
    hosts: [...b.hosts].sort(),
  }));

  rows.sort((a, b) => {
    if (metric === 'reads') {
      return (
        b.reads - a.reads ||
        b.activations - a.activations ||
        b.last_used.localeCompare(a.last_used) ||
        a.skill.localeCompare(b.skill)
      );
    }
    return (
      b.activations - a.activations ||
      b.reads - a.reads ||
      b.last_used.localeCompare(a.last_used) ||
      a.skill.localeCompare(b.skill)
    );
  });

  // Compute inventory & unused
  const invSkills = (inventory?.skills || []).filter((s) =>
    !host || host === 'all' ? true : Array.isArray(s.hosts) && s.hosts.some((h) => hostMatches(h, host))
  );
  const enabledSkills = invSkills.filter(
    (s) => s.enabled && !exclSkills.has(s.name) && !exclSources.has(s.source)
  );
  const disabledCount = invSkills.filter(
    (s) => !s.enabled && !exclSkills.has(s.name) && !exclSources.has(s.source)
  ).length;

  const usedNames = new Set(rows.map((r) => r.skill));
  const usedBySource = new Set(rows.map((r) => `${r.skill}\0${r.source}`));

  let usedInstalledCount = 0;
  const unusedSkills = [];

  for (const s of enabledSkills) {
    const used = bySource
      ? usedBySource.has(`${s.name}\0${s.source}`) || usedBySource.has(`${s.dir_name}\0${s.source}`)
      : usedNames.has(s.name) || usedNames.has(s.dir_name);
    if (used) {
      usedInstalledCount += 1;
    } else {
      unusedSkills.push(s);
    }
  }

  const unusedGroupMap = new Map();
  let totalDescChars = 0;
  let totalEstTokens = 0;

  for (const s of unusedSkills) {
    totalDescChars += s.desc_chars || 0;
    totalEstTokens += s.est_tokens || 0;
    let g = unusedGroupMap.get(s.source);
    if (!g) {
      g = { source: s.source, skillCount: 0, descChars: 0, estTokens: 0, skills: [] };
      unusedGroupMap.set(s.source, g);
    }
    g.skillCount += 1;
    g.descChars += s.desc_chars || 0;
    g.estTokens += s.est_tokens || 0;
    g.skills.push(s);
  }

  const unusedGroups = [...unusedGroupMap.values()].sort(
    (a, b) => b.estTokens - a.estTokens || b.skillCount - a.skillCount || a.source.localeCompare(b.source)
  );

  return {
    window: {
      since: since ?? 'all',
      from: sinceDate ? sinceDate.toISOString().slice(0, 10) : null,
      to: now.toISOString().slice(0, 10),
    },
    totals: {
      events: filtered.length,
      activations: rows.reduce((acc, r) => acc + r.activations, 0),
      uniqueSkills: rows.length,
      hosts: hostTotals,
    },
    inventory: {
      enabled: enabledSkills.length,
      disabled: disabledCount,
      used: usedInstalledCount,
      unused: unusedSkills.length,
    },
    rows,
    unused: {
      total: unusedSkills.length,
      totalDescChars,
      totalEstTokens,
      bySource: unusedGroups,
    },
  };
}
