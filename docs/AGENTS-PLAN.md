# Neon City Agents: plan

> Status: built. A sub-agent reviewed the plan before work started. Changes made after the review:
> - **SSE reconnect**: the feed reconnects on its own with a backoff, because EventSource gives up on a proxy's
>   5xx. A `ping` watchdog catches a stream a proxy holds open after the server has died. `seq` counts characters,
>   so terminal chunks are never duplicated or lost.
> - **Overlays**: they reuse `screens.open`. The agent prompt is built inside `updateWorldFlags`, and the nearest
>   dock within 7 m wins.
> - **Driving**: DRIVE sets the waypoint directly (the old setter toggles off near the previous point). WARP snaps the
>   camera.
> - **Beacons**: all instances are allocated before the warm-up.
> - **Event schema**: flattened. Added the Claude Code and Codex hook adapters and the raw-text endpoint.
> - **Notifications**: throttled. Toasts for waiting, error and done; radio only for waiting.
> - **HUD chip**: a clickable AGENTS chip, so phones can open the list.
>
> Not taken: the reviewer suggested replacing xterm.js with a `<pre>`. xterm stays because the terminal view is the
> core ask, and harness mods will want to stream raw PTY output. Its focus is disabled and our keys are taken in the
> capture phase, so it never captures Esc or the driving keys.

