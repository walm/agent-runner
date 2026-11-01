// Markdown for the game's terminal: an agent's reply (Claude Code's, Codex's) written out in ANSI, the way a
// terminal shows it. xterm.js draws the result in the game and the VR panel draws the same buffer, so everything
// is plain text, colours and box-drawing characters:
//
//   # Heading                  bold, in magenta (level 1 and 2) or white
//   **bold** __bold__          bold        *italic* _italic_    italic        ~~struck~~   struck through
//   `code`                     cyan        [text](url)          text underlined, the URL dim after it
//   - item / 1. item           • item / 1. item, nested by indent; - [ ] / - [x] as ☐ / ☑
//   > quote                    a dim bar before it
//   ```code block```           a dim bar before each line, the text green, nothing inside formatted
//   ---                        a dim rule
//   | a | b |  tables          box-drawn, columns as wide as their text up to a share of `width`, longer cells
//                              wrapped inside their column
const E = (n) => `\x1b[${n}m`;
const C = { reset: E(0), bold: E(1), dim: E(2), italic: E(3), under: E(4), strike: E(9), red: E(31), green: E(32), yellow: E(33), mag: E(35), cyan: E(36), grey: E(90), white: E(97) };

// the width a string takes on screen: escape codes take none, every character one (CJK and emoji are rare enough
// in a reply not to measure)
export const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - visible(s)));

// inline marks: code first, so nothing inside it is read as a mark
export function inline(s) {
  const codes = [];
  let t = String(s).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, url) => `${C.under}${alt || 'image'}${C.reset}${C.grey} (${url})${C.reset}`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, text, url) => `${C.under}${text}${C.reset}${C.grey} (${url})${C.reset}`)
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (_, __, x) => `${C.bold}${x}${C.reset}`)
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, (_, b, x) => `${b}${C.italic}${x}${C.reset}`)
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, (_, b, x) => `${b}${C.italic}${x}${C.reset}`)
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, (_, x) => `${C.strike}${x}${C.reset}`);
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `${C.cyan}${codes[+i]}${C.reset}`);
}

// a line's words broken to a width, marks and all (a word longer than the width is cut)
function wrap(text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      let w = word;
      while (visible(w) > width) {
        if (line) { out.push(line); line = ''; }
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!line) line = w;
      else if (visible(line) + 1 + visible(w) <= width) line += ` ${w}`;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const isRule = (row) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row);

function table(rows, width) {
  const head = cells(rows[0]);
  const aligns = cells(rows[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
  const body = rows.slice(2).map(cells);
  const n = Math.max(head.length, ...body.map((r) => r.length));
  const all = [head, ...body].map((r) => Array.from({ length: n }, (_, i) => inline(r[i] ?? '')));
  // each column as wide as its widest cell, the widest ones narrowed until the table fits
  const want = Array.from({ length: n }, (_, i) => Math.max(3, ...all.map((r) => visible(r[i]))));
  const room = Math.max(n * 6, width - (n * 3 + 1));
  const w = want.slice();
  while (w.reduce((a, b) => a + b, 0) > room) {
    const i = w.indexOf(Math.max(...w));
    if (w[i] <= 6) break;
    w[i]--;
  }
  const align = (s, i) => {
    const gap = w[i] - visible(s);
    if (aligns[i] === 'right') return ' '.repeat(gap) + s;
    if (aligns[i] === 'center') return ' '.repeat(gap >> 1) + s + ' '.repeat(gap - (gap >> 1));
    return pad(s, w[i]);
  };
  const line = (l, m, r) => `${C.grey}${l}${w.map((x) => '─'.repeat(x + 2)).join(m)}${r}${C.reset}`;
  const bar = `${C.grey}│${C.reset}`;
  const row = (r, bold) => {
    const lines = r.map((c, i) => wrap(c, w[i]));
    const h = Math.max(...lines.map((l) => l.length));
    return Array.from({ length: h }, (_, k) => `${bar}${lines.map((l, i) => ` ${bold ? C.bold : ''}${align(l[k] ?? '', i)}${bold ? C.reset : ''} `).join(bar)}${bar}`);
  };
  return [line('┌', '┬', '┐'), ...row(all[0], true), line('├', '┼', '┤'), ...all.slice(1).flatMap((r) => row(r)), line('└', '┴', '┘')];
}

// the whole reply, as lines of ANSI text
export function markdown(md, { width = 100 } = {}) {
  const src = String(md ?? '').replace(/\r/g, '').replace(/\t/g, '  ').split('\n');
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const l = src[i];
    // a code block: kept as written
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(l);
    if (fence) {
      const end = src.findIndex((x, j) => j > i && x.trim().startsWith(fence[1]));
      const body = src.slice(i + 1, end < 0 ? src.length : end);
      if (fence[2]) out.push(`${C.grey}┌ ${fence[2]}${C.reset}`);
      for (const b of body) out.push(`${C.grey}│${C.reset} ${C.green}${b}${C.reset}`);
      i = end < 0 ? src.length : end;
      continue;
    }
    // a table: a header row, then its rule
    if (/^\s*\|.*\|\s*$/.test(l) && isRule(src[i + 1] || '')) {
      const rows = [l, src[i + 1]];
      let j = i + 2;
      while (j < src.length && /^\s*\|/.test(src[j])) rows.push(src[j++]);
      out.push(...table(rows, width));
      i = j - 1;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(`${C.bold}${h[1].length <= 2 ? C.mag : C.white}${inline(h[2])}${C.reset}`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push(`${C.grey}${'─'.repeat(Math.min(width, 40))}${C.reset}`); continue; }
    const q = /^\s*>\s?(.*)$/.exec(l);
    if (q) { out.push(`${C.grey}▌${C.reset} ${C.italic}${inline(q[1])}${C.reset}`); continue; }
    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(l);
    if (task) { out.push(`${task[1]}${task[2] === ' ' ? '☐' : `${C.green}☑${C.reset}`} ${inline(task[3])}`); continue; }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(l);
    if (bullet) { out.push(`${bullet[1]}${C.yellow}•${C.reset} ${inline(bullet[2])}`); continue; }
    const num = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(l);
    if (num) { out.push(`${num[1]}${C.yellow}${num[2]}.${C.reset} ${inline(num[3])}`); continue; }
    out.push(inline(l));
  }
  return out;
}
