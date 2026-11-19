import { prepareFilteredEvents } from './aggregate.mjs';

/**
 * Build skill transition chains, 3-step sequences, and co-occurrence pairs
 * grouped by session_id within the requested filter window.
 */
export function buildChains({
  events = [],
  inventory = null,
  config = {},
  since = '30d',
  host = null,
  project = null,
  limit = 20,
  now = new Date(),
} = {}) {
  const { sinceDate, filtered } = prepareFilteredEvents({
    events,
    inventory,
    config,
    since,
    host,
    project,
    now,
  });

  const sessionMap = new Map();
  for (let idx = 0; idx < filtered.length; idx++) {
    const ev = filtered[idx];
    if (!ev.session_id || !ev.skill) continue;
    const sKey = `${ev.host || 'unknown'}\0${ev.session_id}`;
    let list = sessionMap.get(sKey);
    if (!list) {
      list = [];
      sessionMap.set(sKey, list);
    }
    const tsMs = Date.parse(ev.ts);
    list.push({
      skill: ev.skill,
      tsMs: Number.isFinite(tsMs) ? tsMs : 0,
      order: idx,
    });
  }

  const skillSessions = new Map();
  const transitionMap = new Map();
  const sequenceMap = new Map();
  const pairMap = new Map();
  let multiSkillSessions = 0;

  for (const [sKey, rawList] of sessionMap.entries()) {
    rawList.sort((a, b) => a.tsMs - b.tsMs || a.order - b.order);

    const seq = [];
    for (const item of rawList) {
      if (seq.length === 0 || seq[seq.length - 1].skill !== item.skill) {
        seq.push({ skill: item.skill, tsMs: item.tsMs });
      }
    }

    const uniqueSkills = [...new Set(seq.map((x) => x.skill))].sort();
    for (const s of uniqueSkills) {
      skillSessions.set(s, (skillSessions.get(s) || 0) + 1);
    }

    if (uniqueSkills.length >= 2) {
      multiSkillSessions += 1;
      for (let i = 0; i < uniqueSkills.length; i++) {
        for (let j = i + 1; j < uniqueSkills.length; j++) {
          const a = uniqueSkills[i];
          const b = uniqueSkills[j];
          const pKey = `${a}\0${b}`;
          let p = pairMap.get(pKey);
          if (!p) {
            p = { a, b, sessions: new Set() };
            pairMap.set(pKey, p);
          }
          p.sessions.add(sKey);
        }
      }
    }

    if (seq.length >= 2) {
      for (let i = 0; i < seq.length - 1; i++) {
        const from = seq[i].skill;
        const to = seq[i + 1].skill;
        const tKey = `${from}\0${to}`;
        let t = transitionMap.get(tKey);
        if (!t) {
          t = { from, to, occurrences: 0, sessions: new Set(), totalDeltaMs: 0 };
          transitionMap.set(tKey, t);
        }
        t.occurrences += 1;
        t.sessions.add(sKey);
        t.totalDeltaMs += Math.max(0, seq[i + 1].tsMs - seq[i].tsMs);
      }
    }

    if (seq.length >= 3) {
      for (let i = 0; i < seq.length - 2; i++) {
        const s1 = seq[i].skill;
        const s2 = seq[i + 1].skill;
        const s3 = seq[i + 2].skill;
        const label = `${s1} -> ${s2} -> ${s3}`;
        let seqEntry = sequenceMap.get(label);
        if (!seqEntry) {
          seqEntry = { sequence: [s1, s2, s3], label, sessions: new Set() };
          sequenceMap.set(label, seqEntry);
        }
        seqEntry.sessions.add(sKey);
      }
    }
  }

  const cap = (arr) => (limit && limit > 0 ? arr.slice(0, limit) : arr);

  const transitions = cap(
    [...transitionMap.values()]
      .map((t) => {
        const sessCount = t.sessions.size;
        const fromSessions = skillSessions.get(t.from) || 1;
        return {
          from: t.from,
          to: t.to,
          sessions: sessCount,
          occurrences: t.occurrences,
          probability: Number((sessCount / Math.max(1, fromSessions)).toFixed(2)),
          avgGapSeconds: Math.round(t.totalDeltaMs / Math.max(1, t.occurrences) / 1000),
        };
      })
      .sort(
        (a, b) =>
          b.sessions - a.sessions ||
          b.occurrences - a.occurrences ||
          a.from.localeCompare(b.from) ||
          a.to.localeCompare(b.to)
      )
  );

  const sequences = cap(
    [...sequenceMap.values()]
      .map((s) => ({
        sequence: s.sequence,
        label: s.label,
        sessions: s.sessions.size,
      }))
      .sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label))
  );

  const pairs = cap(
    [...pairMap.values()]
      .map((p) => {
        const pairSessions = p.sessions.size;
        const sesA = skillSessions.get(p.a) || 0;
        const sesB = skillSessions.get(p.b) || 0;
        return {
          skills: [p.a, p.b],
          sessions: pairSessions,
          jaccard: Number((pairSessions / Math.max(1, sesA + sesB - pairSessions)).toFixed(2)),
        };
      })
      .sort(
        (a, b) =>
          b.sessions - a.sessions ||
          b.jaccard - a.jaccard ||
          a.skills[0].localeCompare(b.skills[0]) ||
          a.skills[1].localeCompare(b.skills[1])
      )
  );

  return {
    window: {
      since: since ?? 'all',
      from: sinceDate ? sinceDate.toISOString().slice(0, 10) : null,
      to: now.toISOString().slice(0, 10),
    },
    totals: {
      sessions: sessionMap.size,
      multiSkillSessions,
      transitions: transitions.length,
      pairs: pairs.length,
    },
    transitions,
    sequences,
    pairs,
  };
}
