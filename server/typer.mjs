// Typing into an agent's own terminal: what the driver says in the game's terminal (src/agents/talk.js) arrives as
// key steps ({ text } and { key: 'enter' | 'escape' | '1'…'9' }) and is typed where the agent runs, as if at the
// keyboard. The agent (Claude Code, Codex, a shell script) needs nothing new.
//
// Finding the terminal: the hooks send the agent's process id (`pid=$PPID`) and the server walks up from it to
// the program that owns its terminal:
//   tmux       the pane whose tty is the agent's (`tmux send-keys`), on any OS
//   Ghostty    the terminal whose working directory is the agent's (AppleScript `input text` / `send key`)
//   iTerm2     the session whose tty is the agent's (AppleScript `write text`)
//   Terminal   the tab whose tty is the agent's (AppleScript `do script`, which always ends with Return)
// Without a pid (hooks set up before this existed) a tmux pane or a Ghostty terminal in the agent's cwd is used
// when there is exactly one. The AppleScript ones are macOS only, and macOS asks once whether the app running the
// server (Agent Runner, or the terminal running `npm run dev`) may control that terminal.
//
// Only agents on this machine can be typed into; `meta.input: 'inbox'` asks for the inbox instead (index.mjs).
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';

export const HOST = hostname().split('.')[0];
const MAC = process.platform === 'darwin';

function run(cmd, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: err ? String(stderr || '').trim() || err.message : '' });
    });
  });
}

const osa = (script, args) => run('osascript', ['-e', script, ...args]);

// every process: pid -> { ppid, tty, comm }
async function processes() {
  const r = await run('ps', ['-A', '-o', 'pid=,ppid=,tty=,comm=']);
  const map = new Map();
  if (!r.ok) return map;
  for (const line of r.out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) map.set(+m[1], { pid: +m[1], ppid: +m[2], tty: m[3], comm: m[4] });
  }
  return map;
}

const base = (comm) => comm.split('/').pop().replace(/^-/, '').replace(/:.*$/, '').trim();
const APPS = { tmux: 'tmux', ghostty: 'ghostty', iTerm2: 'iterm', iTerm: 'iterm', Terminal: 'terminal' };
const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'nu', 'login']);
const NAME = { tmux: 'tmux', ghostty: 'Ghostty', iterm: 'iTerm2', terminal: 'Terminal' };

// where an agent's keys should go: { via, target, label } or { why }
export async function locate(agent) {
  const m = agent?.meta || {};
  if (m.host && m.host !== HOST) return { why: `it runs on ${m.host}, not on this machine` };
  if (typeof m.tmux === 'string' && /^%\d+$/.test(m.tmux)) return { via: 'tmux', target: m.tmux, label: `tmux ${m.tmux}` };
  const pid = Number.isInteger(+m.pid) && +m.pid > 1 ? +m.pid : 0;
  if (pid) {
    const ps = await processes();
    const chain = [];
    for (let p = ps.get(pid); p && chain.length < 40; p = ps.get(p.ppid)) { chain.push(p); if (p.ppid <= 1) break; }
    if (chain.length) {
      const tty = chain.find((p) => p.tty && p.tty !== '??' && p.tty !== '?')?.tty;
      const app = chain.map((p) => APPS[base(p.comm)]).find(Boolean);
      if (app === 'tmux' && tty) return tmuxByTty(`/dev/${tty.replace(/^\/dev\//, '')}`);
      if (app === 'ghostty') return ghosttyByCwd(m.cwd, agent.harness);
      if (app === 'iterm' && tty) return { via: 'iterm', target: `/dev/${tty}`, label: `iTerm2 ${tty}` };
      if (app === 'terminal' && tty) return { via: 'terminal', target: `/dev/${tty}`, label: `Terminal ${tty}` };
      const top = chain.map((p) => base(p.comm)).filter((c) => !SHELLS.has(c)).pop();
      return { why: `its terminal${top ? ` (${top})` : ''} cannot be typed into; run it in tmux, Ghostty, iTerm2 or Terminal` };
    }
    // the process is gone (a resumed session, say): fall back to the cwd
  }
  if (!m.cwd) return { why: 'its hooks send no process id or working directory' };
  const t = await tmuxByCwd(m.cwd);
  if (t.via) return t;
  if (MAC) {
    const g = await ghosttyByCwd(m.cwd, agent.harness, true);
    if (g.via) return g;
  }
  return { why: 'no terminal of it was found (add pid=$PPID to its hooks: see integrations/claude-code)' };
}

async function tmuxPanes() {
  const r = await run('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_tty}\t#{pane_current_path}\t#{pane_current_command}']);
  if (!r.ok) return [];
  return r.out.split('\n').map((l) => { const [id, tty, cwd, cmd] = l.split('\t'); return { id, tty, cwd, cmd }; });
}

async function tmuxByTty(tty) {
  const pane = (await tmuxPanes()).find((p) => p.tty === tty);
  return pane ? { via: 'tmux', target: pane.id, label: `tmux ${pane.id}` } : { why: `no tmux pane on ${tty} (a tmux server on another socket?)` };
}

async function tmuxByCwd(cwd) {
  const panes = (await tmuxPanes()).filter((p) => p.cwd === cwd && !SHELLS.has(p.cmd));
  return panes.length === 1 ? { via: 'tmux', target: panes[0].id, label: `tmux ${panes[0].id}` } : { why: panes.length ? 'several tmux panes in its folder' : 'no tmux pane' };
}

