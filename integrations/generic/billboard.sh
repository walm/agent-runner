#!/bin/sh
# Put up an agent's billboard on Agent Runner's LED screens, or take it down. Needs only curl (7.87+).
#   billboard.sh <agent-id> <image-file> [title] [caption]   PNG, JPEG, WebP, GIF or SVG, up to 2 MB
#   billboard.sh <agent-id> --text <title> [caption]          only words: the city designs the poster
#   billboard.sh <agent-id> --remove
# <agent-id> may be --claude-code: the id Claude Code's hooks report with, claude-code:<short host>:<project dir>
# (CLAUDE_PROJECT_DIR, else the current directory). AGENT_CITY_URL (default http://127.0.0.1:5210) and
# AGENT_CITY_TOKEN are read from the environment.
URL="${AGENT_CITY_URL:-http://127.0.0.1:5210}/api/billboard"
ID="$1"
[ -z "$ID" ] || [ -z "$2" ] && { echo "usage: $0 <agent-id|--claude-code> <image-file> [title] [caption] | --text <title> [caption] | --remove" >&2; exit 2; }
[ "$ID" = "--claude-code" ] && ID="claude-code:$(hostname -s):${CLAUDE_PROJECT_DIR:-$PWD}"
AUTH=""
[ -n "$AGENT_CITY_TOKEN" ] && AUTH="Authorization: Bearer $AGENT_CITY_TOKEN"

case "$2" in
  --remove)
    curl -s -m 5 ${AUTH:+-H "$AUTH"} -X DELETE --url-query "agent=$ID" "$URL" ;;
  --text)
    [ -z "$3" ] && { echo "--text needs a title" >&2; exit 2; }
    # an empty image body: the title and caption alone
    printf '' | curl -s -m 5 ${AUTH:+-H "$AUTH"} -H 'Content-Type: image/none' --url-query "agent=$ID" \
      --url-query "title=$3" --url-query "caption=${4:-}" --data-binary @- "$URL" ;;
  *)
    [ -f "$2" ] || { echo "no such file: $2" >&2; exit 2; }
    # the server reads the type from the bytes; any image/* Content-Type marks the body as the image
    curl -s -m 10 ${AUTH:+-H "$AUTH"} -H 'Content-Type: image/any' --url-query "agent=$ID" \
      --url-query "title=${3:-}" --url-query "caption=${4:-}" --data-binary "@$2" "$URL" ;;
esac
echo
