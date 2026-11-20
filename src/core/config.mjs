import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  exclude_skills: [],
  exclude_sources: [],
  aliases: {},
  store_cwd: false,
  store_prompts: false,
});

export function getHomeDir(env = process.env) {
  return env.SKILLTALLY_HOME || join(homedir(), '.skilltally');
}

export function loadConfig(homeDir = getHomeDir()) {
  try {
    const raw = readFileSync(join(homeDir, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CONFIG };
    return {
      exclude_skills: Array.isArray(parsed.exclude_skills) ? parsed.exclude_skills.map(String) : [],
      exclude_sources: Array.isArray(parsed.exclude_sources) ? parsed.exclude_sources.map(String) : [],
      aliases:
        parsed.aliases && typeof parsed.aliases === 'object' && !Array.isArray(parsed.aliases)
          ? { ...parsed.aliases }
          : {},
      store_cwd: parsed.store_cwd === true,
      store_prompts: parsed.store_prompts === true,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
