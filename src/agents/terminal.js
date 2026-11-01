// Terminal mode: pull up at an agent's door and read its output. xterm.js renders the stream as a terminal would
// (colours, bold, cursor moves from a raw PTY feed), read-only. The buffer is fetched once, then live chunks are
// appended by seq so nothing shows twice and a gap triggers a refetch.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { styleOf } from './visuals.js';
import { esc } from '../core/esc.js';


// shared with the VR panel, which draws the same buffer into a canvas
export const THEME = {
  background: '#05060d', foreground: '#d8e4ff', cursor: '#05060d', selectionBackground: 'rgba(59,232,255,0.3)',
  black: '#1a1d2b', red: '#ff4a6a', green: '#5dff9a', yellow: '#ffb547', blue: '#5c8dff', magenta: '#ff3df2', cyan: '#3be8ff', white: '#d8e4ff',
  brightBlack: '#5a6280', brightRed: '#ff7a92', brightGreen: '#8dffba', brightYellow: '#ffd08a', brightBlue: '#8fb0ff', brightMagenta: '#ff8cf7', brightCyan: '#8ff2ff', brightWhite: '#ffffff',
};

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export class TerminalView {
  constructor(root, feed) {
    this.feed = feed;
    root.insertAdjacentHTML('beforeend', `
      <div id="agterm" class="screen hidden">
        <div class="tw">
          <div class="th">
            <div class="tl"><span class="dot"></span><div><b class="nm"></b><small class="sub"></small></div></div>
            <div class="tr"><span class="st"></span><button class="btn" data-ag="close">EXIT · ESC</button></div>
          </div>
          <div class="tmeta"></div>
          <div class="tbody"></div>
          <div class="tchoices hidden"></div>
          <div class="ttalk idle"><button class="btn mic" data-ag="talk">HOLD TO TALK</button><span class="tt"></span><i class="lvl"><b></b></i></div>
          <div class="tfoot"><span class="live">● LIVE</span><span class="hint">↑ ↓ PGUP PGDN TO READ BACK · SELECT TO COPY</span></div>
        </div>
      </div>`);
    this.el = root.querySelector('#agterm');
    this.q = (s) => this.el.querySelector(s);
    this.el.addEventListener('click', (e) => { if (e.target.closest('[data-ag=close]') || e.target === this.el) this.onClose?.(); });
    this.term = null;
    this.id = null;
    this.have = 0;
    this.pending = null;
    this.onClose = null;
    this.fixed = null; // [cols, rows] while a headset shows the terminal; otherwise it fits the window
    addEventListener('resize', () => this.fit());
    // push to talk with the mouse or a finger, as Space does on the keyboard (agents.js)
    this.onTalk = null; // (down) => void
    const mic = this.q('.mic');
    mic.addEventListener('pointerdown', (e) => { e.preventDefault(); mic.setPointerCapture?.(e.pointerId); this.onTalk?.(true); });
    for (const ev of ['pointerup', 'pointercancel']) mic.addEventListener(ev, () => this.onTalk?.(false));
    // the agent's options while it waits at a choice: click one, press its number, say it, or the d-pad and A
    this.onPick = null; // (1…9 | 'yes' | 'no') => void
    this.opts = [];
    this.sel = 0;
    this.optKey = '';
    this.q('.tchoices').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (b) this.onPick?.(/^\d$/.test(b.dataset.pick) ? +b.dataset.pick : b.dataset.pick);
    });
  }

  // the options of a waiting agent (meta.choices, from its hooks), or YES and NO when it waits at a choice whose
  // options are not known; nothing while it works or sits at its prompt
  choices(a) {
    const m = a.meta || {};
    const menu = m.prompt === 'menu' || (a.status === 'waiting' && !m.prompt);
    const list = Array.isArray(m.choices) ? m.choices.slice(0, 9) : [];
    this.opts = !menu ? [] : list.length ? list.map((l, i) => ({ pick: i + 1, key: String(i + 1), label: String(l) })) : [{ pick: 'yes', key: '⏎', label: 'YES' }, { pick: 'no', key: 'ESC', label: 'NO' }];
    const key = `${a.id}|${a.last}|${this.opts.map((o) => o.label).join('|')}`;
    if (key !== this.optKey) { this.optKey = key; this.sel = 0; }
    const el = this.q('.tchoices');
    el.classList.toggle('hidden', !this.opts.length);
    this.onChoices?.();
    el.innerHTML = this.opts.length ? `<span class="q">${esc(a.last || 'CHOOSE')}</span>${this.opts.map((o, i) => `<button class="opt ${i === this.sel ? 'pad-sel' : ''}" data-pick="${o.pick}"><b>${o.key}</b>${esc(o.label)}</button>`).join('')}` : '';
    this.fit();
  }

  hasChoices() { return this.opts.length > 0; }

  // the d-pad's highlight in the options, and A on it
  moveChoice(d) {
    if (!this.opts.length) return;
    this.sel = (this.sel + d + this.opts.length) % this.opts.length;
    this.q('.tchoices').querySelectorAll('.opt').forEach((b, i) => b.classList.toggle('pad-sel', i === this.sel));
  }

  pickChoice() { const o = this.opts[this.sel]; if (o) this.onPick?.(o.pick); }

  // the talk line (talk.js): what to say and how, or what is happening; device picks the key it names
  talk(s, device) {
    const bar = this.q('.ttalk');
    bar.className = `ttalk ${s.tone || 'idle'}`;
    const key = device === 'gamepad' ? 'HOLD X' : device === 'touch' ? 'HOLD THE BUTTON' : 'HOLD SPACE';
    const pick = device === 'gamepad' ? 'D-PAD AND A PICK' : device === 'touch' ? 'TAP ONE' : '1–9 OR CLICK PICKS';
    this.q('.tt').textContent = !s.hint ? s.text : this.opts.length
      ? `${key} AND SAY “SELECT 2”, “YES”, “NO” OR THE OPTION · ${pick}`
      : `${key} AND TALK · “SELECT 2” · “YES” · “GO” · “NO” · OR SAY WHAT TO DO`;
    this.q('.lvl b').style.width = `${Math.round((s.level || 0) * 100)}%`;
    this.q('.mic').classList.toggle('on', s.phase === 'listening');
  }

  ensureTerm() {
    if (this.term) return;
    this.term = new Terminal({
      disableStdin: true, convertEol: true, cursorBlink: false, cursorStyle: 'underline', scrollback: 5000, fontSize: 13, lineHeight: 1.25,
      fontFamily: '"JetBrains Mono Variable", ui-monospace, Menlo, monospace',
      theme: THEME,
    });
    this.fitter = new FitAddon();
    this.term.loadAddon(this.fitter);
    this.term.open(this.q('.tbody'));
    // read-only: keep the keyboard with the game, so Esc and the driving keys never get stuck in xterm
    const ta = this.term.textarea;
    if (ta) { ta.tabIndex = -1; ta.addEventListener('focus', () => ta.blur()); }
  }

  fit() {
    if (!this.term || !this.id) return;
    if (this.fixed) { this.term.resize(...this.fixed); return; }
    try { this.fitter.fit(); } catch {}
  }

  async open(agent) {
    this.close(true);
    this.id = agent.id;
    this.el.classList.remove('hidden');
    this.ensureTerm();
    this.header(agent);
    this.fit();
    this.term.reset();
    this.term.write(`\x1b[90mconnecting to ${agent.id} …\x1b[0m\r\n`);
    this.unsub = this.feed.subscribe(agent.id, (text, seq) => this.chunk(text, seq));
    await this.load();
  }

  async load() {
    const id = this.id;
    this.pending = [];
    const out = await this.feed.output(id);
    if (id !== this.id) return;
    this.term.reset();
    this.term.write(out.text || '\x1b[90m(no output yet)\x1b[0m\r\n');
    this.have = out.seq;
    const queued = this.pending;
    this.pending = null;
    for (const [t, s] of queued) this.chunk(t, s);
    this.term.scrollToBottom();
  }

  chunk(text, seq) {
    if (this.pending) { this.pending.push([text, seq]); return; }
    if (seq <= this.have) return; // already in the buffer we fetched
    if (seq - text.length > this.have) { this.load(); return; } // missed some: start over from the server's copy
    this.have = seq;
    this.term.write(text);
    this.q('.live').classList.remove('blink');
    void this.q('.live').offsetWidth;
    this.q('.live').classList.add('blink');
  }

  header(a) {
    if (!a || a.id !== this.id) return;
    const s = styleOf(a.status);
    this.el.style.setProperty('--c', s.css);
    this.q('.nm').textContent = a.name;
    this.q('.sub').textContent = `${a.harness} · ${a.id}`;
    this.q('.st').textContent = s.en;
    this.q('.st').classList.toggle('pulse', a.status === 'waiting');
    const m = a.meta || {};
    const bits = [
      m.task && ['TASK', m.task], m.cwd && ['CWD', m.cwd], m.model && ['MODEL', m.model],
      ['UP', ago(Date.now() - a.firstSeen)], ['SEEN', `${ago(Date.now() - a.lastSeen)} ago`],
      a.last && ['LAST', a.last],
    ].filter(Boolean);
    this.q('.tmeta').innerHTML = bits.map(([k, v]) => `<span><i>${k}</i>${esc(v)}</span>`).join('');
    this.choices(a);
  }

  // lines (±Infinity: the top or the bottom) and pages, for the keyboard and the gamepad
  scroll(n) {
    if (!this.term || !this.id) return;
    if (n === -Infinity) this.term.scrollToTop();
    else if (n === Infinity) this.term.scrollToBottom();
    else this.term.scrollLines(n);
  }

  page(n) { if (this.term && this.id) this.term.scrollPages(n); }

  // after a reconnect the server may have moved on: refetch rather than trust the stream
  resync() { if (this.id) this.load(); }

  close(quiet) {
    this.unsub?.();
    this.unsub = null;
    this.id = null;
    this.pending = null;
    this.opts = [];
    this.optKey = '';
    this.el.classList.add('hidden');
    if (!quiet) this.term?.blur();
  }
}
