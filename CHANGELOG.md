# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - 2026-11-19

### Fixed
- Ignore paginated continuation reads across all 4 providers (`StartLine`/`start_line`/`offset > 1`, `ByteOffset`/`byte_offset > 0`, `sed -n 'N,Mp'` with `N > 1`, non-`+1` `tail`, and `awk` `NR >= N`/`NR > N`).
- Deduplicate same-session `(host, session_id, skill)` hook writes within a 30-second window at capture time in `bin/track.mjs`, and increase the default `dedupeEvents` query window from 5 seconds to 30 seconds in `src/core/normalize.mjs`.

## [1.0.2] - 2026-11-19

### Added
- Realtime `UserPromptSubmit` hook and `<skill>` / `[$skill](.../SKILL.md)` backfill detection for Codex explicit `$skill` invocations (`via: "mention"`).
- Expanded hook matchers and backfill parsers across all 4 providers:
  - **Antigravity**: added `run_command` to `PostToolUse` matcher and fallback `<SKILL>` slash-command detection in `backfillAntigravity`.
  - **Claude Code**: added `View|Bash` to `PostToolUse` matcher and `Base directory for this skill:` slash-command detection in `backfillClaude`.
  - **Gemini CLI**: added `read_file|view_file|read_many_files|run_shell_command` to `AfterTool` matcher and `read_many_files` array path support.

### Fixed
- Verify trust status across both `post_tool_use` and `user_prompt_submit` hook indices in `~/.codex/config.toml` and clean up all hook events on `uninstall`.

## [1.0.1] - 2026-11-19

### Fixed
- Ignore third-party hooks in `skilltally doctor` when inspecting `~/.codex/hooks.json`, `~/.claude/settings.json`, `~/.gemini/settings.json`, and `~/.gemini/config/hooks.json` instead of flagging unrelated commands as broken paths.
- Match the exact `[hooks.state."...hooks.json:post_tool_use:<group>:<handler>"]` index in `~/.codex/config.toml` when checking Codex hook trust so third-party hooks at index `0:0` do not produce false positives.

## [1.0.0] - 2026-11-19

### Added
- GitHub Actions CI matrix across macOS, Ubuntu, and Windows on Node.js 18, 20, 22, and 24, plus npm tarball extraction verification.
- Provenance-enabled npm release workflow (`.github/workflows/release.yml`).
- Production README documentation and `CHANGELOG.md`.

### Fixed
- Cross-platform Windows compatibility in Antigravity symlink/junction cleanup, TOML path normalization, and `node --test` test discovery.

## [0.3.0] - 2026-11-19

### Added
- Gemini CLI support: `gemini-extension.json`, `installGemini`/`uninstallGemini` (`AfterTool` hook in `~/.gemini/settings.json`), `backfillGemini` (`~/.gemini/tmp/*/chats/`), and `doctor` diagnostics.
- `skilltally timeline` (`--by day|week|month`, `--skill`, ASCII bar chart).
- `skilltally export` (JSON and RFC-4180 CSV, `-o`/`--output`, `--include-failed`).
- Automatic monthly archive rotation (`events-YYYY-MM[-N].jsonl`) when `events.jsonl` exceeds 20 MB.
- `skilltally debug on|off|status` with automatic deletion of `debug.jsonl` on `off`.

## [0.2.0] - 2026-11-19

### Added
- Idempotent `install`, `uninstall` (`--purge`), and `doctor` commands with automatic host config backups and live hook self-test.
- Claude Code session backfill (`~/.claude/projects/**/*.jsonl`).
- Multi-platform plugin manifests (`.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/marketplace.json`, `hooks/claude-codex-hooks.json`).

## [0.1.0] - 2026-11-19

### Added
- Standalone zero-dependency hook tracker (`bin/track.mjs`) and POSIX fast-path wrapper (`hooks/agy-fast-track.sh`) for Antigravity (`plugin.json` + `hooks.json`).
- Antigravity (including `antigravity-ide`/`antigravity-cli` and `transcript_full.jsonl`) and Codex (including `.jsonl.zst`) backfill parsers.
- Skill inventory scanner with frontmatter parsing, disabled-state detection, and Context Tax estimation.
- Core CLI commands: `stats`, `top`, `unused`, `backfill`, `inventory`, `track`, and bundled `skills/skilltally/SKILL.md`.
