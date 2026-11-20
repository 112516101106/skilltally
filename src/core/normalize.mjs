import { realpathSync } from 'node:fs';
import { resolveSource } from './detect.mjs';

function normalizePathKey(p) {
  if (!p) return '';
  let resolved = String(p);
  try {
    resolved = realpathSync(resolved);
  } catch {}
  return resolved.replace(/\\/g, '/');
}

function isMalformedPluginVersionSource(src) {
  return typeof src === 'string' && /^plugin:(?:v?\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?|latest)$/i.test(src);
}

export function canonicalizeEvent(ev, inventoryIndex = null, aliases = {}) {
  let skill = String(ev.skill || '');
  let source = ev.source || 'unknown';

  const nsMatch = skill.match(/^([A-Za-z0-9._-]+):+([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/);
  if (nsMatch) {
    skill = nsMatch[2];
    if (!source || source === 'unknown') {
      source = `plugin:${nsMatch[1]}`;
    }
  }

  if (ev.skill_path && (!source || source === 'unknown' || isMalformedPluginVersionSource(source))) {
    const fixedSrc = resolveSource(ev.skill_path);
    if (fixedSrc !== 'unknown') source = fixedSrc;
  }

  if (inventoryIndex) {
    let entry = null;
    if (ev.skill_path) {
      entry = inventoryIndex.byPath?.get(normalizePathKey(ev.skill_path)) ?? null;
      if (!entry) {
        entry = inventoryIndex.byPath?.get(String(ev.skill_path).replace(/\\/g, '/')) ?? null;
      }
    }
    if (!entry && skill) {
      if (source && source !== 'unknown') {
        entry = inventoryIndex.bySkillAndSource?.get(`${skill}\0${source}`) ?? null;
      }
      if (!entry) {
        entry = inventoryIndex.byDirName?.get(skill) ?? inventoryIndex.byName?.get(skill) ?? null;
      }
    }
    if (entry) {
      if (entry.name) skill = entry.name;
      if ((!source || source === 'unknown' || isMalformedPluginVersionSource(source)) && entry.source) {
        source = entry.source;
      }
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

function isManualTriggerVia(via) {
  return via === 'slash_command' || via === 'mention';
}

function isAutoTriggerVia(via) {
  return via === 'read' || via === 'shell_read';
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
        const dupMatch = prev?.find((p) => Math.abs(p.tsMs - tsMs) <= windowMs);
        if (dupMatch) {
          if (isManualTriggerVia(ev.via) && isAutoTriggerVia(dupMatch.ev.via)) {
            dupMatch.ev.via = ev.via;
          }
          continue;
        }
        const cloned = { ...ev };
        if (prev) prev.push({ tsMs, ev: cloned });
        else seenWindows.set(key, [{ tsMs, ev: cloned }]);
        out.push(cloned);
        continue;
      }
    }

    out.push(ev);
  }

  return out;
}
