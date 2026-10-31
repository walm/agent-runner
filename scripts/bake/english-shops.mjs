// usage: node scripts/bake/english-shops.mjs → public/tex/shop_albedo.webp + public/tex/shopkit_albedo.webp
// The shopfront textures from the Asian Shop Pack carry Chinese and Korean signage. This repaints every such board
// in English: each one is covered with its own colour (the median of a ring just inside it), lettered on top, or,
// where the surface has texture (glass, a shutter), patched with a clean piece cloned from beside it. It always
// starts from the original textures in git, so it can be re-run after editing the list below.
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const ORIGINAL = 'upstream/main'; // the untouched Neon Zenith textures
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

// a board: rect to cover, then lines of lettering (size is a fraction of the rect height; ink is sampled if absent)
// fill: cover only. clone: copy src over dst. y values in shopkit are per 1024 layer (L).
const SHOP = [
  { board: [4, 150, 202, 80], lines: [{ t: 'BLOSSOMTIME', size: 0.34, font: SANS, w: 600 }, { t: 'FLORAL', size: 0.2, font: SANS, w: 500, dy: 0.32 }] },
  { board: [222, 163, 229, 58], lines: [{ t: 'KAM NOODLES', size: 0.5, font: SERIF, w: 700 }] },
  { board: [410, 250, 38, 181], vertical: { t: 'CONGEE', size: 0.8, font: SERIF, w: 700 } },
  { board: [468, 50, 324, 92], lines: [{ t: 'KAM CHING HONG', size: 0.5, font: SERIF, w: 700 }] },
  { clone: { src: [585, 300, 50, 125], dst: [517, 300, 50, 125] } },
  { fill: [706, 383, 34, 94] },
  { board: [830, 119, 163, 71], lines: [{ t: 'TAILOR', size: 0.55, font: SERIF, w: 700 }] },
  { fill: [862, 279, 40, 92] },
  { fill: [924, 279, 40, 92] },
  { fill: [990, 270, 17, 122] },
  { board: [1062, 112, 301, 60], lines: [{ t: 'TICKETS · TOURS', size: 0.55, font: SERIF, w: 700 }] },
  { board: [1494, 72, 302, 72], lines: [{ t: 'TONG SIK TONG', size: 0.52, font: SERIF, w: 700 }] },
  { board: [1854, 21, 167, 116], lines: [{ t: 'PAWN', size: 0.42, font: SERIF, w: 700 }] },
];

const KIT = [
  // layer 0
  { board: [0, 135, 122, 125, 0] },
  { board: [140, 100, 316, 190, 0], lines: [{ t: 'KAM CHING HONG', size: 0.25, font: SERIF, w: 700 }] },
  { clone: { src: [262, 600, 52, 255, 0], dst: [188, 600, 52, 255, 0] } },
  { fill: [370, 768, 36, 184, 0] },
  { board: [482, 142, 296, 150, 0], lines: [{ t: 'TONG SIK TONG', size: 0.3, font: SERIF, w: 700 }] },
  { board: [838, 46, 156, 236, 0], lines: [{ t: 'PAWN', size: 0.24, font: SERIF, w: 700 }] },
  // layer 1
  { board: [298, 236, 184, 145, 1], lines: [{ t: 'TAILOR', size: 0.32, font: SERIF, w: 700 }] },
  { fill: [338, 572, 42, 146, 1] },
  { fill: [406, 572, 42, 146, 1] },
  { fill: [476, 540, 22, 246, 1] },
  { board: [556, 222, 336, 125, 1], lines: [{ t: 'TICKETS · TOURS', size: 0.34, font: SERIF, w: 700 }] },
  // layer 2
  { board: [248, 252, 256, 116, 2], lines: [{ t: 'BAKERY', size: 0.45, font: SERIF, w: 700 }] },
  { disc: [183, 315, 34, 2] },
  { board: [520, 396, 226, 50, 2], lines: [{ t: 'FLORAL · GIFTS', size: 0.55, font: SANS, w: 500 }] },
  { board: [764, 326, 256, 118, 2], lines: [{ t: 'KAM NOODLES', size: 0.42, font: SERIF, w: 700 }] },
  { board: [971, 462, 44, 410, 2], vertical: { t: 'CONGEE', size: 0.8, font: SERIF, w: 700 } },
  // layer 3: the Korean brewery
  { board: [22, 36, 980, 150, 3], lines: [{ t: 'CRAFT BEER', size: 0.72, font: SANS, w: 800 }], ink: '#344a7a' },
  // the clean band of shutter under the Korean, stacked up over it (the slats run horizontally, so rows tile)
  // (the band stops short of the beer mug; the last strip comes from just left of it)
  ...[0, 1, 2, 3, 4].map((k) => ({ clone: { src: [356, 694, 404, 40, 3], dst: [356, 512 + k * 38, 404, 40, 3] } })),
  ...[0, 1, 2, 3].map((k) => ({ clone: { src: [700, 694, 50, 40, 3], dst: [760, 512 + k * 38, 50, 40, 3] } })),
  { text: [360, 520, 450, 170, 3], lines: [{ t: 'BEER', size: 0.82, font: SANS, w: 800 }], ink: '#344a7a' },
];

