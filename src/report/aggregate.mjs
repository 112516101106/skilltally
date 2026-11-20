import { realpathSync } from 'node:fs';
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

export function formatDurationCompact(seconds) {
  const sec = Number(seconds);
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  const rounded = Math.round(sec);
  if (rounded < 60) return `${rounded}s`;
  if (rounded < 3600) {
    const m = Math.floor(rounded / 60);
    const s = rounded % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
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
  if (source && source !== 'unknown') {
    const byComposite = inventory.index?.bySkillAndSource?.get(`${skill}\0${source}`);
    if (byComposite) return byComposite;
    if (Array.isArray(inventory.skills)) {
      const exact = inventory.skills.find(
        (s) => (s.name === skill || s.dir_name === skill) && s.source === source
      );
      if (exact) return exact;
    }
  }
  return inventory.index?.byName?.get(skill) ?? inventory.index?.byDirName?.get(skill) ?? null;
}

function resolveInventoryPath(skillPath, inventory) {
  if (!skillPath || !inventory?.index?.byPath) return null;
  const raw = String(skillPath).replace(/\\/g, '/');
  const direct = inventory.index.byPath.get(raw);
  if (direct) return direct.path || raw;
  try {
    const real = realpathSync(skillPath).replace(/\\/g, '/');
    const resolved = inventory.index.byPath.get(real);
    if (resolved) return resolved.path || real;
  } catch {}
  return null;
}

function mergeIntervalSeconds(intervals) {
  if (!intervals || intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let totalMs = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      totalMs += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  totalMs += curEnd - curStart;
  return Math.round(totalMs / 1000);
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
  const sessionBounds = new Map();
  const sessionDurIntervals = new Map();
  const sessionUnanchoredDur = new Map();
  const sessionTokensMap = new Map();
  const sessionBodyFallbackMap = new Map();
  const seenTurnTokenTuples = new Set();
  const seenBucketTokenTuples = new Set();
  const usedInvPaths = new Set();
  const promptMap = new Map();

  let manualTotal = 0;
  let autoTotal = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalPromptInputTokens = 0;
  let totalRecordedTokens = 0;
  let maxSingleDuration = 0;
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
        durations: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
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
    if (ev.skill_path) {
      const matchedInvPath = resolveInventoryPath(ev.skill_path, inventory);
      if (matchedInvPath) usedInvPaths.add(matchedInvPath);
    }

    if (typeof ev.duration_seconds === 'number' && Number.isFinite(ev.duration_seconds) && ev.duration_seconds > 0) {
      const dur = Math.min(86400, Math.round(ev.duration_seconds));
      bucket.durations.push(dur);
      if (dur > maxSingleDuration) maxSingleDuration = dur;
      const evStartMs = ev.ts ? Date.parse(ev.ts) : NaN;
      if (Number.isFinite(evStartMs)) {
        let ivs = sessionDurIntervals.get(globalSessKey);
        if (!ivs) {
          ivs = [];
          sessionDurIntervals.set(globalSessKey, ivs);
        }
        ivs.push([evStartMs, evStartMs + dur * 1000]);
      } else {
        sessionUnanchoredDur.set(
          globalSessKey,
          Math.max(sessionUnanchoredDur.get(globalSessKey) || 0, dur)
        );
      }
    }

    const inTok = typeof ev.input_tokens === 'number' && Number.isFinite(ev.input_tokens) ? ev.input_tokens : 0;
    const outTok = typeof ev.output_tokens === 'number' && Number.isFinite(ev.output_tokens) ? ev.output_tokens : 0;
    const crTok = typeof ev.cache_read_tokens === 'number' && Number.isFinite(ev.cache_read_tokens) ? ev.cache_read_tokens : 0;
    const ccTok = typeof ev.cache_creation_tokens === 'number' && Number.isFinite(ev.cache_creation_tokens) ? ev.cache_creation_tokens : 0;
    const totTok = typeof ev.total_tokens === 'number' && Number.isFinite(ev.total_tokens) ? ev.total_tokens : 0;
    if (totTok > 0 || inTok > 0 || outTok > 0) {
      const isAnthropicStyle =
        h === 'claude' ||
        (totTok > 0 && crTok > 0 && totTok >= inTok + outTok + crTok) ||
        inTok < crTok;
      const promptInput = isAnthropicStyle ? inTok + crTok + ccTok : inTok + ccTok;
      const effectiveTotal =
        totTok > 0
          ? totTok
          : isAnthropicStyle
            ? inTok + outTok + crTok + ccTok
            : inTok + outTok + ccTok;
      const tokTupleKey = `${globalSessKey}\0${ev.origin || ''}\0${inTok}\0${outTok}\0${crTok}\0${ccTok}\0${effectiveTotal}`;

      if (!seenBucketTokenTuples.has(`${key}\0${tokTupleKey}`)) {
        seenBucketTokenTuples.add(`${key}\0${tokTupleKey}`);
        bucket.tokens.input += inTok;
        bucket.tokens.output += outTok;
        bucket.tokens.cacheRead += crTok;
        bucket.tokens.cacheCreation += ccTok;
        bucket.tokens.total += effectiveTotal;
      }

      if (!seenTurnTokenTuples.has(tokTupleKey)) {
        seenTurnTokenTuples.add(tokTupleKey);
        totalInputTokens += inTok;
        totalOutputTokens += outTok;
        totalCacheReadTokens += crTok;
        totalCacheCreationTokens += ccTok;
        totalPromptInputTokens += promptInput;
        totalRecordedTokens += effectiveTotal;
        sessionTokensMap.set(globalSessKey, (sessionTokensMap.get(globalSessKey) || 0) + effectiveTotal);
      }
    }

    if (typeof ev.prompt_preview === 'string' && ev.prompt_preview.trim()) {
      const pKey = ev.prompt_preview.trim();
      let pEntry = promptMap.get(pKey);
      if (!pEntry) {
        pEntry = { prompt: pKey, count: 0, skills: new Set() };
        promptMap.set(pKey, pEntry);
      }
      pEntry.count += 1;
      pEntry.skills.add(ev.skill);
    }

    if (ev.ts) {
      const tsMs = Date.parse(ev.ts);
      if (Number.isFinite(tsMs)) {
        const bounds = sessionBounds.get(globalSessKey);
        if (!bounds) {
          sessionBounds.set(globalSessKey, { min: tsMs, max: tsMs });
        } else {
          if (tsMs < bounds.min) bounds.min = tsMs;
          if (tsMs > bounds.max) bounds.max = tsMs;
        }
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
    const bodyTokens =
      invEntry?.body_tokens || (invEntry?.bytes ? Math.ceil(invEntry.bytes / 4) : 0);
    const activations = b.sessions.size;
    const activeLoadTokens = activations * bodyTokens;
    const dailyCounts = buildDailySparklineSeries(b.daySessions, now, 14);
    const totalDur = b.durations.reduce((acc, d) => acc + d, 0);
    const avgDur = b.durations.length > 0 ? Math.round(totalDur / b.durations.length) : 0;
    const maxDur = b.durations.length > 0 ? Math.max(...b.durations) : 0;

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
      body_tokens: bodyTokens,
      activeLoadTokens,
      tokenCostPerActivation: estTokens > 0 ? Math.round((totalSessions * estTokens) / Math.max(1, activations)) : 0,
      tokens: b.tokens,
      total_duration_seconds: totalDur,
      avg_duration_seconds: avgDur,
      max_duration_seconds: maxDur,
      dailyCounts,
      sparkline: encodeSparkline(dailyCounts),
    };
  });

  // Track fallback session body tokens for sessions lacking transcript usage
  for (const r of rows) {
    if (r.body_tokens > 0) {
      const k = r.skill;
      sessionBodyFallbackMap.set(k, r.body_tokens);
    }
  }

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
  const usedBySource = new Set();
  for (const r of rows) {
    for (const src of r.sources) {
      usedBySource.add(`${r.skill}\0${src}`);
    }
  }
  const skillsWithKnownSource = new Set();
  for (const s of enabledSkills) {
    if (usedBySource.has(`${s.name}\0${s.source}`) || usedBySource.has(`${s.dir_name}\0${s.source}`)) {
      skillsWithKnownSource.add(s.name);
      skillsWithKnownSource.add(s.dir_name);
    }
  }

  const peersBySkillSource = new Map();
  for (const s of enabledSkills) {
    const k = `${s.name}\0${s.source}`;
    if (!peersBySkillSource.has(k)) peersBySkillSource.set(k, []);
    peersBySkillSource.get(k).push(s);
  }

  const claimedFallbackKey = new Set();
  let usedInstalledCount = 0;
  const unusedSkills = [];

  for (const s of enabledSkills) {
    const compositeKey = `${s.name}\0${s.source}`;
    const peers = peersBySkillSource.get(compositeKey) || [s];
    const anyPeerHasPathHit = peers.some((p) => usedInvPaths.has(p.path));

    let used = false;
    if (usedInvPaths.has(s.path)) {
      used = true;
    } else if (anyPeerHasPathHit) {
      // Another physical copy with the same (name, source) was explicitly read by path, not this one.
      used = false;
    } else {
      const exactSourceMatch =
        usedBySource.has(compositeKey) || usedBySource.has(`${s.dir_name}\0${s.source}`);
      const fallbackNameMatch =
        !bySource &&
        (usedNames.has(s.name) || usedNames.has(s.dir_name)) &&
        !skillsWithKnownSource.has(s.name) &&
        !skillsWithKnownSource.has(s.dir_name);
      if (exactSourceMatch || fallbackNameMatch) {
        const claimKey = bySource ? compositeKey : s.name;
        if (!claimedFallbackKey.has(claimKey)) {
          claimedFallbackKey.add(claimKey);
          used = true;
        }
      }
    }

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

  // Heavy SKILL.md bodies (>= 1500 body tokens)
  const heavySeen = new Set();
  const heavyCandidates = [];
  for (const r of rows) {
    if (r.body_tokens >= 1500) {
      heavySeen.add(`${r.skill}\0${r.source}`);
      heavyCandidates.push({
        skill: r.skill,
        source: r.source,
        activations: r.activations,
        est_tokens: r.est_tokens,
        body_tokens: r.body_tokens,
        activeLoadTokens: r.activeLoadTokens,
      });
    }
  }
  for (const s of enabledSkills) {
    const bt = s.body_tokens || (s.bytes ? Math.ceil(s.bytes / 4) : 0);
    if (bt >= 1500 && !heavySeen.has(`${s.name}\0${s.source}`)) {
      heavySeen.add(`${s.name}\0${s.source}`);
      heavyCandidates.push({
        skill: s.name,
        source: s.source,
        activations: 0,
        est_tokens: s.est_tokens || 0,
        body_tokens: bt,
        activeLoadTokens: 0,
      });
    }
  }
  const heavyBodySkills = heavyCandidates
    .sort(
      (a, b) =>
        b.body_tokens * Math.max(1, b.activations) - a.body_tokens * Math.max(1, a.activations) ||
        b.body_tokens - a.body_tokens
    )
    .slice(0, 10);

  const slowestSkills = rows
    .filter((r) => r.total_duration_seconds > 0)
    .sort((a, b) => b.total_duration_seconds - a.total_duration_seconds || b.max_duration_seconds - a.max_duration_seconds)
    .slice(0, 10)
    .map((r) => ({
      skill: r.skill,
      source: r.source,
      activations: r.activations,
      avg_duration_seconds: r.avg_duration_seconds,
      total_duration_seconds: r.total_duration_seconds,
      max_duration_seconds: r.max_duration_seconds,
    }));

  const promptPatterns = [...promptMap.values()]
    .sort((a, b) => b.count - a.count || a.prompt.localeCompare(b.prompt))
    .slice(0, 10)
    .map((p) => ({
      prompt: p.prompt,
      count: p.count,
      skills: [...p.skills].sort(),
    }));

  // Compute duration & token aggregates across sessions
  let totalDurationSeconds = 0;
  let maxFallbackSessDur = 0;
  for (const sKey of allSessions) {
    const intervals = sessionDurIntervals.get(sKey);
    let sessDur = intervals && intervals.length > 0 ? mergeIntervalSeconds(intervals) : sessionUnanchoredDur.get(sKey) || 0;
    if (sessDur === 0) {
      const bounds = sessionBounds.get(sKey);
      if (bounds && bounds.max > bounds.min) {
        const span = Math.round((bounds.max - bounds.min) / 1000);
        if (span > 0 && span <= 86400) {
          sessDur = span;
          if (span > maxFallbackSessDur) maxFallbackSessDur = span;
        }
      }
    }
    totalDurationSeconds += sessDur;
  }
  const longestTaskSeconds = maxSingleDuration > 0 ? maxSingleDuration : maxFallbackSessDur;

  const totalActivations = rows.reduce((acc, r) => acc + r.activations, 0);
  const totalActiveBodyTokens = rows.reduce((acc, r) => acc + (r.activeLoadTokens || 0), 0);

  let peakSessionTokens = 0;
  if (sessionTokensMap.size > 0) {
    peakSessionTokens = Math.max(...sessionTokensMap.values());
  } else if (filtered.length > 0) {
    const perSessionFallback = new Map();
    for (let idx = 0; idx < filtered.length; idx++) {
      const ev = filtered[idx];
      const h = ev.host || 'unknown';
      const gKey = ev.session_id ? `${h}\0${ev.session_id}` : ev.id || `${h}\0${ev.ts || ''}\0${idx}`;
      const bt = sessionBodyFallbackMap.get(ev.skill) || 0;
      perSessionFallback.set(gKey, (perSessionFallback.get(gKey) || 0) + bt);
    }
    const maxBodyPerSess = perSessionFallback.size > 0 ? Math.max(...perSessionFallback.values()) : 0;
    peakSessionTokens = maxBodyPerSess + enabledEstTokens;
  }

  return {
    window: {
      since: since ?? 'all',
      from: sinceDate ? sinceDate.toISOString().slice(0, 10) : null,
      to: now.toISOString().slice(0, 10),
    },
    totals: {
      events: filtered.length,
      activations: totalActivations,
      uniqueSkills: rows.length,
      sessions: allSessions.size,
      hosts: hostTotals,
      via: viaTotals,
      models: modelTotals,
      projects: projectTotals,
      manualReads: manualTotal,
      autoReads: autoTotal,
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        cacheRead: totalCacheReadTokens,
        cacheCreation: totalCacheCreationTokens,
        total: totalRecordedTokens,
        cacheHitRate:
          totalPromptInputTokens > 0
            ? Number((totalCacheReadTokens / totalPromptInputTokens).toFixed(2))
            : 0,
        activeBodyTokens: totalActiveBodyTokens,
        lifetimeTokens:
          totalRecordedTokens > 0
            ? totalRecordedTokens
            : totalActiveBodyTokens + enabledEstTokens * (filtered.length > 0 ? Math.max(1, allSessions.size) : 0),
        peakSessionTokens,
      },
      duration: {
        totalSeconds: totalDurationSeconds,
        avgSeconds: rows.length > 0 ? Math.round(totalDurationSeconds / Math.max(1, totalActivations)) : 0,
        longestTaskSeconds,
      },
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
      heavyBodySkills,
      slowestSkills,
      promptPatterns,
    },
  };
}
