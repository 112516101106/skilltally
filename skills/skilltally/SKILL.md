---
name: skilltally
description: >-
  Report which agent skills are used most, least, or never, across Antigravity,
  Claude Code, Codex, and Gemini CLI. Use when the user asks about skill usage,
  frequency, statistics, "which skills do I use", unused skills to clean up, or
  context token savings from disabling unused plugins.
---

# skilltally

Local, zero-telemetry skill-usage analytics. Events live in `~/.skilltally/events.jsonl` (written in real time by hooks) and `~/.skilltally/events.backfill.jsonl` (imported from local session logs).

## How to run the CLI

Prefer the fastest available invocation:
1. `skilltally <subcommand>` (if installed on `PATH`)
2. `node "$PLUGIN_ROOT/bin/cli.mjs" <subcommand>` (when running inside an installed plugin; instant & offline)
3. `npx -y skilltally <subcommand>` (fallback)

## Common commands

1. **Overall usage, sparklines & top skills** (default 30 days):
   ```bash
   skilltally stats --since 30d
   ```
   Add `--json` for structured output (includes 14d `sparkline`, `via` trigger ratio, `tokenCostPerActivation`, and `insights`), `--host <name>` to filter by host, or `--by-source` to separate duplicate skill names across sources.
2. **Top N skills**:
   ```bash
   skilltally top -n 20 --since 30d --metric activations
   ```
3. **Unused skills & Context Tax savings**:
   ```bash
   skilltally unused --since 90d
   ```
   Shows enabled installed skills with zero activations in the window, Context Tax meter, and estimated `KB` / `~tokens/session` saved by disabling unused plugins.
4. **Actionable optimization insights & workflow chains**:
   ```bash
   skilltally insights --since 30d
   skilltally chains --since 30d
   ```
   - `insights` surfaces Context ROI (`~tok/activation`), manual-only skills (`0%` auto-match — sharpen `SKILL.md` descriptions), single-project global skills (move to `.agents/skills` or `.claude/skills`), and per-model breakdown.
   - `chains` reveals `A -> B` transitions, 3-step workflows, and co-occurring skill pairs within sessions.
5. **Interactive HTML Dashboard & visualizations**:
   ```bash
   skilltally dashboard --since 30d --open
   ```
   Generates a self-contained, zero-dependency HTML report (`~/.skilltally/dashboard.html` or `-o <file>`) with an interactive Context Tax Treemap, timeline, workflow flow diagram, filterable table, and Mermaid diagram snippets (`pie`, `xychart-beta`, `flowchart LR`).
   When presenting analytics directly in chat, you can also run `--json` subcommands and render **Mermaid diagrams** (`pie`, `xychart-beta`, `flowchart LR`) or interactive HTML widgets from the JSON output.
6. **Timeline & export**:
   ```bash
   skilltally timeline --skill <name> --by week
   skilltally export --format csv -o skilltally-events.csv
   ```
7. **Preview safe plugin/skill pruning**:
   ```bash
   skilltally prune --since 90d --dry-run
   ```
8. **Import history, inspect inventory, verify hooks & MCP server**:
   ```bash
   skilltally backfill
   skilltally inventory --json
   skilltally doctor
   skilltally mcp
   ```

If `stats` shows zero events, run `skilltally doctor` to check hook installation, then suggest `skilltally install` and `skilltally backfill`.

## Rules

- **Never delete, uninstall, or disable skills or plugins yourself** (never run `skilltally prune` without `--dry-run`) unless the user explicitly asks you to disable specific items; present the findings and let the user decide.
- Report **activations** (unique `session × skill` pairs) as the primary metric and **reads** (total invocations) as secondary.
- When reporting unused skills or plugins, include the **Context Tax** (`KB` and `~tokens/session`) so the user knows the context benefit of disabling a plugin.
- Always state the time window (`--since`) and which hosts contributed data.
