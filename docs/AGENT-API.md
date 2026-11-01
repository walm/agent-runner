# Agent API

The server (`server/index.mjs`) runs on `http://127.0.0.1:5210` by default. In dev the game reaches it as `/api`
through Vite's proxy, so `:5200/api/...` works too.

If the server runs with `AGENT_CITY_TOKEN`, every POST must send `Authorization: Bearer <token>` (or
`?token=<token>`).

## The event

An event is one flat JSON object. Only `agent` is required, and every other field is independent, so one POST can
say "waiting, and here is why".

| Field | Type | Meaning |
|---|---|---|
| `agent` | string ≤ 200 | **Required.** A stable id. The same id goes to the same building every time. A good id is `harness:host:cwd`, with the session id in `meta`. |
| `name` | string | Display name. The latest one wins. Defaults to the id. |
| `harness` | string | `claude-code`, `codex`, `pi`, `gemini`, … It picks the neighbourhood (unknown values go to Kowloon City). |
| `status` | string | `idle` · `working` · `waiting` (needs a human) · `error` · `done`. Moving into `waiting`, `error` or `done` notifies the driver. |
| `message` | string | A short human line ("Running tests", "Allow edit to auth.ts?"). It becomes the agent's *last* line and is also written to the terminal, dimmed. |
| `text` | string ≤ 64 KB | Raw terminal output. It is appended to the agent's buffer (the last 256 KB is kept). ANSI colours and cursor movement are rendered. `\n` is fine. |
| `meta` | object ≤ 4 KB | Merged into the agent's metadata. The terminal header shows `task`, `cwd` and `model`. For [talking to the agent](#talking-to-an-agent): `pid`, `host`, `prompt`, `choices`, `tmux`, `input`. |
| `end` | `true` | The session is over: status becomes `done`, and the agent is pruned after 2 hours. |

An agent not heard from for 15 minutes shows as `offline`. One that is silent for 24 hours is removed.

## Endpoints

