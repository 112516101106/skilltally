# skilltally

Real-time skill usage tracking via hooks for Antigravity, Claude Code, Codex & Gemini CLI — 100% local, zero dependencies.

Find out which agent skills you actually use, and how much context (`KB` / `~tokens/session`) unused skills and plugins cost you on every turn.

## Features (v0.1.0 — M1)

- **Real-time hook tracking (`bin/track.mjs`)**: Appends one normalized JSONL line to `~/.skilltally/events.jsonl` whenever an agent activates a skill (reads `SKILL.md` or invokes `Skill` / `activate_skill`).
- **Antigravity native plugin (`plugin.json` + `hooks.json`)**: Uses a POSIX shell fast-path (`hooks/agy-fast-track.sh`, ~7 ms on misses) so unrelated tool calls never spawn Node.js.
- **History backfill (`skilltally backfill`)**: Imports historical sessions from Antigravity (`antigravity`, `antigravity-cli`, `antigravity-ide`, including `transcript_full.jsonl` when `tool_calls` are truncated) and Codex (`~/.codex/sessions` + `~/.codex/archived_sessions`, including `.jsonl.zst` archives via Node's built-in `zlib.zstdDecompressSync`).
- **Inventory & Context Tax (`skilltally inventory`, `skilltally unused`)**: Scans installed skills, respects disabled plugins/skills, parses `SKILL.md` frontmatter, and calculates estimated context tokens consumed per session.
- **Zero dependencies & local-first**: Runs on Node.js `>= 18` (Node `>= 22.15` recommended for native `.zst` Codex archive decompression). No network calls, no telemetry.

## Quick Start

```bash
git clone https://github.com/112516101106/skilltally.git
cd skilltally

# Import existing Antigravity & Codex history
node bin/cli.mjs backfill

# View usage stats (primary metric: unique session × skill activations)
node bin/cli.mjs stats --since 30d
node bin/cli.mjs top -n 20 --since all

# See unused enabled skills and context savings by plugin
node bin/cli.mjs unused --since 90d

# Inspect installed skills
node bin/cli.mjs inventory
```

### Enable real-time tracking in Antigravity

Link or copy this repository into `~/.gemini/config/plugins/skilltally`:

```bash
ln -s /path/to/skilltally ~/.gemini/config/plugins/skilltally
```

Or ask your agent: *"Which skills do I use the most?"* — the bundled `skills/skilltally/SKILL.md` teaches the agent how to query `skilltally`.

## Architecture

- **Primary metric**: `activations` (unique `(session_id, skill)` pairs) — reading a skill 3 times in the same session still counts as 1 activation.
- **Secondary metric**: `reads` (total invocations).
- **Storage**: `~/.skilltally/` (`0700` dir, `0600` files, override via `SKILLTALLY_HOME`):
  - `events.jsonl`: real-time hook events.
  - `events.backfill.jsonl`: idempotent backfill output (re-running `backfill` overwrites cleanly; real-time `hook` events take priority during deduplication).

## Development

```bash
npm test
```

## License

MIT — [112516101106/skilltally](https://github.com/112516101106/skilltally)
