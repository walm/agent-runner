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
| `GET /api/agents` | `[{ id, name, harness, status, last, meta, firstSeen, lastSeen, seq }]` |
| `GET /api/agents/:id/output` | `{ id, text, seq }`: the buffered output. `seq` counts every character ever appended. |
| `GET /api/stream` | Server-sent events: `snapshot` (the list) on connect, then `agent` (`{ agent, prev, notable }`), `output` (`{ id, text, seq }`), `remove` (`{ id }`) and `ping` every 15 s. |
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
