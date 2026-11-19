import { realpathSync } from 'node:fs';

function normalizePathKey(p) {
  if (!p) return '';
  let resolved = String(p);
  try {
    resolved = realpathSync(resolved);
  } catch {}
  return resolved.replace(/\\/g, '/');
}

export function canonicalizeEvent(ev, inventoryIndex = null, aliases = {}) {
  let skill = String(ev.skill || '');
  let source = ev.source || 'unknown';

  if (inventoryIndex) {
    let entry = null;
    if (ev.skill_path) {
      entry = inventoryIndex.byPath?.get(normalizePathKey(ev.skill_path)) ?? null;
      if (!entry) {
        entry = inventoryIndex.byPath?.get(String(ev.skill_path).replace(/\\/g, '/')) ?? null;
      }
    }
    if (!entry && skill) {
      entry = inventoryIndex.byDirName?.get(skill) ?? inventoryIndex.byName?.get(skill) ?? null;
    }
    if (entry) {
      if (entry.name) skill = entry.name;
      if ((!source || source === 'unknown') && entry.source) source = entry.source;
    }
  }

  if (aliases && Object.prototype.hasOwnProperty.call(aliases, skill)) {
    skill = String(aliases[skill]);
  }

  return {
    ...ev,
    skill,
    source,
  };
}

export function dedupeEvents(events, windowMs = 30_000) {
  // Prioritize real-time hook events over backfill events when deduplicating.
  const ordered = [
    ...events.filter((e) => e.origin === 'hook'),
    ...events.filter((e) => e.origin !== 'hook'),
  ];

  const seenIds = new Set();
  const seenWindows = new Map();
  const out = [];

  for (const ev of ordered) {
    if (ev.id) {
      if (seenIds.has(ev.id)) continue;
      seenIds.add(ev.id);
    }

    if (ev.session_id && ev.ts) {
      const tsMs = Date.parse(ev.ts);
      if (Number.isFinite(tsMs)) {
        const key = `${ev.host || 'unknown'}\0${ev.session_id}\0${ev.skill}`;
        const prev = seenWindows.get(key);
        if (prev && prev.some((p) => Math.abs(p - tsMs) <= windowMs)) {
          continue;
        }
        if (prev) prev.push(tsMs);
        else seenWindows.set(key, [tsMs]);
      }
    }

    out.push(ev);
  }

  return out;
}
