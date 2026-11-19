# skilltally

Real-time skill usage tracking via hooks for Antigravity, Claude Code, Codex & Gemini CLI — 100% local, zero dependencies.

Find out which agent skills you actually use, and how much context (`KB` / `~tokens/session`) unused skills and plugins cost you on every turn.

## Features (v0.3.0 — M3)

- **One-command installer & health check (`install`, `uninstall`, `doctor`)**: Idempotently installs hooks for all 4 detected agents (Antigravity, Claude Code, Codex, Gemini CLI), backs up existing configs to `~/.skilltally/backups/`, and verifies runtime health with a live self-test.
- **Real-time hook tracking (`bin/track.mjs`)**: Appends one normalized JSONL line to `~/.skilltally/events.jsonl` whenever an agent activates a skill (reads `SKILL.md` or invokes `Skill` / `activate_skill`), with automatic monthly archive rotation when `events.jsonl` exceeds 20 MB.
- **Multi-platform plugin packaging**: Ships native manifests for Antigravity (`plugin.json` + `hooks.json`), Claude Code (`.claude-plugin/`), Codex (`.codex-plugin/` + `.agents/plugins/marketplace.json`), and Gemini CLI (`gemini-extension.json`), sharing `hooks/claude-codex-hooks.json` (`async: true`) for Claude & Codex.
- **History backfill (`skilltally backfill`)**: Imports historical sessions from Antigravity (`antigravity`, `antigravity-cli`, `antigravity-ide`, including `transcript_full.jsonl`), Codex (`~/.codex/sessions` + `~/.codex/archived_sessions`, including `.jsonl.zst`), Claude Code (`~/.claude/projects/**/*.jsonl`), and Gemini CLI (`~/.gemini/tmp/*/chats/*.{json,jsonl}`).
- **Reporting & export (`stats`, `top`, `unused`, `timeline`, `export`, `inventory`)**: Shows primary `activations` (`session × skill`) and secondary `reads`, calculates Context Tax savings for unused skills/plugins, renders ASCII timelines (`day`/`week`/`month`), and exports RFC-4180 CSV or JSON.
- **Opt-in hook debugging (`debug on|off|status`)**: Temporarily captures raw hook stdin payloads to `~/.skilltally/debug.jsonl` for troubleshooting and deletes `debug.jsonl` automatically on `debug off`.
- **Zero dependencies & local-first**: Runs on Node.js `>= 18` (Node `>= 22.15` recommended for native `.zst` Codex archive decompression). No network calls, no telemetry.

## Quick Start

```bash
git clone https://github.com/112516101106/skilltally.git
cd skilltally

# Install hooks for detected agents (preview first with --dry-run)
node bin/cli.mjs install --dry-run
node bin/cli.mjs install

# Import existing Antigravity, Codex, Claude Code & Gemini CLI history
node bin/cli.mjs backfill

# Verify hooks & self-test
node bin/cli.mjs doctor

# View usage stats (primary metric: unique session × skill activations)
node bin/cli.mjs stats --since 30d
node bin/cli.mjs top -n 20 --since all
node bin/cli.mjs timeline --by week --since 90d

# See unused enabled skills and context savings by plugin
node bin/cli.mjs unused --since 90d

# Export deduplicated events
node bin/cli.mjs export --format csv -o skilltally.csv

# Inspect installed skills
node bin/cli.mjs inventory
```

## Plugin & Hook Installation by Host

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
- **Gemini CLI**:
  ```bash
  gemini extensions install https://github.com/112516101106/skilltally
  node bin/cli.mjs install --host gemini
  ```
  The extension manifest registers the `skilltally` skill, while `skilltally install --host gemini` merges the `AfterTool` hook (`activate_skill`, `timeout: 5000` ms) into `~/.gemini/settings.json` without conflicting with Claude Code's plugin hook path.

Or ask your agent: *"Which skills do I use the most?"* — the bundled `skills/skilltally/SKILL.md` teaches the agent how to query `skilltally`.

## Debug & Uninstall

```bash
node bin/cli.mjs debug on             # warning: logs raw hook stdin to ~/.skilltally/debug.jsonl
node bin/cli.mjs debug off            # disables debug mode and deletes ~/.skilltally/debug.jsonl

node bin/cli.mjs uninstall            # remove hooks from detected hosts, keep data
node bin/cli.mjs uninstall --purge    # remove hooks and delete ~/.skilltally
```

## Architecture

- **Primary metric**: `activations` (unique `(session_id, skill)` pairs) — reading a skill 3 times in the same session still counts as 1 activation.
- **Secondary metric**: `reads` (total invocations).
- **Storage**: `~/.skilltally/` (`0700` dir, `0600` files, override via `SKILLTALLY_HOME`):
  - `events.jsonl`: real-time hook events (automatically rotated to `events-YYYY-MM.jsonl` once > 20 MB).
  - `events.backfill.jsonl`: idempotent backfill output (re-running `backfill` overwrites cleanly; real-time `hook` events take priority during deduplication).
  - `runtime/track.mjs`: standalone hook runner used when installed via `skilltally install`.
  - `backups/`: timestamped backups of host config files before modification.

## Development

```bash
npm test
```

## License

MIT — [112516101106/skilltally](https://github.com/112516101106/skilltally)
