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
| `meta` | object ≤ 4 KB | Merged into the agent's metadata. The terminal header shows `task`, `cwd` and `model`. |
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
| `GET /api/agents` | `[{ id, name, harness, status, last, meta, firstSeen, lastSeen, seq }]` |
| `GET /api/agents/:id/output` | `{ id, text, seq }`: the buffered output. `seq` counts every character ever appended. |
| `GET /api/stream` | Server-sent events: `snapshot` (the list) and `billboards` (the posters) on connect, then `agent` (`{ agent, prev, notable }`), `output` (`{ id, text, seq }`), `billboard` (one poster, or `{ agent, removed: true }`), `remove` (`{ id }`) and `ping` every 15 s. |
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
curl -s -m 1 --data-binary @- "localhost:5210/api/hooks/claude-code?host=$(hostname -s)"
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

## Claude Code mapping

| Hook | Becomes |
|---|---|
| `SessionStart` | idle, "Session startup/resume" |
| `UserPromptSubmit` | working. The prompt becomes `meta.task` and a `❯ prompt` line. |
| `PreToolUse` | working, plus a line such as `⏺ Bash(npm test)` |
| `PostToolUse` | the first 6 lines of the tool's output |
| `Notification` | **waiting**, with the notification text (permission prompts, idle prompts) |
| `Stop` | **done**, "Finished, waiting for the next prompt" |
| `SessionEnd` | end |

Writing an adapter for another harness means adding one function to `server/adapters.mjs` that maps the payload
to an event.
