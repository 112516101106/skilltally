# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-11-20

### Fixed
- **Detection & Parsing (`bin/track.mjs`, `hooks/agy-fast-track.sh`)**:
  - Support `.system` (`~/.codex/skills/.system/<skill>/SKILL.md`), 2-level nested skill paths (`skills/gstack/<skill>/SKILL.md`, `skills/ponytail/<skill>/SKILL.md`), single-skill plugin cache layouts (`plugins/cache/.../<plugin>/SKILL.md`), and shell variable prefixes (`$BASE/skills/...`, `${BASE}/skills/...`).
  - Expand Codex `exec` command extraction to handle JSON-quoted `"cmd":`, single-quoted escapes, backtick template literals, and JS array/`fs.readFileSync` reads, plus `rg`/`grep` section reads (while rejecting `--files`/`-l`/`-r`/`-c`), MCP `skill://<plugin>/<skill>/SKILL.md` resource URIs, and direct `skills/*/(scripts|bin)/*` execution (forwarded by `hooks/agy-fast-track.sh`).
  - Strip `namespace:` / `namespace::` prefixes in `<skill>` tags and Markdown links; fix `resolveSource` for `<plugin>/<version>/skills/` caches (avoiding `plugin:5.2.0`), `.tmp/marketplaces/`, `skill://` URIs, and relative `.agents/skills/` paths; avoid double-counting `cached_input_tokens`/`cachedContentTokenCount` in `extractUsageMetrics` when `total_tokens` is omitted.
- **Backfill & Normalization (`src/backfill/*`, `src/core/normalize.mjs`)**:
  - Lock Codex `session_id` to the first `session_meta` in forked rollouts, deduplicate replayed parent `call_id`/`msg_` items across forks, and stop extending turn end timestamps on `task_complete`/`turn_aborted` so multi-day idle gaps do not inflate durations.
  - Preserve Antigravity manual `<SKILL>` slash commands (`via: "slash_command"`) per turn in `backfillAntigravity` and via live transcript tail in `bin/track.mjs`, and retain manual `via` (`slash_command`/`mention`) over auto `read`/`shell_read` when deduplicating within 30 s.
  - Support Gemini CLI `.jsonl` `{"$set": { "messages": [...] }}` checkpoint patch files in `src/backfill/gemini.mjs`.
  - Canonicalize events before `dedupeEvents` in `runBackfill`.
- **Inventory, Aggregation, Dashboard & Installer (`src/inventory/scan.mjs`, `src/report/*`, `src/install/antigravity.mjs`)**:
  - Discover `.system` and 2-level nested skills in `scanInventory`, compare Codex cache versions numerically (`compareSemverLike`), skip `plugin-install-*` staging directories, deduplicate multi-marketplace Codex plugin caches against `~/.codex/config.toml` states (preserving `byPath` aliases), and expose `bySkillAndSource`.
  - Deduplicate same-turn token snapshots in `aggregateStats`, fix the `cacheHitRate` denominator for OpenAI/Gemini inclusive `input_tokens`, merge overlapping per-session turn duration intervals with task-scoped `longestTaskSeconds`, and disambiguate `inventory.used` across duplicate `(name, source)` installs using canonical `skill_path`.
  - Rename the dashboard overview ledger row from `Total skills used` to `Total skill reads`.
  - Guard `installAntigravity` against `cpSync` errors when `install` is invoked directly from an already-installed non-symlink plugin directory.

## [1.2.0] - 2026-11-20

### Added
- **Runtime Token Usage & Prompt Cache Efficiency Telemetry**: Live hooks (`bin/track.mjs`) and all 4 backfill parsers extract normalized `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, and `total_tokens` from transcripts, exposing `totals.tokens` (`cacheHitRate`, `lifetimeTokens`, `peakSessionTokens`, `activeBodyTokens`).
- **Skill Task Duration Tracking**: Computes `duration_seconds` across turns in backfill and live hooks, reporting `totals.duration` (`totalSeconds`, `avgSeconds`, `longestTaskSeconds`) and `insights.slowestSkills`.
- **Heavy `SKILL.md` Body Detection**: Scans full `body_tokens` in `scanInventory` and flags `>= 1,500`-token skill files (`insights.heavyBodySkills`) that should be split into `references/`.
- **Opt-In Redacted Prompt Triggers (`store_prompts: true`)**: Sanitizes and strips skill tags, secrets, emails, and absolute paths via `sanitizePromptPreview` to surface `insights.promptPatterns`.
- **Profile Dashboard Updates**: Upgraded the 5-metric pill bar to `Lifetime tokens`, `Peak tokens`, `Longest task`, `Longest streak`, and `Current streak`, plus cache hit rate, active body tokens, automated duration, and heavy-body pruning cards.

## [1.1.0] - 2026-11-20

### Added
- **Interactive HTML Dashboard (`skilltally dashboard`)**: Self-contained, offline zero-dependency HTML report featuring an interactive SVG Treemap (Context Tax vs. Activations), Timeline chart, Trigger/Host/Project/Model distribution charts, SVG workflow transition diagram, optimization tabs, sortable/filterable skills explorer, and Mermaid snippet generator (`pie`, `xychart-beta`, `flowchart LR`).
- **Skill Chains & Co-occurrence (`skilltally chains`)**: Session-level analysis of ordered skill transitions (`A -> B` with conditional probability and average gap), 3-step workflows, and co-occurring pairs with Jaccard similarity.
- **Optimization Insights (`skilltally insights`) & Enriched `stats`/`unused`**:
  - 14-day Unicode sparklines (`▁▂▃▄▅▆▇█`) in `stats` rows and a Context Tax meter bar in `unused`.
  - Trigger mode (`via`) auto vs. manual breakdown and identification of manual-only skills needing sharper `SKILL.md` descriptions.
  - Project-affinity analysis flagging global/plugin skills used exclusively in a single project.
  - Cumulative context ROI (`tokenCostPerActivation`) and per-model usage breakdown.
- **Safe Actionable Pruning (`skilltally prune`)**: Disable 100%-unused plugins or specific unused skills in Antigravity (`~/.gemini/config/config.json`) and Codex (`~/.codex/config.toml`) with `--dry-run` preview and automatic backups.
- **Zero-Dependency Stdio MCP Server (`skilltally mcp`)**: Exposes `skilltally_stats`, `skilltally_unused`, `skilltally_timeline`, `skilltally_chains`, and `skilltally_insights` over newline-delimited or `Content-Length`-framed JSON-RPC 2.0.

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
