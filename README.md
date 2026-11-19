# skilltally

Real-time skill usage tracking via hooks for Antigravity, Claude Code, Codex & Gemini CLI — 100% local, zero dependencies.

Find out which agent skills you actually use, and how much context (`KB` / `~tokens/session`) unused skills and plugins cost you on every turn.

## Features (v0.2.0 — M2)

- **One-command installer & health check (`install`, `uninstall`, `doctor`)**: Idempotently installs hooks for detected agents (Antigravity, Claude Code, Codex), backs up existing configs to `~/.skilltally/backups/`, and verifies runtime health with a live self-test.
- **Real-time hook tracking (`bin/track.mjs`)**: Appends one normalized JSONL line to `~/.skilltally/events.jsonl` whenever an agent activates a skill (reads `SKILL.md` or invokes `Skill` / `activate_skill`).
- **Multi-platform plugin packaging**: Ships native plugin manifests for Antigravity (`plugin.json` + `hooks.json`), Claude Code (`.claude-plugin/`), and Codex (`.codex-plugin/` + `.agents/plugins/marketplace.json`), sharing `hooks/claude-codex-hooks.json` with `async: true`.
- **History backfill (`skilltally backfill`)**: Imports historical sessions from Antigravity (`antigravity`, `antigravity-cli`, `antigravity-ide`, including `transcript_full.jsonl` when `tool_calls` are truncated), Codex (`~/.codex/sessions` + `~/.codex/archived_sessions`, including `.jsonl.zst` archives via Node's built-in `zlib.zstdDecompressSync`), and Claude Code (`~/.claude/projects/**/*.jsonl`).
- **Inventory & Context Tax (`skilltally inventory`, `skilltally unused`)**: Scans installed skills, respects disabled plugins/skills, parses `SKILL.md` frontmatter, and calculates estimated context tokens consumed per session.
- **Zero dependencies & local-first**: Runs on Node.js `>= 18` (Node `>= 22.15` recommended for native `.zst` Codex archive decompression). No network calls, no telemetry.

## Quick Start

```bash
git clone https://github.com/112516101106/skilltally.git
cd skilltally

# Install hooks for detected agents (preview first with --dry-run)
node bin/cli.mjs install --dry-run
node bin/cli.mjs install

# Import existing Antigravity, Codex & Claude Code history
node bin/cli.mjs backfill

# Verify hooks & self-test
node bin/cli.mjs doctor

# View usage stats (primary metric: unique session × skill activations)
node bin/cli.mjs stats --since 30d
node bin/cli.mjs top -n 20 --since all

# See unused enabled skills and context savings by plugin
node bin/cli.mjs unused --since 90d

# Inspect installed skills
node bin/cli.mjs inventory
```

## Plugin Installation by Host

- **Antigravity**: Link or copy this repo to `~/.gemini/config/plugins/skilltally` (or run `skilltally install --host antigravity`).
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
  Then run `codex` and open `/hooks` to review and trust the `skilltally` `PostToolUse` hook (required by Codex for user/plugin hooks, whether installed as a plugin or via `skilltally install --host codex`).

Or ask your agent: *"Which skills do I use the most?"* — the bundled `skills/skilltally/SKILL.md` teaches the agent how to query `skilltally`.

## Uninstall

```bash
node bin/cli.mjs uninstall            # remove hooks from detected hosts, keep data
node bin/cli.mjs uninstall --purge    # remove hooks and delete ~/.skilltally
```

## Architecture

- **Primary metric**: `activations` (unique `(session_id, skill)` pairs) — reading a skill 3 times in the same session still counts as 1 activation.
- **Secondary metric**: `reads` (total invocations).
- **Storage**: `~/.skilltally/` (`0700` dir, `0600` files, override via `SKILLTALLY_HOME`):
  - `events.jsonl`: real-time hook events.
  - `events.backfill.jsonl`: idempotent backfill output (re-running `backfill` overwrites cleanly; real-time `hook` events take priority during deduplication).
  - `runtime/track.mjs`: standalone hook runner used when installed via `skilltally install`.
  - `backups/`: timestamped backups of host config files before modification.

## Development

```bash
npm test
```

## License

MIT — [112516101106/skilltally](https://github.com/112516101106/skilltally)
