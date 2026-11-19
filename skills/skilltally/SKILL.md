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

1. **Overall usage & top skills** (default 30 days):
   ```bash
   skilltally stats --since 30d
   ```
   Add `--json` for structured output, `--host <name>` to filter by host, or `--by-source` to separate duplicate skill names across sources.
2. **Top N skills**:
   ```bash
   skilltally top -n 20 --since 30d --metric activations
   ```
3. **Unused skills & Context Tax savings**:
   ```bash
   skilltally unused --since 90d
   ```
   Shows enabled installed skills with zero activations in the window, grouped by source with estimated `KB` and `~tokens/session` saved by disabling unused plugins.
4. **Timeline & export**:
   ```bash
   skilltally timeline --skill <name> --by week
   skilltally export --format csv -o skilltally-events.csv
   ```
5. **Import history from local logs** (Antigravity, Codex, Claude Code, Gemini CLI):
   ```bash
   skilltally backfill
   ```
6. **Inspect installed inventory & verify hooks**:
   ```bash
   skilltally inventory --json
   skilltally doctor
   ```

If `stats` shows zero events, run `skilltally doctor` to check hook installation, then suggest `skilltally install` and `skilltally backfill`.

## Rules

- **Never delete, uninstall, or disable skills or plugins yourself**; present the findings and let the user decide.
- Report **activations** (unique `session × skill` pairs) as the primary metric and **reads** (total invocations) as secondary.
- When reporting unused skills or plugins, include the **Context Tax** (`KB` and `~tokens/session`) so the user knows the context benefit of disabling a plugin.
- Always state the time window (`--since`) and which hosts contributed data.