A fork of [Neon Zenith](https://github.com/billpwchan/neon-zenith) (MIT code, CC BY models) where every AI agent
(Claude Code, Codex, Pi, any agent-driven app) lives in a building. Agents report in with a simple HTTP POST. You
drive or fly to an agent's building, pull up at the kerb, and open a terminal to watch its output live.

## Goals for the first version

1. One `POST /api/events` endpoint that any harness can call with `curl` from a hook, skill or mod.
2. Each agent gets a stable building, grouped into a neighbourhood per harness.
3. A beacon over each agent's building, coloured by status, plus markers on the compass, minimap and city map.
4. An agents list (`G`) to pick an agent and set a waypoint to it, or warp there.
5. Pull up at the kerb, press `Enter`, and a terminal overlay opens with the agent's output (ANSI colours kept) and
   streams new lines live.
6. Important events (needs input, error, done) come over the radio and as toasts.
7. A mock that sends realistic events from about 8 agents across 4 harnesses through the real HTTP path, so
   `npm run dev` shows a living city with no real agents connected.

Out of scope for now: sending input to an agent from the terminal, auth beyond one shared token, persistence
across server restarts, and multiple users.

## Architecture

```
harness hook/skill ──POST /api/events──▶  server/ (Node, no deps)  ──SSE /api/stream──▶  browser game
mock (server/mock.mjs) ──POST──────────▶   in-memory store             ◀─GET /api/agents── (snapshot on connect)
                                           ring buffer per agent       ◀─GET /api/agents/:id/output
```

- **Server**: `server/index.mjs` uses plain `node:http`, so there are no new runtime dependencies. It listens on port
  5210. Vite proxies `/api` to it in dev. In production the same server serves `dist/` as static files.
- **Why SSE and not WebSocket**: data flows one way (server to browser), `EventSource` reconnects on its own, it needs
  no library, and it passes through proxies. Input to agents can use a separate POST later.
- **Dev runner**: `npm run dev` starts the server with the mock and Vite together (`scripts/dev.mjs`, which spawns
  child processes and stops them on Ctrl-C). `npm run dev:server`, `npm run mock` and `npm run dev:web` run them
  one at a time.

## Event API

See [AGENT-API.md](AGENT-API.md). After the review it is one flat event, `{ agent, name?, harness?, status?, message?,
text?, meta?, end? }`, with every field independent. Two extra forms make hooks trivial:
- `POST /api/text` takes a raw body plus query params, so scripts need no JSON.
- `POST /api/hooks/<harness>` takes the harness's own hook payload (Claude Code, Codex).

## Client: `src/agents/`

| File | Job |
|---|---|
| `feed.js` | `AgentFeed`: EventSource with a snapshot, an `agents` Map, a callback per change, and an output subscription per agent. It shows offline in the HUD when the server is down and keeps retrying. |
| `placement.js` | Maps an agent to a building and a kerb "dock" point (details below). |
| `visuals.js` | `AgentVisuals`: an instanced light pillar and kerb pad per agent, with colour and pulse per instance. Allocated for 128 instances up front so no pipeline is built after the warm-up. |
| `labels.js` | DOM name tags projected over agent buildings within about 700 m (name, harness, status dot), hidden behind the camera. |
| `panel.js` | Agents list overlay (`G`): rows with harness, status and last line. Actions: `DRIVE` sets a waypoint, `WARP` places the car at the dock. |
| `terminal.js` | Terminal overlay using `@xterm/xterm` (renders ANSI, has scrollback, read-only). Header shows name, harness, status, cwd and task, and uptime. Loads the buffer, then appends live chunks. `Esc` or `Enter` closes it. |
| `agents.js` | `AgentLayer`: connects all of the above to `Game`. It checks proximity to docks, sets the HUD prompt, hands markers to the compass, minimap and map, and sends notable events to radio and toasts. |

### Placement
- **Candidates**: buildings with `streetFace !== null` (perimeter lots in market and mixed districts, which open
  onto a real street), not `zenith`. Baked Temple Street buildings are allowed, so agents appear near the spawn
  point.
- **Neighbourhood per harness**: `claude-code` goes to Temple Night Market (next to the spawn), `codex` to Yau Ma
  Tei, `pi` to Sham Shui Po, `gemini` to Jordan, and anything else to Kowloon City. Each pool is the 80 candidates
  nearest that district seed.
- **Pick**: an FNV-1a hash of the agent id chooses an index in the pool, with linear probing if that building is
  taken. The same id gets the same building every session, unless two ids collide, where arrival order decides.
- **Dock point**: from the street facade, step out along `NORM[face]` until `groundAt` reads road level, then step
  2.5 m further into the lane. The car's yaw there runs along the street. The beacon stands on the building's roof
  centre (`b.x, b.h, b.z`) so it can be seen across the city. The pad sits on the dock.

### Status colours
`working` cyan · `idle` amber · `waiting` magenta, fast pulse (needs you) · `error` red · `done` green · `offline`
dim grey with no pillar, pad only.

### Game integration (small edits to upstream files)
- `main.js`: construct `AgentLayer` before the warm-up so its meshes compile with everything else, pass it to
  `Game`, and expose it on `window.__nz.agents`. Add the param `?agent=<id>`, which warps to that agent once it
  appears.
- `game.js`:
  - Treat `agents.open` (terminal or list) as an overlay, the same as `screens.open`, so the car freezes.
  - Route actions while it is open: `pause`/`confirm` close it.
  - Add the `agents` action (`G`).
  - In free play, `confirm` near a dock opens the terminal. Run beacons take priority if both are in range.
  - Merge agent markers into `updateHud` and `mapState`.
  - Mute the upstream district and start radio chatter, so agent news is not buried.
- `input.js`: add `KeyG: 'agents'`.
- `hud.js`: an "AGENTS n · k need you" chip next to the shards counter, and a connection-state dot.
- `screens.js`: map legend entry, `G` row in the controls list, and the title and credits rebrand.
- `index.html`, the loader text and `README.md`: rebrand to **NEON CITY AGENTS**. Credit upstream clearly, keep
  `LICENSE` and `CREDITS.md`, and keep the in-game credits list of models.

## Mock (`server/mock.mjs`)
It POSTs to the server like a real harness would. Eight agents (3 claude-code, 2 codex, 2 pi, 1 custom
"deploy-bot"), each running a scripted loop:
- think, then a tool call with coloured diff or test output, then a `message`
- sometimes `waiting` ("Allow edit to src/auth.ts?") for 20 to 40 s
- sometimes `error`, then a retry
- finally `done`, followed by a new task

Output uses real ANSI (colours, bold), plus prompts and spinners written as lines (no cursor-movement codes). With
`--fast` it runs about 3 times faster. `server/index.mjs --mock` runs the same generator in-process, which is what
`npm run dev` uses (one less process). It can also run standalone against a remote server: `node server/mock.mjs
--url http://host:5210`.

## Testing
- `node --test server/` runs unit tests for the store: events, status changes, the ring buffer, offline
  derivation, validation and limits.
- `npm run build` must pass.
- Browser check (ego-browser):
  - load `?play`
  - agents appear on the map and compass
  - `G` opens the list and DRIVE sets a waypoint
  - WARP moves the car to the dock, the prompt shows, and `Enter` opens the terminal with coloured output that
    streams
  - `Esc` closes it
  - stopping the server shows OFFLINE, and restarting it recovers
- `curl` against the API to check validation (400 on a missing `agent` or bad `type`, 401 with a wrong token).

## Risks
- **Pipeline compile hitch**: the agent meshes are created before the warm-up, with capacity allocated up front.
  Only attributes and `instanceCount` change later.
- **xterm.js and keyboard**: the game listens on `window`. The terminal is read-only and xterm is not focused, so
  keys go to the game, which maps `Esc` to close. Copying text with the mouse still works.
- **WebGPU in the test browser**: if WebGPU is missing, `?webgl` falls back to WebGL2.
