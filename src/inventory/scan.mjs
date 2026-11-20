import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { resolveSource } from '../core/detect.mjs';

function stripJsonCommentsAndTrailingCommas(raw) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function readJsonSafe(filePath, jsonc = false) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(jsonc ? stripJsonCommentsAndTrailingCommas(raw) : raw);
  } catch {
    return null;
  }
}

export function parseFrontmatter(md) {
  const clean = String(md || '').replace(/^\uFEFF/, '');
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { name: '', description: '' };

  const lines = match[1].split(/\r?\n/);
  const fields = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2].trim();

    if (/^[>|][+-]?$/.test(rest)) {
      const folded = rest.startsWith('>');
      const block = [];
      let minIndent = Infinity;
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (nextLine.trim() === '') {
          block.push('');
          i++;
          continue;
        }
        const indentMatch = nextLine.match(/^([ \t]+)/);
        if (!indentMatch) break;
        minIndent = Math.min(minIndent, indentMatch[1].length);
        block.push(nextLine);
        i++;
      }
      const strip = Number.isFinite(minIndent) ? minIndent : 0;
      const normalized = block.map((l) => (l.length >= strip ? l.slice(strip) : ''));
      while (normalized.length > 0 && normalized[normalized.length - 1] === '') normalized.pop();
      fields[key] = (folded ? normalized.join(' ').replace(/\s+/g, ' ') : normalized.join('\n')).trim();
    } else {
      const parts = [rest];
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      let val = parts.join(' ').trim();
      if (
        val.length >= 2 &&
        ((val[0] === '"' && val[val.length - 1] === '"') ||
          (val[0] === "'" && val[val.length - 1] === "'"))
      ) {
        val = val.slice(1, -1);
      }
      fields[key] = val;
    }
  }

  return {
    name: fields.name || '',
    description: fields.description || '',
  };
}

function normalizePath(p) {
  if (!p) return '';
  let resolved = String(p);
  try {
    resolved = realpathSync(resolved);
  } catch {}
  return resolved.replace(/\\+/g, '/');
}

function readAntigravityPluginStates(homeDir) {
  const cfg = readJsonSafe(join(homeDir, '.gemini', 'config', 'config.json'));
  const pluginsCfg = cfg?.plugins && typeof cfg.plugins === 'object' ? cfg.plugins : {};
  const map = new Map();
  for (const [dir, state] of Object.entries(pluginsCfg)) {
    if (state && typeof state === 'object' && typeof state.enabled === 'boolean') {
      map.set(dir, state.enabled);
    }
  }
  return map;
}

function readCodexConfigStates(homeDir) {
  const disabledSkillPaths = new Set();
  const pluginEnabled = new Map();
  const tomlPath = join(homeDir, '.codex', 'config.toml');
  if (!existsSync(tomlPath)) return { disabledSkillPaths, pluginEnabled };

  let raw;
  try {
    raw = readFileSync(tomlPath, 'utf8');
  } catch {
    return { disabledSkillPaths, pluginEnabled };
  }

  let sectionType = null;
  let sectionKey = null;
  let skillCfgPath = null;
  let skillCfgEnabled = null;

  const flushSkillCfg = () => {
    if (sectionType === 'skills.config' && skillCfgPath && skillCfgEnabled === false) {
      disabledSkillPaths.add(normalizePath(skillCfgPath));
    }
    skillCfgPath = null;
    skillCfgEnabled = null;
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    if (line === '[[skills.config]]') {
      flushSkillCfg();
      sectionType = 'skills.config';
      sectionKey = null;
      continue;
    }

    const pluginSec = line.match(/^\[plugins\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]$/);
    if (pluginSec) {
      flushSkillCfg();
      sectionType = 'plugin';
      sectionKey = pluginSec[1] || pluginSec[2] || pluginSec[3];
      continue;
    }

    if (line.startsWith('[')) {
      flushSkillCfg();
      sectionType = null;
      sectionKey = null;
      continue;
    }

    if (sectionType === 'plugin' && sectionKey) {
      const m = line.match(/^enabled\s*=\s*(true|false)\b/);
      if (m) pluginEnabled.set(sectionKey, m[1] === 'true');
    } else if (sectionType === 'skills.config') {
      const pm = line.match(/^path\s*=\s*(?:"([^"]+)"|'([^']+)')/);
      if (pm) skillCfgPath = pm[1] || pm[2];
      const em = line.match(/^enabled\s*=\s*(true|false)\b/);
      if (em) skillCfgEnabled = em[1] === 'true';
    }
  }
  flushSkillCfg();

  return { disabledSkillPaths, pluginEnabled };
}

