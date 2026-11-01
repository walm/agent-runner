#!/bin/sh
# A DJ that reads out your GitHub pull requests: the ones waiting for your review, and your own that are open.
# Needs gh (signed in). Run it once, or on a timer: `while :; do ./github-prs.sh; sleep 900; done`.
# RADIO_WHEN=now reads it at once instead of between tracks.
here=$(dirname "$0")
review=$(gh search prs --review-requested=@me --state=open --json number,title,repository --limit 5 \
  --jq '.[] | "Number \(.number) in \(.repository.name): \(.title)."') || exit 1
mine=$(gh search prs --author=@me --state=open --json number --jq 'length') || exit 1
n=$(printf '%s' "$review" | grep -c .)
if [ "$n" -eq 0 ]; then text="Nothing waits for your review on GitHub."
elif [ "$n" -eq 1 ]; then text="One pull request waits for your review. $review"
else text="$n pull requests wait for your review. $(printf '%s' "$review" | tr '\n' ' ')"; fi
[ "$mine" -gt 0 ] && text="$text You have $mine open pull request$([ "$mine" -gt 1 ] && echo s) of your own."
exec "$here/../generic/radio.sh" "${RADIO_WHEN:-break}" "$text" GITHUB
