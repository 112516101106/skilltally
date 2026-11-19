import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getHomeDir, loadConfig } from '../core/config.mjs';
import { readAllEvents } from '../core/store.mjs';
import { scanInventory } from '../inventory/scan.mjs';
import { aggregateStats } from '../report/aggregate.mjs';
import { backupFile, readJsonObject, writeJsonAtomic } from './runtime.mjs';

function normalizePluginName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.startsWith('plugin:') ? s.slice(7) : s;
}

function findCodexPluginKeysInCache(homeDir, pluginName) {
  const cacheRoot = join(homeDir, '.codex', 'plugins', 'cache');
  const keys = [];
  if (!existsSync(cacheRoot)) return keys;
  try {
    for (const mkt of readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!mkt.isDirectory() && !mkt.isSymbolicLink()) continue;
      if (existsSync(join(cacheRoot, mkt.name, pluginName))) {
        keys.push(`${pluginName}@${mkt.name}`);
      }
    }
  } catch {}
  return keys;
}

function disableCodexPluginInToml(tomlRaw, pluginName, cacheKeys) {
  const lines = tomlRaw ? tomlRaw.split(/\r?\n/) : [];
  const escaped = pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const secRe = new RegExp(`^\\[plugins\\.(?:"${escaped}@[^"]+"|'${escaped}@[^']+'|${escaped})\\]$`);

  let matchedSection = false;
  let inTargetSection = false;
  let sawEnabledLine = false;
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const clean = rawLine.replace(/#.*$/, '').trim();
    if (clean.startsWith('[')) {
      if (inTargetSection && !sawEnabledLine) {
        out.push('enabled = false');
      }
      inTargetSection = secRe.test(clean);
      if (inTargetSection) {
        matchedSection = true;
        sawEnabledLine = false;
      }
      out.push(rawLine);
      continue;
    }

    if (inTargetSection && /^enabled\s*=/.test(clean)) {
      sawEnabledLine = true;
      out.push('enabled = false');
      continue;
    }

    out.push(rawLine);
  }
  if (inTargetSection && !sawEnabledLine) {
    out.push('enabled = false');
  }

  if (matchedSection) {
    return out.join('\n').replace(/\n*$/, '\n');
  }

  if (cacheKeys.length > 0) {
    const prefix = tomlRaw && !tomlRaw.endsWith('\n') ? tomlRaw + '\n' : tomlRaw;
    const additions = cacheKeys.map((k) => `[plugins."${k}"]\nenabled = false`).join('\n\n');
    return `${prefix}${prefix ? '\n' : ''}${additions}\n`;
  }

  return null;
}

function hasCodexDisabledSkillPath(tomlRaw, canonPath) {
  if (!tomlRaw) return false;
  let inSkillCfg = false;
  let pathVal = null;
  let enabledVal = null;

  const check = () =>
    inSkillCfg && pathVal && pathVal.replace(/\\/g, '/') === canonPath && enabledVal === false;

  for (const rawLine of tomlRaw.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line === '[[skills.config]]') {
      if (check()) return true;
      inSkillCfg = true;
      pathVal = null;
      enabledVal = null;
      continue;
    }
    if (line.startsWith('[')) {
      if (check()) return true;
      inSkillCfg = false;
      pathVal = null;
      enabledVal = null;
      continue;
    }
    if (inSkillCfg) {
      const pm = line.match(/^path\s*=\s*(?:"([^"]+)"|'([^']+)')/);
      if (pm) pathVal = pm[1] || pm[2];
      const em = line.match(/^enabled\s*=\s*(true|false)\b/);
      if (em) enabledVal = em[1] === 'true';
    }
  }
  return check();
}

