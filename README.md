# skilltally

[![CI](https://github.com/112516101106/skilltally/actions/workflows/ci.yml/badge.svg)](https://github.com/112516101106/skilltally/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

Real-time skill usage tracking via hooks for **Antigravity**, **Claude Code**, **Codex**, and **Gemini CLI** — 100% local, zero dependencies.

Find out which agent skills you actually use, and how much context (`KB` / `~tokens/session`) unused skills and plugins cost you on every turn.

## Quick Start

```bash
# 1. Detect installed agents and register lightweight PostToolUse/AfterTool hooks
npx skilltally install --dry-run
npx skilltally install

# 2. Import historical sessions from local logs
npx skilltally backfill

# 3. Verify hook registration and run live self-test
npx skilltally doctor

# 4. Inspect usage and unused context tax
npx skilltally stats --since 30d
npx skilltally unused --since 90d
```

Or ask your coding agent directly: *"Which agent skills do I use the most?"*

## Supported Agents

| Agent | Real-time hook | History backfill | Plugin / Extension install | Notes |
|---|---|---|---|---|
| **Antigravity** | `PostToolUse` (`read_file\|view_file`) | `~/.gemini/antigravity*/brain/` | Native plugin (`plugin.json` + `hooks.json`) | POSIX fast-path skips Node on misses (~7 ms); reads `transcript_full.jsonl` when truncated |
| **Claude Code** | `PostToolUse` (`Skill\|Read`, `async: true`) | `~/.claude/projects/**/*.jsonl` | `.claude-plugin/plugin.json` | Collapses `Skill` + `Read` calls within 5 s |
| **Codex** | `PostToolUse` (async) | `~/.codex/{sessions,archived_sessions}/` | `.codex-plugin/plugin.json` | Supports `.jsonl.zst` archives natively on Node `>= 22.15`; approve via `/hooks` |
| **Gemini CLI** | `AfterTool` (`activate_skill`) | `~/.gemini/tmp/*/chats/*.{json,jsonl}` | `gemini-extension.json` + `install --host gemini` | `timeout: 5000` ms in `~/.gemini/settings.json` |

## Plugin & Skill Installation

If you prefer native plugin managers over `npx skilltally install`:

- **Antigravity**: Copy or symlink this repository to `~/.gemini/config/plugins/skilltally` (or run `npx skilltally install --host antigravity`).
- **Claude Code**:
  ```text
  /plugin marketplace add 112516101106/skilltally
  /plugin install skilltally@skilltally
  ```
- **Codex**:
  ```bash
  codex plugin marketplace add https://github.com/112516101106/skilltally.git
  codex plugin add skilltally@skilltally
  ```
  Run `codex`, open `/hooks`, and trust the `skilltally` `PostToolUse` hook.
- **Gemini CLI**:
  ```bash
  gemini extensions install https://github.com/112516101106/skilltally
  npx skilltally install --host gemini
  ```
- **Companion skill only (`skills.sh`)**:
  ```bash
  npx skills add 112516101106/skilltally
  ```

## Example Output

### `skilltally stats --since 30d`

```text
skilltally — last 30d (2026-10-20 -> 2026-11-19)
hosts: antigravity 35 · codex 12
triggers: auto 38 · manual 9

   #  skill                     activations  reads  last used         hosts               trend (14d)
   1  requesting-code-review              8     10  2026-11-12 14:03  antigravity, codex  ··▁·▃·█··▃·▁··
   2  systematic-debugging                5      9  2026-11-10 09:41  codex               ····▁··█··▁···
   3  agent-browser                       3      4  2026-11-05 12:18  antigravity, codex  ··█···········

installed: 214 · used: 22 · unused: 192  ->  run `skilltally unused`
```

### `skilltally unused --since 90d`

```text
Unused enabled skills — last 90d (2026-08-21 -> 2026-11-19): 192 (48.2 KB ≈ ~12,340 tok/session)
context tax: [████████████░░░░] 76% unused (~12,340 / ~16,200 tok/session)

  plugin:science       47 skills   14.8 KB  ~ 3818 tok/session
    alphagenome-atlas-website-links, alphagenome-single-variant-analysis, … (+41)
  personal             47 skills   10.6 KB  ~ 2729 tok/session
    architecture-blueprint-generator, auditing-python-security, … (+41)

Tip: disabling an unused plugin removes all of its skill descriptions from every session context.
```

## CLI Reference

| Command | Description | Key flags |
|---|---|---|
| `install` | Install hooks for detected hosts (`runtime/track.mjs` + backups) | `--host all\|antigravity\|claude\|codex\|gemini`, `--dry-run`, `--force`, `--json` |
| `uninstall` | Remove `skilltally` hooks (preserves all other user hooks) | `--host ...`, `--purge`, `--dry-run`, `--json` |
| `doctor` | Check Node version, hook paths, Codex trust, events, and live self-test | `--json` |
| `backfill` | Import historical skill reads/invocations from local logs | `--host ...`, `--since DATE`, `--dry-run`, `--json` |
| `stats` | Usage table sorted by `activations` with 14-day sparklines and trigger ratio | `--since 30d\|all\|YYYY-MM-DD`, `--host`, `--project`, `--by-source`, `--metric reads`, `--json` |
| `top` | Top `N` skills | `-n 20`, plus `stats` flags |
| `unused` | Enabled installed skills with 0 activations and Context Tax breakdown | `--since 90d`, `--host`, `--all`, `--json` |
| `timeline` | ASCII usage bar chart over time | `--skill <name>`, `--by day\|week\|month`, `--since`, `--host`, `--project`, `--json` |
| `chains` | Skill transition chains (`A -> B`), 3-step workflows, and co-occurring pairs | `--since`, `--host`, `--project`, `-n 20`, `--json` |
| `insights` | Context ROI, manual-only triggers, single-project scoping candidates, model stats | `--since`, `--host`, `--project`, `--json` |
| `dashboard` | Generate self-contained offline HTML dashboard (SVG Treemap, chains, Mermaid) | `-o <file>`, `--since`, `--host`, `--project`, `--open`, `--json` |
| `prune` | Safely disable 100%-unused plugins or specific unused skills (with backups) | `--since 90d`, `--host all\|antigravity\|codex`, `--plugin <name>`, `--skill <name>`, `--dry-run`, `--json` |
| `export` | Export deduplicated events as JSON or RFC-4180 CSV | `--format json\|csv`, `-o <file>`, `--since`, `--host`, `--project`, `--include-failed` |
| `inventory` | List installed skills, sources, hosts, enabled state, and description sizes | `--no-project`, `--json` |
| `mcp` | Start zero-dependency stdio MCP server (`skilltally_*` tools) | — |
| `debug` | Toggle opt-in raw stdin logging (`on \| off \| status`) | `--json` |

## Privacy, Performance & Reliability

- **100% local, zero telemetry**: Zero network requests, zero third-party runtime dependencies.
- **No raw arguments stored**: Only the matched `SKILL.md` path (or `Skill`/`activate_skill` name) and `basename(cwd)` are written to `~/.skilltally/` (`0700` dir, `0600` files). Full `cwd` is omitted unless `store_cwd: true` is set in `~/.skilltally/config.json`.
- **Safe by contract**: `track.mjs` never throws, always exits `0`, and always writes `{}` to `stdout` so hooks never interrupt an agent turn.
- **Automatic rotation**: When `events.jsonl` exceeds 20 MB, it rotates automatically to `events-YYYY-MM.jsonl` while reports transparently read all archives.
- **Config backups**: `install` and `uninstall` back up modified host configs to `~/.skilltally/backups/`.

### Configuration (`~/.skilltally/config.json`)

```json
{
  "exclude_skills": ["skilltally"],
  "exclude_sources": [],
  "aliases": { "native_swarm": "swarm" },
  "store_cwd": false
}
```

## Troubleshooting

- **No events recorded?** Run `npx skilltally doctor` to verify hook paths and run the live pipe self-test.
- **Codex hooks not firing?** Run `codex` and open `/hooks` to review and trust the `skilltally` `PostToolUse` hook.
- **Gemini CLI hooks disabled?** Check `"hooksConfig": { "enabled": true }` in `~/.gemini/settings.json`.
- **Inspecting unknown hook payloads:** Temporarily run `npx skilltally debug on`, trigger a skill once, inspect `~/.skilltally/debug.jsonl`, then run `npx skilltally debug off` (which deletes `debug.jsonl` automatically).

## Development

```bash
npm test
npm run check:pack
```

## License

MIT — [112516101106/skilltally](https://github.com/112516101106/skilltally)
