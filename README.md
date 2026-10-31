# Neon City Agents

**Your AI agents live in a rain-soaked neon city.** Each agent you run (Claude Code, Codex, Pi, a deploy bot, any
agent-driven app) gets its own building. Light pillars on the roofs show what every agent is doing. Drive or fly to
whoever needs you, pull up at the kerb, and open a terminal that streams the agent's output live.

Agents report in with one HTTP POST, so any harness can connect through a hook, a skill or a three-line script.

This is a fork of [**Neon Zenith**](https://github.com/billpwchan/neon-zenith) by Bill Chan (MIT): the city, the
flying car, the rendering and the weather are all his. The original README, with how the city is built, is in
[docs/NEON-ZENITH.md](docs/NEON-ZENITH.md). The third-party models and textures keep their own licences
([CREDITS.md](CREDITS.md)).

## Quick start

```bash
npm install
npm run dev          # agent server on :5210 with 8 mock agents, game on http://127.0.0.1:5200
```

Open http://127.0.0.1:5200 and choose FREE RIDE. `npm run dev:nomock` starts without the mock agents.

| | |
|---|---|
| `G` or click the **AGENTS** counter | List every agent, sorted by who needs you. `↑ ↓` to choose, `Enter` to **drive** there (sets a waypoint), `W` to **warp** to the kerb outside. |
| Pull up in the ring at the kerb, or fly into the agent's beam | A card shows who the agent is and what it last said; `Enter` opens the **terminal**: the agent's output with colours, plus task, cwd, model and uptime. `↑ ↓` `PgUp PgDn` `Home End` (or a gamepad's sticks, d-pad, LB / RB) read back; `Esc` (or B) to leave. |
| `M` | City map with every agent marked by status. Click to set a waypoint. |
| A waypoint | Satnav: a display floating ahead of the car shows the next turn and how far it is, chevrons on the road mark the way in your lane, and both maps draw the route. Leave it and it plans again from where you are. |
| WASD / Space / C / Shift | Drive, lift off and climb, descend, boost (as in Neon Zenith). |

Status colours: **cyan** working · **magenta** pulsing, needs you · **red** error · **green** done · **amber** idle · **grey** offline (silent for 15 minutes).

You are notified when an agent starts waiting for you, fails or finishes. "Needs you" also comes over the radio.

Each harness has its own neighbourhood:
- `claude-code`: Temple Night Market, around the spawn point
- `codex`: Yau Ma Tei
- `pi`: Sham Shui Po
- `gemini`: Jordan
- everything else: Kowloon City

An agent's id hashes to a building, so it gets the same building every time.

Debug: `?play&agent=<id or part of a name>` starts the game parked outside that agent.

## VR (Meta Quest)

Open the game in the Quest browser and press **ENTER VR** (top left; it only shows when the browser has a headset).
You sit in the car's seat, with a dash under your view; the agents list and the terminal open as panels in front of
you, and name tags float over the agents' roofs.

| Touch controller | |
|---|---|
| Right trigger / left trigger | Throttle / brake and reverse (the left stick's Y works too) |
| Left stick X | Steer |
| Right stick Y | Climb and descend |
| Grip (either) | Boost |
| **A** | Open the terminal at an agent's kerb or in its beam (or start a run at its beacon) |
| **X** | Agents list: stick to choose, **A** drive, **trigger** warp, **B** close |
| **Y** | Seat view or chase view |
| Right stick (terminal) | Scroll back; **A** or **B** closes |

Hold the Meta button to recenter.

WebXR only runs on `https` or `localhost`: over plain `http://<your-ip>:5200` the game loads but ENTER VR never
appears. Three ways to the headset:

- **Same Wi-Fi:** `npm run dev:lan` serves Vite on every interface over https with a self-signed certificate. Open
  `https://<your-computer's-ip>:5200` on the Quest and accept the certificate warning once (Advanced, then
  Proceed).
- **ngrok:** `npm run dev`, then `ngrok http 5200 --basic-auth "you:a-long-password"` and open the https URL it
  prints.
- **USB:** with developer mode on, `adb reverse tcp:5200 tcp:5200` and open `http://localhost:5200`.

Live reload works with all three. The agent server stays on 127.0.0.1; the headset reaches it through Vite's `/api`
proxy. That proxy also carries your agents' terminal output and accepts events, so `dev:lan` opens both to your
network and ngrok to anyone holding the URL. Keep the basic auth on ngrok when real agents report in.

What differs from the screen:
- **No post chain in a headset** (no bloom, grade or wet-street mirror; three.js turns screen-space passes off in
  XR). The scene is tone-mapped by the renderer, a little brighter to make up for the missing bloom.
- **WebGL**: WebXR over WebGPU is not in any headset browser yet, so with a headset present the game starts on WebGL.
- **Multiview**: both eyes are drawn in one pass where the browser has `OVR_multiview2` (the Quest does). `?nomv`
  turns it off.
- **VR DETAIL** (Settings): what a headset gets of the city. AUTO is LOW on a standalone headset (Quest, Pico) and
  HIGH on a PC headset; `?vr=low|medium|high` overrides it.
  - LOW: 75% resolution, photo facades only (no modelled ones), shopfronts within 40 m, Temple Street's props at
    lower detail, a simplified car, no sky traffic, thinner rain, a shorter far plane, a slow car-reflection probe.
  - MEDIUM: 90% resolution, low-detail modelled facades within 60 m, shopfronts within 70 m, the rest as LOW but
    less so.
  - HIGH: the whole city.

  The dash shows the frame rate. TRAFFIC (Settings) thins out the other cars, on the screen too.
- **A wait on entering**: every shader is built again for the headset in the background, about 25–35 s on a Mac.
  It shows a notice in the meantime.

No headset? `?xremu` (dev server only) installs Meta's WebXR emulator (IWER) as a Quest 3; the controllers are
driven from the console through `__xrdevice.controllers.left/right`.

## Connect a harness

The full API is in [docs/AGENT-API.md](docs/AGENT-API.md). The short version:

```bash
# any script: one JSON event (every field but "agent" is optional)
curl -s localhost:5210/api/events -H 'Content-Type: application/json' -d '{
  "agent": "my-bot:prod", "harness": "my-bot", "name": "crawler",
  "status": "working", "message": "Crawling page 3", "text": "fetched 120 urls\n"
}'

# no JSON at all: the body is the text, the rest goes in the query
some-command 2>&1 | integrations/generic/post-event.sh my-bot:prod --stream
integrations/generic/post-event.sh my-bot:prod waiting "Approve the deploy?"
```

- **Claude Code**: merge the `hooks` block from
  [integrations/claude-code/settings.example.json](integrations/claude-code/settings.example.json) into
  `~/.claude/settings.json` (all projects) or `.claude/settings.json` (one project). Each hook pipes Claude Code's
  own hook JSON to `POST /api/hooks/claude-code`, which maps it as follows:
  - prompt → working
  - tool calls → terminal lines
  - permission notification → needs you
  - stop → done

  There is one building per host and working directory.
- **Codex**: point `notify` in `~/.codex/config.toml` at
  [integrations/codex/notify.sh](integrations/codex/notify.sh). Codex only reports at the end of each turn.
- **Anything else**: [integrations/generic/post-event.sh](integrations/generic/post-event.sh) or a plain `curl`.
  Pi, Gemini and others go here until they get an adapter in `server/adapters.mjs`.

Set `AGENT_CITY_TOKEN` on the server to require `Authorization: Bearer <token>` on every POST. Set `AGENT_CITY_URL`
for the scripts when the server runs somewhere else. The server listens on 127.0.0.1 unless you set `HOST`.

## Scripts

| | |
|---|---|
| `npm run dev` | Server with mock agents, plus Vite (proxies `/api` to the server) |
| `npm run dev:lan` | The same, with Vite over https on every interface (for a headset on the LAN) |
| `npm run server` / `server:mock` | The agent server alone (port `PORT`, default 5210) |
| `npm run mock` | Mock agents posting over HTTP to a running server (`--url`, `--fast`, `--token`) |
| `npm test` | Server unit tests (`node --test`) |
| `npm run build` then `npm run server` | Production: the server also serves `dist/` on :5210 |

## Layout

```
server/        index.mjs (HTTP + SSE, no dependencies) · store.mjs (agents, output buffers) · adapters.mjs (harness hooks) · mock.mjs
src/agents/    feed (SSE client) · placement (agent → building and kerb) · visuals (roof pillars, kerb rings)
               labels (name tags) · panel (the G list) · terminal (xterm.js) · agents (glue to the game)
src/game/      nav (the satnav's routing over the street grid) · navvis (the chevrons and the display ahead of the car)
src/xr/        vr (session, seat, controllers, light profile) · panels (dash, list, terminal in canvases) · tags
integrations/  claude-code · codex · generic
```

The game-side changes to upstream files are small: `src/main.js`, `src/game/game.js`, `src/core/input.js` and
`src/ui/screens.js` (agent hooks, the G key, the legend, the rebrand), plus `vite.config.js` for the proxy.
