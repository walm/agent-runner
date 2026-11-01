// Terminal mode: pull up at an agent's door and read its output. xterm.js renders the stream as a terminal would
// (colours, bold, cursor moves from a raw PTY feed), read-only. The buffer is fetched once, then live chunks are
// appended by seq so nothing shows twice and a gap triggers a refetch.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { styleOf } from './visuals.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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
          <div class="tfoot"><span class="live">● LIVE</span><span class="hint">READ-ONLY · ↑ ↓ PGUP PGDN TO READ BACK · SELECT TO COPY</span></div>
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
    this.el.classList.add('hidden');
    if (!quiet) this.term?.blur();
  }
}