// Ghostty tells a script each terminal's working directory and title, not its tty: the agent's folder picks it,
// and when two terminals share the folder, the one whose title is the agent's harness (Claude Code titles its
// terminal "✳ …")
async function ghosttyByCwd(cwd, harness, quiet) {
  if (!MAC) return { why: 'Ghostty can only be scripted on macOS' };
  if (!quiet || (await run('pgrep', ['-x', 'ghostty'])).ok) {
    const r = await osa(`tell application "Ghostty"
      set out to ""
      repeat with w in windows
        repeat with c in terminals of w
          set out to out & (id of c) & (character id 9) & (working directory of c) & (character id 9) & (name of c) & (character id 10)
        end repeat
      end repeat
      return out
    end tell`, []);
    if (!r.ok) return { why: denied(r.err, 'Ghostty') };
    const all = r.out.split('\n').filter(Boolean).map((l) => { const [id, dir, name] = l.split('\t'); return { id, dir: (dir || '').replace(/\/$/, ''), name: name || '' }; });
    let hits = all.filter((t) => cwd && t.dir === cwd.replace(/\/$/, ''));
    if (hits.length > 1) {
      const looks = harness === 'codex' ? /codex/i : /claude|[✳✻✶✢✽]/i;
      const named = hits.filter((t) => looks.test(t.name));
      if (named.length) hits = named;
    }
    if (hits.length === 1) return { via: 'ghostty', target: hits[0].id, label: 'Ghostty' };
    return { why: hits.length ? `${hits.length} Ghostty terminals are in ${cwd}; close the extra ones, or run the agent in tmux` : `no Ghostty terminal is in ${cwd}` };
  }
  return { why: 'Ghostty is not running' };
}

const denied = (err, app) => (/-1743|not authori[sz]ed/i.test(err)
  ? `macOS has not let this app control ${app}: allow it in System Settings > Privacy & Security > Automation`
  : `${app}: ${err.split('\n').pop()}`);

// types the steps; resolves { ok, label } or { ok: false, error }
export async function type(where, steps) {
  if (!where?.via) return { ok: false, error: where?.why || 'nowhere to type' };
  const r = await (TYPERS[where.via])(where.target, steps);
  return r.ok ? { ok: true, label: where.label } : { ok: false, error: r.error || denied(r.err, NAME[where.via]) };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// after Escape the agent needs a moment to leave its menu; Return right behind pasted text can land in the paste
const pause = (s) => (s.key === 'escape' ? 350 : s.text !== undefined ? 150 : 80);

const TYPERS = {
  async tmux(pane, steps) {
    for (const s of steps) {
      const args = s.text !== undefined ? ['send-keys', '-t', pane, '-l', '--', s.text] : ['send-keys', '-t', pane, { enter: 'Enter', escape: 'Escape' }[s.key] || s.key];
      const r = await run('tmux', args);
      if (!r.ok) return r;
      await wait(pause(s));
    }
    return { ok: true };
  },

  ghostty(id, steps) {
    const args = steps.map((s) => (s.text !== undefined ? `text:${s.text}` : `key:${/^[0-9]$/.test(s.key) ? `digit_${s.key}` : s.key}`));
    return osa(`on run argv
      set tid to item 1 of argv
      tell application "Ghostty"
        set t to missing value
        repeat with w in windows
          repeat with c in terminals of w
            if (id of c) is tid then set t to contents of c
          end repeat
        end repeat
        if t is missing value then error "its Ghostty terminal has closed"
        repeat with i from 2 to count of argv
          set a to item i of argv
          if a starts with "key:" then
            send key (text 5 thru -1 of a) to t
            if a is "key:escape" then delay 0.35
          else
            input text (text 6 thru -1 of a) to t
            delay 0.15
          end if
          delay 0.05
        end repeat
      end tell
    end run`, [id, ...args]);
  },

  iterm(tty, steps) {
    const args = steps.map((s) => (s.text !== undefined ? `text:${s.text}` : `key:${s.key}`));
    return osa(`on run argv
      set want to item 1 of argv
      tell application "iTerm2"
        repeat with w in windows
          repeat with tb in tabs of w
            repeat with s in sessions of tb
              if (tty of s) is want then
                repeat with i from 2 to count of argv
                  set a to item i of argv
                  if a is "key:enter" then
                    tell s to write text (character id 13) newline no
                  else if a is "key:escape" then
                    tell s to write text (character id 27) newline no
                    delay 0.35
                  else if a starts with "key:" then
                    tell s to write text (text 5 thru -1 of a) newline no
                  else
                    tell s to write text (text 6 thru -1 of a) newline no
                    delay 0.15
                  end if
                end repeat
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
      end tell
      error "its iTerm2 session has closed"
    end run`, [tty, ...args]);
  },

  // Terminal's `do script` types a line and presses Return: text and the Return after it go as one, a lone key
  // gets a Return of its own (harmless at a menu that has moved on)
  terminal(tty, steps) {
    const lines = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.text !== undefined) { lines.push(s.text); if (steps[i + 1]?.key === 'enter') i++; }
      else lines.push(s.key === 'enter' ? '' : s.key === 'escape' ? '\x1b' : s.key);
    }
    return osa(`on run argv
      set want to item 1 of argv
      tell application "Terminal"
        repeat with w in windows
          repeat with t in tabs of w
            if (tty of t) is want then
              repeat with i from 2 to count of argv
                do script (item i of argv) in t
                delay 0.3
              end repeat
              return "ok"
            end if
          end repeat
        end repeat
      end tell
      error "its Terminal tab has closed"
    end run`, [tty, ...lines]);
  },
};
