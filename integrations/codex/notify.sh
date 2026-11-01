#!/bin/sh
# Codex calls this after every turn with the event as one JSON argument. In ~/.codex/config.toml:
#   notify = ["/absolute/path/to/integrations/codex/notify.sh"]
# pid=$PPID is Codex itself: what you say to it in the game is typed into its terminal (server/typer.mjs).
# Codex only notifies at the end of a turn, so its building shows DONE between turns rather than live tool calls.
printf '%s' "$1" | curl -s -m 1 --data-binary @- "${AGENT_CITY_URL:-http://127.0.0.1:5210}/api/hooks/codex?host=$(hostname -s)&pid=$PPID" >/dev/null 2>&1 || true
