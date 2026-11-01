// Word wrap for the terminal. xterm.js breaks a line that is too long at its last column, in the middle of a word;
// the lines an agent sends are broken at spaces before they are written instead, the rest of a line going on under
// its indent (a bullet's text under the text, a reply's under the reply). terminal.js wraps again at every width
// the terminal takes.
//
// Left alone: lines with cursor movement or a carriage return (a raw terminal stream draws its own screen), table
// and box rows (a box broken at a space falls apart), and the end of a chunk that has no newline yet (it may go on
// in the next one).

// one escape sequence of colour or style (zero width), or one character
const ATOM = /\x1b\[[0-9;]*m|[\s\S]/gu;
// anything but colour and style: cursor moves, erases, modes, titles
const CONTROL = /\x1b\[[0-9;?]*[A-LN-Za-ln-z@`]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[^[\]]|\r(?!$)/;
const BOX = /^\s*[│┌├└┬┼┴┐┤┘─]/;
const SGR = /\x1b\[[0-9;]*m/g;

// what a continuation goes under: the line's leading spaces, and a bullet, number or marker after them
function indentOf(plain, cols) {
  const m = /^(\s*)((?:[•☐☑▌⏺⎿>❯?]|\d+[.)])\s+)?/.exec(plain);
  const n = m ? m[0].length : 0;
  return n > cols / 2 ? 0 : n;
}

export function wrapLine(line, cols) {
  if (cols < 10 || CONTROL.test(line)) return line;
  const plain = line.replace(SGR, '');
  if (plain.replace(/\r$/, '').length <= cols || BOX.test(plain)) return line;
  const cr = line.endsWith('\r') ? '\r' : '';
  const body = cr ? line.slice(0, -1) : line;
  const indent = indentOf(plain, cols), pad = ' '.repeat(indent);
  let out = '';
  let row = [], col = 0;
  const lastSpace = () => { for (let i = row.length - 1; i > 0; i--) if (row[i] === ' ') return i; return -1; };
  for (const atom of body.match(ATOM) || []) {
    if (atom.length > 1 && atom.charCodeAt(0) === 27) { row.push(atom); continue; }
    if (col >= cols) {
      const at = lastSpace();
      // break at the last space, unless it sits in the indent (a word longer than the line is cut)
      const fromIndent = row.slice(0, at).join('').replace(SGR, '').length;
      if (at > 0 && (out ? fromIndent > 0 : fromIndent > indent)) {
        out += row.slice(0, at).join('') + '\r\n' + pad;
        row = row.slice(at + 1);
      } else {
        out += row.join('') + '\r\n' + pad;
        row = [];
      }
      col = indent + row.join('').replace(SGR, '').length;
    }
    row.push(atom);
    col++;
  }
  return out + row.join('') + cr;
}

// a chunk of output: its whole lines wrapped, a line still open at its end written as it is. `state.open` says
// whether the chunk before ended mid-line (that line's rest is not wrapped either).
export function wrapChunk(text, cols, state = { open: false }) {
  const parts = String(text).split('\n');
  const out = parts.map((p, i) => {
    const last = i === parts.length - 1;
    if (last) return p; // after the last newline: still open
    if (i === 0 && state.open) return p;
    return wrapLine(p, cols);
  });
  state.open = parts[parts.length - 1] !== '';
  return out.join('\n');
}
