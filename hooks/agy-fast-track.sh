#!/bin/sh
# Fast-path wrapper for Antigravity PostToolUse hook.
# Avoids spawning Node.js (and path subshells) when stdin does not mention SKILL.md.

in=$(cat)

run_node=0
if [ "${SKILLTALLY_DEBUG:-0}" = "1" ] || [ -f "${SKILLTALLY_HOME:-$HOME/.skilltally}/.debug" ]; then
  run_node=1
else
  case "$in" in
    *SKILL.md*) run_node=1 ;;
  esac
fi

if [ "$run_node" = "1" ]; then
  if [ -n "${PLUGIN_ROOT:-}" ]; then
    PLUGIN_DIR="$PLUGIN_ROOT"
  else
    SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
    PLUGIN_DIR=$(dirname -- "$SCRIPT_DIR")
  fi
  printf '%s' "$in" | node "$PLUGIN_DIR/bin/track.mjs" --host antigravity 2>/dev/null || printf '{}'
else
  printf '{}'
fi

exit 0
