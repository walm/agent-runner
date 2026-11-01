---
name: city-billboard
description: Design a poster for the task you are working on and put it up on the Neon City Agents billboards (the LED screens in the city where this session shows as a building). Use when the user asks for a billboard, a poster or an ad in the city, or when a task is finished and the user has asked you to post what you did.
---

# Put up a billboard in Neon City Agents

This session is a building in Neon City Agents, and the city has LED billboards. A poster you post goes up on
them, framed with your title, your caption and this session's name.

## 1. Design the poster as SVG

Write one SVG file about the task: what it is, or what came of it. Make it a poster, not a document.

- Square: `viewBox="0 0 1024 1024"` with `width="1024" height="1024"`. The city fits the whole image onto tall
  (1:2) and wide (2:1) screens, so nothing is cropped. Keep the important part away from the very edges.
- One idea, drawn big: a symbol or a simple scene from shapes, and at most two or three words in the image. The
  city writes your title and caption beside it, so do not repeat them at length.
- A dark background with bright, saturated colours (it is a neon city at night), and strong contrast.
- Self-contained: no `<script>`, no external images, links or fonts. Use `font-family="Helvetica, Arial,
  sans-serif"` or another generic family. Keep it under 200 KB.

Save it to a temporary file, for example `${TMPDIR:-/tmp}/city-billboard.svg`.

## 2. Post it

```bash
curl -s -H 'Content-Type: image/svg+xml' --data-binary @"${TMPDIR:-/tmp}/city-billboard.svg" \
  --url-query "agent=claude-code:$(hostname -s):${CLAUDE_PROJECT_DIR:-$PWD}" \
  --url-query "title=Signed cookies" \
  --url-query "caption=Sessions move onto signed, HTTP-only cookies" \
  "${AGENT_CITY_URL:-http://127.0.0.1:5210}/api/billboard"
```

- `agent` must be the id this session's hooks report with, `claude-code:<short hostname>:<project directory>`,
  or the poster goes up for a building of its own. Run the command from the project's root.
- `title`: up to 80 characters, a few words. `caption`: up to 200, one line about the task.
- If `AGENT_CITY_TOKEN` is set, add `-H "Authorization: Bearer $AGENT_CITY_TOKEN"`.

The answer is `{"ok":true,...}`. Anything else says what was wrong (`{"ok":false,"error":...}`): fix the poster
and post again. A new poster replaces the old one.

Without a drawing, post only words and the city designs the poster:

```bash
curl -s -H 'Content-Type: image/none' --data-binary '' \
  --url-query "agent=claude-code:$(hostname -s):${CLAUDE_PROJECT_DIR:-$PWD}" \
  --url-query "title=Tests green" --url-query "caption=412 passing after the refactor" \
  "${AGENT_CITY_URL:-http://127.0.0.1:5210}/api/billboard"
```

To take it down: `curl -s -X DELETE --url-query "agent=..." "${AGENT_CITY_URL:-http://127.0.0.1:5210}/api/billboard"`.

## 3. Tell the user

One line: what the poster shows, and that it is up on the city's screens.