function listImmediateSkillDirs(skillsRoot) {
  if (!existsSync(skillsRoot)) return [];
  let entries;
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const skillMd = join(skillsRoot, e.name, 'SKILL.md');
    if (existsSync(skillMd)) {
      results.push({ dirName: e.name, skillMd });
    }
  }
  return results;
}

function listDirectories(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink()))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function pickCodexCacheVersion(pluginDir) {
  const versions = listDirectories(pluginDir);
  if (versions.length === 0) return null;
  if (versions.includes('latest')) return 'latest';
  return versions[versions.length - 1];
}

function walkClaudePluginSkills(baseDir, depth = 0, out = []) {
  if (depth > 5 || !existsSync(baseDir)) return out;
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const full = join(baseDir, e.name);
    if (e.name === 'skills') {
      out.push(...listImmediateSkillDirs(full));
    } else {
      walkClaudePluginSkills(full, depth + 1, out);
    }
  }
  return out;
}

export function scanInventory({ homeDir = homedir(), cwd = process.cwd(), includeProject = true } = {}) {
  const agyStates = readAntigravityPluginStates(homeDir);
  const { disabledSkillPaths, pluginEnabled: codexPluginEnabled } = readCodexConfigStates(homeDir);

  const byCanonPath = new Map();

  const register = ({ dirName, skillMd, host, source, enabled = true }) => {
    let md;
    try {
      md = readFileSync(skillMd, 'utf8');
    } catch {
      return;
    }
    const fm = parseFrontmatter(md);
    const canon = normalizePath(skillMd);
    if (disabledSkillPaths.has(canon)) {
      enabled = false;
    }

    const existing = byCanonPath.get(canon);
    if (existing) {
      if (!existing.hosts.includes(host)) existing.hosts.push(host);
      existing.enabled = existing.enabled || enabled;
      return;
    }

    const descChars = fm.description.length;
    const bytes = Buffer.byteLength(md, 'utf8');
    byCanonPath.set(canon, {
      name: fm.name || dirName,
      dir_name: dirName,
      path: canon,
      source: source || resolveSource(canon, cwd, homeDir),
      hosts: [host],
      bytes,
      desc_chars: descChars,
      est_tokens: descChars > 0 ? Math.ceil(descChars / 4) : 0,
      body_tokens: bytes > 0 ? Math.ceil(bytes / 4) : 0,
      enabled,
    });
  };

  // 1. Built-in & Plugins first so symlinked personal entries preserve plugin/builtin source.
  for (const item of listImmediateSkillDirs(join(homeDir, '.gemini', 'antigravity', 'builtin', 'skills'))) {
    register({ ...item, host: 'antigravity', source: 'builtin', enabled: true });
  }

  const agyBuiltinPluginsDir = join(homeDir, '.gemini', 'antigravity', 'builtin', 'plugins');
  for (const pluginDir of listDirectories(agyBuiltinPluginsDir)) {
    const manifest = readJsonSafe(join(agyBuiltinPluginsDir, pluginDir, 'plugin.json'), true);
    const cfgState = agyStates.get(pluginDir);
    const enabled = cfgState !== undefined ? cfgState : manifest?.disabled !== true;
    for (const item of listImmediateSkillDirs(join(agyBuiltinPluginsDir, pluginDir, 'skills'))) {
      register({ ...item, host: 'antigravity', source: `plugin:${pluginDir}`, enabled });
    }
  }

  const agyPluginsDir = join(homeDir, '.gemini', 'config', 'plugins');
  for (const pluginDir of listDirectories(agyPluginsDir)) {
    const manifest = readJsonSafe(join(agyPluginsDir, pluginDir, 'plugin.json'), true);
    const cfgState = agyStates.get(pluginDir);
    const enabled = cfgState !== undefined ? cfgState : manifest?.disabled !== true;
    for (const item of listImmediateSkillDirs(join(agyPluginsDir, pluginDir, 'skills'))) {
      register({ ...item, host: 'antigravity', source: `plugin:${pluginDir}`, enabled });
    }
  }

  const codexCacheRoot = join(homeDir, '.codex', 'plugins', 'cache');
  for (const mkt of listDirectories(codexCacheRoot)) {
    for (const pluginName of listDirectories(join(codexCacheRoot, mkt))) {
      const pluginRoot = join(codexCacheRoot, mkt, pluginName);
      const ver = pickCodexCacheVersion(pluginRoot);
      if (!ver) continue;
      const key = `${pluginName}@${mkt}`;
      const enabled = codexPluginEnabled.get(key) !== false;
      for (const item of listImmediateSkillDirs(join(pluginRoot, ver, 'skills'))) {
        register({ ...item, host: 'codex', source: `plugin:${pluginName}`, enabled });
      }
    }
  }

  const claudePluginsRoot = join(homeDir, '.claude', 'plugins');
  for (const item of walkClaudePluginSkills(claudePluginsRoot)) {
    const src = resolveSource(item.skillMd, cwd, homeDir);
    register({ ...item, host: 'claude', source: src !== 'unknown' ? src : 'plugin:claude', enabled: true });
  }

  // 2. Personal skill roots
  const personalRoots = [
    { dir: join(homeDir, '.gemini', 'config', 'skills'), host: 'antigravity' },
    { dir: join(homeDir, '.gemini', 'skills'), host: 'gemini' },
    { dir: join(homeDir, '.agents', 'skills'), host: 'codex' },
    { dir: join(homeDir, '.codex', 'skills'), host: 'codex' },
    { dir: join(homeDir, '.claude', 'skills'), host: 'claude' },
  ];
  for (const root of personalRoots) {
    for (const item of listImmediateSkillDirs(root.dir)) {
      register({ ...item, host: root.host, source: 'personal', enabled: true });
    }
  }

  // 3. Project-level skills
  if (includeProject && cwd) {
    const projectRoots = [
      { dir: join(cwd, '.agents', 'skills'), host: 'antigravity' },
      { dir: join(cwd, '.claude', 'skills'), host: 'claude' },
      { dir: join(cwd, '.gemini', 'skills'), host: 'gemini' },
    ];
    for (const root of projectRoots) {
      for (const item of listImmediateSkillDirs(root.dir)) {
        register({ ...item, host: root.host, source: 'project', enabled: true });
      }
    }
  }

  const skills = [...byCanonPath.values()].sort((a, b) => a.name.localeCompare(b.name));

  // Build lookup indexes (prefer enabled entries when duplicates exist by dir_name or name).
  const byPath = new Map();
  const byDirName = new Map();
  const byName = new Map();

  for (const entry of skills) {
    byPath.set(entry.path, entry);
    const prevDir = byDirName.get(entry.dir_name);
    if (!prevDir || (!prevDir.enabled && entry.enabled)) {
      byDirName.set(entry.dir_name, entry);
    }
    const prevName = byName.get(entry.name);
    if (!prevName || (!prevName.enabled && entry.enabled)) {
      byName.set(entry.name, entry);
    }
  }

  return {
    skills,
    index: { byPath, byDirName, byName },
  };
}
