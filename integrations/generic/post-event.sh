#!/bin/sh
# Report to Neon City Agents from any script or harness. Needs only curl (7.87+ for --url-query).
#   post-event.sh <agent-id> <status> [message]        e.g.  post-event.sh my-bot working "Crawling page 3"
#   some-command 2>&1 | post-event.sh <agent-id> --stream    (tees output to the agent's terminal, line by line)
#   post-event.sh <agent-id> --end [message]
# status: idle | working | waiting | error | done. AGENT_CITY_URL (default http://127.0.0.1:5210),
# AGENT_CITY_TOKEN, AGENT_HARNESS and AGENT_NAME are read from the environment.
URL="${AGENT_CITY_URL:-http://127.0.0.1:5210}/api/text"
ID="$1"
[ -z "$ID" ] || [ -z "$2" ] && { echo "usage: $0 <agent-id> <status> [message] | --stream | --end [message]" >&2; exit 2; }

post() { # post <extra --url-query args...> ; body on stdin
  curl -s -m 2 ${AGENT_CITY_TOKEN:+-H "Authorization: Bearer $AGENT_CITY_TOKEN"} \
    --url-query "agent=$ID" --url-query "harness=${AGENT_HARNESS:-other}" --url-query "name=${AGENT_NAME:-}" \
    "$@" --data-binary @- "$URL" >/dev/null 2>&1 || true
}

case "$2" in
  --stream)
    while IFS= read -r line; do
      printf '%s\n' "$line"
      printf '%s\n' "$line" | post
    done ;;
  --end)
    printf '%s' "$3" | post --url-query "end=1" --url-query "as=message" ;;
  *)
    printf '%s' "$3" | post --url-query "status=$2" --url-query "as=message" ;;
esac
