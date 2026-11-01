# Agent Runner for Claude Code

A Claude Code mod that puts every session in [Agent Runner](../../../README.md)'s neon city, and lets you answer the
session from the game: talk to it, pick an option, allow or deny a command. It works wherever Claude Code runs (any
terminal, an editor, the desktop app), with no hooks to edit and no tmux.

## Install

In Claude Code:

```
/plugin install agent-runner --marketplace walm/agent-runner
```

From a clone of the repository instead:

```
claude plugin marketplace add /path/to/agent-runner
claude plugin install agent-runner@agent-runner
```

It needs a recent Claude Code (2.1.3xx, with function hooks). Settings, under `/config` > agent-runner:

| | |
|---|---|
| Agent Runner server | Where the server listens. Default `http://127.0.0.1:5210`, the desktop app's and `npm run dev`'s. |
| Token | The server's `AGENT_CITY_TOKEN`, when it has one. |

Remove the Agent Runner hooks from `settings.json` if you had them: each would report the same session.

## What it does

**Out.** What the session does goes to the server as Claude Code's own hook payloads: prompts, tool calls and their
output, questions, permission prompts, the end of each turn. The city shows the session as a building with its
status, and its terminal in the game shows the session's lines.

**In.** What you say or pick in the session's terminal in the game waits on the server, and the mod takes it:

| The session shows | You say or pick | The mod |
|---|---|---|
| Its prompt (idle) | anything | sends it as your prompt |
| A question with options | "select 2", the option's words, a click, a number key, the d-pad | answers the question |
| A permission prompt | "yes" / option 1 or 2 | allows the call, which runs |
| | "no" / option 3, or a reason | denies it, with your words as the reason |
| A turn running | "stop" | ends the turn |
| A turn running | anything else | sends it as your next prompt |

The dialog in Claude Code stays up while the game may answer it; whichever answers first wins.

**No server, no harm.** While no Agent Runner is running the mod sends nothing and asks every few seconds whether one
has started. It keeps the session's last events meanwhile, so when the server comes up, the session shows at once,
with its state and recent history. If the server restarts, the same happens again.

## How it works

`hooks/register.ts` is the whole mod:

- `classic.*` events (Claude Code's settings-hook events, raised whether or not any hook is configured) are posted
  as they are to `POST /api/hooks/claude-code?via=mod`, one at a time and in order.
- `session.start` finds the server (`GET /api/health`) and then long-polls the session's inbox
  (`GET /api/agents/<id>/inbox?wait=25`).
- A message becomes `$.prompt.submit({ asUser: true })`; "stop" becomes `$.turn.abort`.
- `tool.call` on `AskUserQuestion` races the dialog against the game: an answer from the game returns the tool's
  result, which closes the dialog.
- Every other `tool.call` races the same way once `classic.PermissionRequest` says its dialog is up. A deny returns
  `{ deny }`; an allow runs the call again with `$.tool.call`, which a `tool.check` hook lets through.

The session's id in the city is `claude-code:<host>:<folder>`, the same as the hooks give it.