const at = (r) => (r.length > 4 ? [r[0], r[1] + r[4] * 1024, r[2], r[3]] : r);
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function patch(file, list) {
  const src = execFileSync('git', ['show', `${ORIGINAL}:public/tex/${file}`], { cwd: root, maxBuffer: 64 << 20 });
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;
  const px = (x, y) => { const i = (y * W + x) * C; return [data[i], data[i + 1], data[i + 2]]; };
  const median = (arr) => [0, 1, 2].map((k) => arr.map((p) => p[k]).sort((a, b) => a - b)[arr.length >> 1]);
  // the board's own colour: a ring just inside its edge; its ink: the pixels furthest from that colour
  const sample = ([x, y, w, h]) => {
    const ring = [], all = [];
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
      const p = px(i, j);
      all.push(p);
      if (i - x < 3 || x + w - 1 - i < 3 || j - y < 3 || y + h - 1 - j < 3) ring.push(p);
    }
    const bg = median(ring);
    const d = (p) => Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]);
    const ink = median(all.sort((a, b) => d(b) - d(a)).slice(0, Math.max(8, all.length >> 5)));
    return { bg: hex(bg), ink: hex(ink) };
  };
  const clones = [];
  let svg = '';
  const letter = (r, lines, ink) => {
    const [x, y, w, h] = r;
    for (const l of lines) {
      let fs = h * l.size;
      // keep inside the board: a rough advance of 0.62 em per character
      fs = Math.min(fs, (w * 0.9) / (l.t.length * (l.font === SERIF ? 0.8 : 0.7)));
      const cy = y + h / 2 + (l.dy || 0) * h + fs * 0.35 - (lines.length > 1 && !l.dy ? h * 0.12 : 0);
      svg += `<text x="${x + w / 2}" y="${cy}" font-family="${l.font}" font-weight="${l.w}" font-size="${fs.toFixed(1)}" fill="${ink}" text-anchor="middle" letter-spacing="${(fs * 0.04).toFixed(1)}">${esc(l.t)}</text>`;
    }
  };
  for (const p of list) {
    if (p.clone) {
      const [sx, sy, sw, sh] = at(p.clone.src), [dx, dy] = at(p.clone.dst);
      clones.push({ input: await sharp(src).extract({ left: sx, top: sy, width: sw, height: sh }).toBuffer(), left: dx, top: dy });
      continue;
    }
    if (p.disc) {
      const [cx, cy, r, L] = p.disc, y = cy + L * 1024;
      svg += `<circle cx="${cx}" cy="${y}" r="${r}" fill="${sample([cx - r, y - r, 2 * r, 2 * r]).bg}"/>`;
      continue;
    }
    const r = at(p.board || p.fill || p.text);
    const { bg, ink } = sample(r);
    if (!p.text) svg += `<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" fill="${bg}"/>`;
    if (p.lines) letter(r, p.lines, p.ink || ink);
    if (p.vertical) {
      const v = p.vertical, n = v.t.length, step = r[3] / n, fs = Math.min(r[2] * v.size, step * 0.8);
      [...v.t].forEach((ch, i) => { svg += `<text x="${r[0] + r[2] / 2}" y="${r[1] + step * (i + 0.5) + fs * 0.35}" font-family="${v.font}" font-weight="${v.w}" font-size="${fs.toFixed(1)}" fill="${p.ink || ink}" text-anchor="middle">${ch}</text>`; });
    }
  }
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`);
  // clones first, so a board drawn over the same spot (the brewery shutter) letters on the clean copy
  const out = await sharp(await sharp(src).composite(clones).toBuffer()).composite([{ input: overlay }]).webp({ quality: 90 }).toBuffer();
  await sharp(out).toFile(resolve(root, 'public/tex', file));
  console.log('patched', file, list.length, 'regions');
}

await patch('shop_albedo.webp', SHOP);
await patch('shopkit_albedo.webp', KIT);
