#!/bin/sh
# An agent as the radio's DJ: Claude Code, headless, looks at what is new, writes a short announcement and picks
# music to go with it, every INTERVAL minutes (default 20). Give it your own brief as the first argument, e.g.
#   ./agent-dj.sh "Summarise what changed in #platform on Slack since the last hour"   (with a Slack MCP server)
# It can only run gh and radio.sh; widen --allowedTools for what your brief needs.
here=$(cd "$(dirname "$0")/.." && pwd)
radio="$here/generic/radio.sh"
brief="${1:-Look at what is new for me on GitHub with gh: pull requests waiting for my review, and failing checks on my own.}"
while :; do
  claude -p "You are the DJ of Agent Runner's radio, read out loud to a developer while they drive through a neon city.
$brief
Then write one announcement of two to four short spoken sentences: plain English, no links, no markdown, nothing if there is nothing worth saying.
Put it on the air with: $radio break '<the announcement>' 'AGENT RADIO'
Pick music for the mood with: $radio play <category> (the categories: $radio status)." \
    --allowedTools "Bash(gh:*)" "Bash($radio:*)" >/dev/null
  sleep $(( ${INTERVAL:-20} * 60 ))
done