function appendCodexDisabledSkill(tomlRaw, canonPath) {
  if (hasCodexDisabledSkillPath(tomlRaw, canonPath)) return null;
  const escaped = canonPath.replace(/\\/g, '/').replace(/"/g, '\\"');
  const prefix = tomlRaw ? (tomlRaw.endsWith('\n') ? tomlRaw : tomlRaw + '\n') : '';
  return `${prefix}${prefix ? '\n' : ''}[[skills.config]]\npath = "${escaped}"\nenabled = false\n`;
}

function writeTextAtomic(filePath, text, mode = 0o600) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, filePath);
}

/**
 * Safely disable 100%-unused plugins or explicitly specified unused skills
 * across Antigravity and Codex with automatic config backups.
 */
export function runPrune({
  homeDir = homedir(),
  dataHome = getHomeDir(),
  cwd = process.cwd(),
  since = '90d',
  host = 'all',
  plugins = [],
  skills = [],
  dryRun = false,
  now = new Date(),
} = {}) {
  const { events } = readAllEvents(dataHome);
  const config = loadConfig(dataHome);
  const inventory = scanInventory({ homeDir, cwd, includeProject: false });
  const filterHost = !host || host === 'all' ? null : host;
  const report = aggregateStats({
    events,
    inventory,
    config,
    since,
    host: filterHost,
    now,
  });

  const enabledBySource = new Map();
  for (const s of inventory.skills) {
    if (!s.enabled) continue;
    let list = enabledBySource.get(s.source);
    if (!list) {
      list = [];
      enabledBySource.set(s.source, list);
    }
    list.push(s);
  }

  const reqPlugins = new Set(plugins.map(normalizePluginName).filter(Boolean));
  const reqSkills = new Set(skills.map((s) => String(s || '').trim()).filter(Boolean));
  const targetPluginsOnly = reqPlugins.size > 0;
  const targetSkillsOnly = reqSkills.size > 0 && reqPlugins.size === 0;

  // Qualifying 100% unused plugins
  const qualifyingPlugins = [];
  if (!targetSkillsOnly) {
    for (const group of report.unused.bySource) {
      if (!group.source.startsWith('plugin:')) continue;
      const pluginName = group.source.slice(7);
      if (targetPluginsOnly && !reqPlugins.has(pluginName)) continue;

      const totalEnabledInSource = (enabledBySource.get(group.source) || []).length;
      if (totalEnabledInSource === 0 || group.skillCount < totalEnabledInSource) {
        continue;
      }

      const hostsSet = new Set();
      for (const s of group.skills) {
        for (const h of s.hosts || []) hostsSet.add(h);
      }

      qualifyingPlugins.push({
        source: group.source,
        plugin: pluginName,
        skillCount: group.skillCount,
        estTokens: group.estTokens,
        descChars: group.descChars,
        hosts: [...hostsSet],
      });
    }
  }

  const allowAntigravity = !filterHost || filterHost === 'antigravity';
  const allowCodex = !filterHost || filterHost === 'codex';

  const disabledPlugins = [];
  const disabledSkills = [];
  const backups = [];

  // 1. Disable Antigravity plugins via ~/.gemini/config/config.json
  if (allowAntigravity && qualifyingPlugins.length > 0) {
    const agyCfgPath = join(homeDir, '.gemini', 'config', 'config.json');
    const agyTargets = qualifyingPlugins.filter((p) => {
      if (!p.hosts.includes('antigravity')) return false;
      return (
        existsSync(join(homeDir, '.gemini', 'config', 'plugins', p.plugin)) ||
        existsSync(join(homeDir, '.gemini', 'antigravity', 'builtin', 'plugins', p.plugin))
      );
    });

    if (agyTargets.length > 0) {
      const doc = existsSync(agyCfgPath) ? readJsonObject(agyCfgPath) : {};
      const pluginsObj =
        doc.plugins && typeof doc.plugins === 'object' && !Array.isArray(doc.plugins)
          ? { ...doc.plugins }
          : {};
      let agyChanged = false;

      for (const p of agyTargets) {
        const cur = pluginsObj[p.plugin];
        if (!cur || cur.enabled !== false) {
          pluginsObj[p.plugin] = { ...(cur && typeof cur === 'object' ? cur : {}), enabled: false };
          agyChanged = true;
          disabledPlugins.push({
            source: p.source,
            plugin: p.plugin,
            host: 'antigravity',
            skillCount: p.skillCount,
            estTokens: p.estTokens,
            descChars: p.descChars,
          });
        }
      }

      if (agyChanged) {
        doc.plugins = pluginsObj;
        const bak = backupFile(agyCfgPath, dataHome, 'antigravity-config-prune', dryRun);
        if (bak) backups.push(bak);
        if (!dryRun) {
          writeJsonAtomic(agyCfgPath, doc, 0o600);
        }
      }
    }
  }

  // 2. Disable Codex plugins & explicitly requested Codex skills via ~/.codex/config.toml
  if (allowCodex) {
    const codexTomlPath = join(homeDir, '.codex', 'config.toml');
    let tomlRaw = existsSync(codexTomlPath) ? readFileSync(codexTomlPath, 'utf8') : '';
    let codexChanged = false;

    for (const p of qualifyingPlugins) {
      if (!p.hosts.includes('codex')) continue;
      const cacheKeys = findCodexPluginKeysInCache(homeDir, p.plugin);
      const updated = disableCodexPluginInToml(tomlRaw, p.plugin, cacheKeys);
      if (updated !== null && updated !== tomlRaw) {
        tomlRaw = updated;
        codexChanged = true;
        disabledPlugins.push({
          source: p.source,
          plugin: p.plugin,
          host: 'codex',
          skillCount: p.skillCount,
          estTokens: p.estTokens,
          descChars: p.descChars,
        });
      }
    }

    if (reqSkills.size > 0) {
      const unusedSkillSet = new Set();
      for (const g of report.unused.bySource) {
        for (const s of g.skills) unusedSkillSet.add(s.path);
      }

      for (const s of inventory.skills) {
        if (!s.enabled) continue;
        if (!reqSkills.has(s.name) && !reqSkills.has(s.dir_name)) continue;
        if (!s.hosts.includes('codex')) continue;
        // Prefer disabling only unused skills unless explicitly absent from used rows
        if (!unusedSkillSet.has(s.path) && report.rows.some((r) => r.skill === s.name)) {
          continue;
        }
        const updated = appendCodexDisabledSkill(tomlRaw, s.path);
        if (updated !== null && updated !== tomlRaw) {
          tomlRaw = updated;
          codexChanged = true;
          disabledSkills.push({
            name: s.name,
            source: s.source,
            host: 'codex',
            path: s.path,
            est_tokens: s.est_tokens || 0,
            desc_chars: s.desc_chars || 0,
          });
        }
      }
    }

    if (codexChanged) {
      const bak = backupFile(codexTomlPath, dataHome, 'codex-config-prune', dryRun);
      if (bak) backups.push(bak);
      if (!dryRun) {
        writeTextAtomic(codexTomlPath, tomlRaw, 0o600);
      }
    }
  }

  // Deduplicate savings across hosts if the same plugin appeared on multiple hosts
  const seenSavingsKeys = new Set();
  let savedTokensPerSession = 0;
  let savedDescChars = 0;

  for (const p of disabledPlugins) {
    if (seenSavingsKeys.has(p.source)) continue;
    seenSavingsKeys.add(p.source);
    savedTokensPerSession += p.estTokens || 0;
    savedDescChars += p.descChars || 0;
  }
  for (const s of disabledSkills) {
    if (seenSavingsKeys.has(s.path)) continue;
    seenSavingsKeys.add(s.path);
    savedTokensPerSession += s.est_tokens || 0;
    savedDescChars += s.desc_chars || 0;
  }

  return {
    dryRun,
    window: report.window,
    disabledPlugins,
    disabledSkills,
    savedTokensPerSession,
    savedKb: Number((savedDescChars / 1024).toFixed(1)),
    backups,
  };
}
