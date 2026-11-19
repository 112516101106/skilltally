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

export function hostMatches(eventHost, filterHost) {
  if (!filterHost || filterHost === 'all') return true;
  if (eventHost === filterHost) return true;
  if (filterHost === 'antigravity' && String(eventHost).startsWith('antigravity')) return true;
  return false;
}

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function isManualVia(via) {
  return via === 'mention' || via === 'slash_command';
}

export function buildDailySparklineSeries(daySetsMap, now = new Date(), days = 14) {
  const endUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayKey = new Date(endUtcMs - i * 86400_000).toISOString().slice(0, 10);
    series.push(daySetsMap?.get(dayKey)?.size || 0);
  }
  return series;
}

export function encodeSparkline(counts) {
  if (!Array.isArray(counts) || counts.length === 0) return '';
  const max = Math.max(0, ...counts);
  if (max === 0) return '·'.repeat(counts.length);
  return counts
    .map((c) => {
      if (!c || c <= 0) return '·';
      if (max <= 1) return '█';
      const idx = Math.min(7, Math.floor(((c - 1) / Math.max(1, max - 1)) * 7));
      return SPARK_CHARS[idx];
    })
    .join('');
}

export function prepareFilteredEvents({
  events = [],
  inventory = null,
  config = {},
  since = '30d',
  host = null,
  project = null,
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

  return {
    sinceDate,
    exclSkills,
    exclSources,
    filtered,
  };
}

function findInventoryEntry(inventory, skill, source, bySource) {
  if (!inventory) return null;
  if (bySource && Array.isArray(inventory.skills)) {
    const exact = inventory.skills.find(
      (s) => (s.name === skill || s.dir_name === skill) && s.source === source
    );
    if (exact) return exact;
  }
  return inventory.index?.byName?.get(skill) ?? inventory.index?.byDirName?.get(skill) ?? null;
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
  const { sinceDate, exclSkills, exclSources, filtered } = prepareFilteredEvents({
    events,
    inventory,
    config,
    since,
    host,
    project,
    now,
  });

  const hostTotals = {};
  const viaTotals = {};
  const modelTotals = {};
  const projectTotals = {};
  const allSessions = new Set();
  let manualTotal = 0;
  let autoTotal = 0;
  const groups = new Map();

  for (let idx = 0; idx < filtered.length; idx++) {
    const ev = filtered[idx];
    const h = ev.host || 'unknown';
    hostTotals[h] = (hostTotals[h] || 0) + 1;

    const viaKey = ev.via || 'unknown';
    viaTotals[viaKey] = (viaTotals[viaKey] || 0) + 1;
    const isManual = isManualVia(viaKey);
    if (isManual) manualTotal += 1;
    else autoTotal += 1;

    if (ev.model) {
      modelTotals[ev.model] = (modelTotals[ev.model] || 0) + 1;
    }
    if (ev.project) {
      projectTotals[ev.project] = (projectTotals[ev.project] || 0) + 1;
    }

    const globalSessKey = ev.session_id
      ? `${h}\0${ev.session_id}`
      : ev.id || `${h}\0${ev.ts || ''}\0${idx}`;
    allSessions.add(globalSessKey);

    const key = bySource ? `${ev.skill}\0${ev.source || 'unknown'}` : ev.skill;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = {
        skill: ev.skill,
        source: ev.source || 'unknown',
        sources: new Set([ev.source || 'unknown']),
        reads: 0,
        manualReads: 0,
        autoReads: 0,
        via: {},
        sessions: new Set(),
        hosts: new Set(),
        projects: new Set(),
        models: new Set(),
        daySessions: new Map(),
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
    if (isManual) bucket.manualReads += 1;
    else bucket.autoReads += 1;
    bucket.via[viaKey] = (bucket.via[viaKey] || 0) + 1;

    const sessKey = ev.session_id || ev.id || `${ev.ts}:${bucket.reads}`;
    bucket.sessions.add(sessKey);
    bucket.hosts.add(h);
    if (ev.project) bucket.projects.add(ev.project);
    if (ev.model) bucket.models.add(ev.model);

    if (ev.ts) {
      const tsMs = Date.parse(ev.ts);
      if (Number.isFinite(tsMs)) {
        const dayKey = new Date(tsMs).toISOString().slice(0, 10);
        let daySet = bucket.daySessions.get(dayKey);
        if (!daySet) {
          daySet = new Set();
          bucket.daySessions.set(dayKey, daySet);
        }
        daySet.add(sessKey);
      }
      if (!bucket.last_used || ev.ts > bucket.last_used) {
        bucket.last_used = ev.ts;
      }
    }
  }

  const totalSessions = Math.max(1, allSessions.size);

  const rows = [...groups.values()].map((b) => {
    const invEntry = findInventoryEntry(inventory, b.skill, b.source, bySource);
    const estTokens = invEntry?.est_tokens || 0;
    const descChars = invEntry?.desc_chars || 0;
    const activations = b.sessions.size;
    const dailyCounts = buildDailySparklineSeries(b.daySessions, now, 14);
    return {
      skill: b.skill,
      source: b.source,
      sources: [...b.sources].sort(),
      activations,
      reads: b.reads,
      last_used: b.last_used,
      hosts: [...b.hosts].sort(),
      via: b.via,
      manualReads: b.manualReads,
      autoReads: b.autoReads,
      manualRatio: b.reads > 0 ? Number((b.manualReads / b.reads).toFixed(2)) : 0,
      projects: [...b.projects].sort(),
      models: [...b.models].sort(),
      est_tokens: estTokens,
      desc_chars: descChars,
      tokenCostPerActivation: estTokens > 0 ? Math.round((totalSessions * estTokens) / Math.max(1, activations)) : 0,
      dailyCounts,
      sparkline: encodeSparkline(dailyCounts),
    };
  });

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
  const enabledEstTokens = enabledSkills.reduce((acc, s) => acc + (s.est_tokens || 0), 0);

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

  const manualOnlySkills = rows
    .filter((r) => r.reads > 0 && r.autoReads === 0 && r.manualReads > 0)
    .sort((a, b) => b.est_tokens - a.est_tokens || b.reads - a.reads)
    .map((r) => ({
      skill: r.skill,
      source: r.source,
      activations: r.activations,
      reads: r.reads,
      est_tokens: r.est_tokens,
      via: r.via,
    }));

  const projectScopeCandidates = rows
    .filter((r) => r.projects.length === 1 && r.source !== 'project' && r.source !== 'builtin')
    .sort((a, b) => b.est_tokens - a.est_tokens || b.activations - a.activations)
    .map((r) => ({
      skill: r.skill,
      source: r.source,
      project: r.projects[0],
      activations: r.activations,
      reads: r.reads,
      est_tokens: r.est_tokens,
    }));

  const highCostSkills = rows
    .filter((r) => r.est_tokens > 0)
    .sort((a, b) => b.tokenCostPerActivation - a.tokenCostPerActivation || b.est_tokens - a.est_tokens)
    .slice(0, 10)
    .map((r) => ({
      skill: r.skill,
      source: r.source,
      activations: r.activations,
      est_tokens: r.est_tokens,
      tokenCostPerActivation: r.tokenCostPerActivation,
    }));

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
      sessions: allSessions.size,
      hosts: hostTotals,
      via: viaTotals,
      models: modelTotals,
      projects: projectTotals,
      manualReads: manualTotal,
      autoReads: autoTotal,
    },
    inventory: {
      enabled: enabledSkills.length,
      disabled: disabledCount,
      used: usedInstalledCount,
      unused: unusedSkills.length,
      enabledEstTokens,
      usedEstTokens: Math.max(0, enabledEstTokens - totalEstTokens),
    },
    rows,
    unused: {
      total: unusedSkills.length,
      totalDescChars,
      totalEstTokens,
      bySource: unusedGroups,
    },
    insights: {
      manualOnlySkills,
      projectScopeCandidates,
      highCostSkills,
    },
  };
}
