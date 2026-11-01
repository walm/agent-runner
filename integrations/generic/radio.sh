#!/bin/sh
# Run Agent Runner's radio: announcements the game reads out with the agent voice, and the music it plays.
# Needs only curl (7.87+).
#   radio.sh say <text|-> [from]      read it now, over the music ducked ("-": the text comes from stdin)
#   radio.sh break <text|-> [from]    read it in the gap after the track that is playing
#   radio.sh play <category|track>    pick the music: a category (synthwave, cyberpunk, ambient, "neon fm", one of
#                                     your folders) or a track by name; "any" lets the listener's choice back
#   radio.sh skip                     the next track
#   radio.sh off                      the DJ steps off the air
#   radio.sh status                   what is on, the categories, the last announcements
# RADIO_NAME (default "Agent Radio") is the DJ's name on screen; AGENT_CITY_URL (default http://127.0.0.1:5210)
# and AGENT_CITY_TOKEN are read from the environment.
URL="${AGENT_CITY_URL:-http://127.0.0.1:5210}/api/radio"
NAME="${RADIO_NAME:-Agent Radio}"
AUTH=""
[ -n "$AGENT_CITY_TOKEN" ] && AUTH="Authorization: Bearer $AGENT_CITY_TOKEN"
usage() { echo "usage: $0 say|break <text|-> [from] · play <category|track> · skip · off · status" >&2; exit 2; }
post() { curl -s -m 10 ${AUTH:+-H "$AUTH"} -H 'Content-Type: text/plain' --url-query "name=$NAME" "$@" "$URL"; echo; }

case "$1" in
  say|break)
    [ -z "$2" ] && usage
    when=now; [ "$1" = break ] && when=break
    if [ "$2" = - ]; then post --url-query "when=$when" --url-query "from=${3:-$NAME}" --data-binary @-
    else printf '%s' "$2" | post --url-query "when=$when" --url-query "from=${3:-$NAME}" --data-binary @-; fi ;;
  play)
    [ -z "$2" ] && usage
    # a known category, else a track
    if curl -s -m 5 "$URL" | grep -qi "\"$(printf '%s' "$2" | tr 'A-Z' 'a-z')\""; then post --url-query "category=$2" -d ''
    else post --url-query "track=$2" -d ''; fi ;;
  skip) post --url-query "skip=1" -d '' ;;
  off) curl -s -m 5 ${AUTH:+-H "$AUTH"} -X DELETE "$URL"; echo ;;
  status) curl -s -m 5 "$URL"; echo ;;
  *) usage ;;
esac