| | |
|---|---|
| `POST /api/events` | One event, or an array of events (all are validated before any is applied). The body is parsed as JSON whatever the Content-Type. Returns `{ ok, accepted }`, or `400 { ok: false, error }`. |
| `POST /api/text?agent=…&status=…&name=…&harness=…&as=message&end=1` | The shell-friendly form. The raw body is the `text`, or the `message` with `as=message`, and the other fields go in the query. No JSON escaping needed. |
| `POST /api/hooks/claude-code?host=…` | Claude Code's own hook JSON, from any hook event. |
| `POST /api/hooks/codex?host=…` | Codex's `notify` JSON. |
| `POST /api/billboard` | Put up the agent's billboard (see [Billboards](#billboards)). |
| `DELETE /api/billboard?agent=…` | Take it down. |
| `GET /api/billboards` | `[{ agent, title, caption, type, v, at }]` |
| `GET /api/billboard/image?agent=…` | The poster's image, as it was posted. |
| `POST /api/radio` | Run the radio: pick its music, skip, make an announcement (see [The radio](#the-radio)). |
| `DELETE /api/radio` | The DJ steps off the air. |
| `GET /api/radio` | `{ radio: { dj, category, track }, categories, recent }`: what is on, and the last announcements. |
| `GET /api/music` | `{ categories, tracks: [{ id, title, artist, category, source, cached, url }] }` |
| `GET /api/music/file?id=…` | A track's audio, with byte ranges (`HEAD` fetches a catalogue track into the cache ahead of time). |
| `GET /api/voice/<file>` | A file of the voice model, from the server's cache (downloaded from Hugging Face on the first request). Only the pinned revision's files. |
| `GET /api/agents` | `[{ id, name, harness, status, last, meta, firstSeen, lastSeen, seq }]` |
| `POST /api/agents/:id/input` | The game only: `{ text }` (what the driver said), `{ choose: 1…9 }` (an option picked in the game's list) or `{ answer: 'yes' \| 'no' }`. Typed into the agent's terminal or put in its inbox (see [Talking to an agent](#talking-to-an-agent)). Returns `{ ok, kind, label, typed? , queued?, why? }`. |
| `GET /api/agents/:id/inbox?wait=<s>&listener=<id>` | `{ ok, messages: [{ at, said, kind, keys }] }`: what was said to the agent and not typed. Reading empties it. `wait` (up to 30) holds the request until something arrives; `listener` names the reader, and a newer one makes the server answer the older one `409`. |
| `GET /api/stt/<file>` | The speech model the game hears the driver with (Whistle and the Needle engine), from the server's cache. |
| `GET /api/agents/:id/output` | `{ id, text, seq }`: the buffered output. `seq` counts every character ever appended. |
| `GET /api/stream` | Server-sent events: `snapshot` (the list) and `billboards` (the posters) on connect, then `agent` (`{ agent, prev, notable }`), `output` (`{ id, text, seq }`), `billboard` (one poster, or `{ agent, removed: true }`), `remove` (`{ id }`), `radio` (the radio's state, on connect too), `radio-announce` (`{ id, text, from, dj, when }`), `radio-skip`, `input` (`{ agent, said, kind }`, when something said went to an inbox) and `ping` every 15 s. |
| `GET /api/health` | `{ ok, agents, clients }` |

## Examples

```bash
# a status change with a reason, in one request
curl -s localhost:5210/api/events -d '{"agent":"bot:1","status":"waiting","message":"Approve the deploy?"}'

# a batch
curl -s localhost:5210/api/events -d '[{"agent":"bot:1","status":"working"},{"agent":"bot:1","text":"step 1 ok\n"}]'

# stream a command's output into the agent's terminal, without JSON
my-job 2>&1 | while IFS= read -r l; do printf '%s\n' "$l" | curl -s --data-binary @- "localhost:5210/api/text?agent=bot:1"; done

# a Claude Code hook (this is what integrations/claude-code/settings.example.json runs)
curl -s -m 1 --data-binary @- "localhost:5210/api/hooks/claude-code?host=$(hostname -s)&pid=$PPID"
```

## Billboards

An agent can put a poster on the city's LED billboards: something it made about its task, or just a few words. The
poster takes over one of the campaigns the screens rotate through, so it shows on screens all over the city,
framed with its title, its caption and the agent's name. The agent's card (at its kerb or in its beam) shows it
too. A new poster from the same agent replaces the old one.

| Field | | |
|---|---|---|
| `agent` | **required** | The id the agent reports with. An id the city has not seen gets a building of its own. |
| image | optional | PNG, JPEG, WebP, GIF or SVG, up to 2 MB. The type is read from the bytes. |
| `title` | ≤ 80 chars | A few words, drawn big beside the image. Required when there is no image. |
| `caption` | ≤ 200 chars | One line under the title. |

Two ways to send it:

- **The raw image as the body** with any `image/*` Content-Type, and the fields in the query:
  `POST /api/billboard?agent=…&title=…&caption=…`. An empty body (still with an `image/*` type) posts only words.
- **JSON**: `{ "agent", "title", "caption", "svg": "<svg …>" }`, or `"image"` as a data URL or plain base64.

What makes a good poster:

- **Square** (1024 × 1024). Screens are tall (1:2) and wide (2:1); the whole image is fitted into each, over a
  blurred copy of itself, so nothing is cut off.
- **One idea, drawn big.** A symbol or a simple scene, two or three words at most in the image itself: the city
  sets your title and caption beside it.
- **Dark ground, bright colours.** It is a neon city at night.
- **SVG is the easiest** for a language model: it can write one directly. Keep it self-contained (no scripts, no
  external images or fonts; use a generic `font-family`).

The city holds 16 posters, and the screens show the 8 newest. When a 17th goes up, the longest-standing poster comes down. A
poster goes when its agent is removed. The server never runs a poster: it checks the bytes are an image, and
serves an SVG with a sandboxing Content-Security-Policy and `nosniff`; the game draws it through an `<img>`, where
an SVG can load nothing and run nothing.

```bash
# an image file (the script takes --claude-code for this session's id, and --text / --remove)
integrations/generic/billboard.sh my-bot:prod poster.png "Deploy green" "v2.14 is live on every region"

# the same with curl
curl -s -H 'Content-Type: image/png' --data-binary @poster.png \
  --url-query agent=my-bot:prod --url-query 'title=Deploy green' localhost:5210/api/billboard

# SVG an agent wrote, as JSON
curl -s localhost:5210/api/billboard -d '{"agent":"my-bot:prod","title":"Drift: zero","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1024 1024\">…</svg>"}'

# only words: the city designs the poster
curl -s -H 'Content-Type: image/none' --data-binary '' \
  --url-query agent=my-bot:prod --url-query 'title=October backfilled' --url-query 'caption=4.2M rows' \
  localhost:5210/api/billboard

# take it down
curl -s -X DELETE 'localhost:5210/api/billboard?agent=my-bot:prod'
```

### Having an agent make one

- **Claude Code**: copy [integrations/claude-code/skills/city-billboard](../integrations/claude-code/skills/city-billboard)
  to `~/.claude/skills/` (every project) or `.claude/skills/` (one project). Then ask "put up a billboard for
  this task", or add a line to your `CLAUDE.md` such as "When you finish a task, put up a city billboard about
  it". The skill has Claude draw an SVG poster and post it under the id its hooks use
  (`claude-code:<short hostname>:<project dir>`).
- **Any other agent** that can write a file and run a command: have it draw an SVG (or make a PNG with whatever
  image tool it has) and run `integrations/generic/billboard.sh <its agent id> <file> "<title>" "<caption>"`.
- **No model at all**: post only a title and a caption from a script, a CI job or a hook, and the city draws
  the poster.

## The radio

The game has a radio (the RADIO menu): NEON FM, the city's own synthesised score, or the music library, which is
a set of CC0 tracks plus your own files. One agent at a time can be its **DJ**: it picks the music by category and
puts announcements on the air. With RADIO VOICE on, the game reads them out in the agent voice, with the music
ducked under it (Settings > VOICE, then RADIO VOICE), and otherwise they show as radio text. What the DJ says is up to you and your agent: a summary
of a Slack channel, the pull requests waiting for review, a deploy that finished, the weather.

`POST /api/radio`, as JSON:

| field | |
|---|---|
| `announce` (or `say`) | What to read out, up to 1200 characters. Write it to be heard: short sentences, no links or markdown (links are dropped). |
| `when` | `now` (default): read at once, over the music. `break`: read in the gap after the track that is playing, the way a radio DJ talks between records (at once on NEON FM, which never ends). |
| `from` | The label on screen, such as `SLACK · #platform` or `GITHUB`. Defaults to `name`. |
| `category` | Change the music: `synthwave`, `cyberpunk`, `ambient`, `neon fm`, or a category from your own folders. `any` gives the choice back to the listener. |
| `track` | Play one track, by its id or part of its artist and title. |
| `skip` | `true` for the next track. |
| `name`, `agent` | The DJ's name on screen (default `radio`), and an id. |

Or the shell-friendly form, like `/api/text`: the options as query parameters and the announcement as the raw
body. `integrations/generic/radio.sh` wraps both:

```sh
radio.sh say "The deploy of api 2.4 finished. All checks green." DEPLOYS
gh pr list | radio.sh break - GITHUB            # read the piped text between tracks
radio.sh play ambient                           # or a track: radio.sh play "moonlight"
radio.sh skip · radio.sh off · radio.sh status
```

It answers `{ ok, radio, categories, announcement?, warnings? }`. An unknown category or track is not an
error, it leaves the music as it is and says so in `warnings`, with the categories there are.

The listener stays in charge: AGENT DJ (in the RADIO menu) turns the DJ off altogether, and picking a source,
category or track in the menu overrides the DJ's music until the DJ picks again.

**Your own music**: put files (MP3, M4A, AAC, OGG, WAV, FLAC) in `~/Music/Agent Runner` (or set `AGENT_CITY_MUSIC`).
A folder is a category: `~/Music/Agent Runner/focus/Artist - Title.mp3` is the track "Title" by "Artist" in
`focus`; a file loose in the top folder is in `my music`. The library is read again on every request, so new files
show up the next time the game asks.

### Making a DJ

- **A script on a timer**: [integrations/radio/github-prs.sh](../integrations/radio/github-prs.sh) reads out the
  pull requests waiting for your review. Any script that can build a sentence can do the same: CI results,
  calendar, on-call pages.
- **An agent**: [integrations/radio/agent-dj.sh](../integrations/radio/agent-dj.sh) runs Claude Code headless on
  a timer with a brief of yours ("summarise what changed in #platform since the last hour", with a Slack MCP
  server); it writes the announcement and picks music to fit. Any agent that can run a command can be a DJ the
  same way: give it `radio.sh` and say what to look at.
- **The demo**: `npm run dev` runs a demo DJ with the mock agents, and `npm run radio:demo` (`-- --every 30`)
  puts the same show on the air of any running server. [server/radio-demo.mjs](../server/radio-demo.mjs) is its
  script: a list of the requests above, which is all a DJ is.

## Talking to an agent

The driver holds Space in an agent's terminal and talks (README: [Talk to your agents](../README.md#talk-to-your-agents)).
The game hears it and posts the words to `POST /api/agents/:id/input`; the server works out what they mean at the
agent's prompt (`src/agents/intent.js`) and types the keys into the terminal the agent runs in (`server/typer.mjs`).
What the server needs to know, in `meta`:

| `meta` | |
|---|---|
| `pid` | The agent's process id. The hooks send `pid=$PPID` in the query (`/api/hooks/*`, `/api/text`). The server walks up from it to tmux, Ghostty, iTerm2 or Terminal. |
| `host` | The machine it runs on (`hostname -s`). Only agents on the server's own machine are typed into. |
| `prompt` | `menu` (a choice: "select 2" presses 2, "yes" Enter, "no" Escape) or `input` (a text prompt: everything is a message). A `waiting` agent with no `prompt` counts as a menu. `null` while it works. |
| `choices` | The options' labels, in order, so an option can be picked by its own words. |
| `tmux` | A tmux pane id (`%3`), to name the pane yourself. |
| `input` | `inbox`: never type, always queue. |

**The Claude Code mod** ([integrations/claude-code-mod](../integrations/claude-code-mod/agent-runner/README.md)) posts
Claude Code's own hook payloads to `/api/hooks/claude-code?via=mod`, which marks the agent `meta.via: mod`, and
long-polls its inbox. While it listens (it polled in the last 40 seconds) the driver's words go to the inbox and
nowhere else, and the mod acts on them inside Claude Code.

An agent that is not in a terminal (a service, a bot, an agent on another machine) reads its inbox instead:
`GET /api/agents/<id>/inbox` returns what was said, with the server's reading of it (`kind`: `choose`, `yes`, `no`,
`stop`, `message`, and the `keys` it would have pressed), and empties it. The SSE stream sends `input` when one
arrives.

Only the game may post input: the request needs `X-Agent-Runner: input` (which another site cannot send without a
preflight the server refuses) and must not be cross-site. `AGENT_CITY_INPUT=off` stops all typing; with
`AGENT_CITY_TOKEN` set the game needs `?token=<token>` in its URL.

## Claude Code mapping

| Hook | Becomes |
|---|---|
| `SessionStart` | idle, "Session startup/resume" |
| `UserPromptSubmit` | working. The prompt becomes `meta.task` and a `❯ prompt` line. |
| `PreToolUse` | working, plus a line such as `⏺ Bash(npm test)`. `AskUserQuestion` is **waiting** instead, with the question, its options as `meta.choices` and `prompt: menu`. |
| `PermissionRequest` | **waiting**, "Allow Bash(npm test)?", `prompt: menu` |
| `PostToolUse` | working, with the first 6 lines of the tool's output |
| `Notification` | **waiting**, with the notification text: a permission prompt is `prompt: menu`, an idle prompt `prompt: input` |
| `Stop` | **done**, "Finished, waiting for the next prompt", `prompt: input` |
| `SessionEnd` | end |

Writing an adapter for another harness means adding one function to `server/adapters.mjs` that maps the payload
to an event.
