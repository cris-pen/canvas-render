// Background plates: a colour, a two-colour gradient or a still image put
// behind a render that has no alpha (or that should not have one).
//
// The plate is painted by the page itself, as the root element's background,
// so it sits under everything exactly as a browser would draw it and costs no
// extra compositing pass. "Replace" also clears the design's own top-level
// fill, so the plate shows instead of it rather than only where the design is
// already transparent.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const PLATE_MODES = ['page', 'color', 'gradient', 'image'];

export const PLATE_DEFAULT = {
  mode: 'page',
  color: '#101418',
  gradient: { kind: 'linear', angle: 180, from: '#1d2a33', to: '#0b1014' },
  image: null,
  replace: false,
};

// Starting points for the UI. Chroma colours are for keying an opaque master.
export const PLATE_PRESETS = [
  { id: 'ink', label: 'Ink', plate: { mode: 'gradient', gradient: { kind: 'linear', angle: 160, from: '#1e293b', to: '#0b1120' } } },
  { id: 'studio', label: 'Studio', plate: { mode: 'gradient', gradient: { kind: 'radial', angle: 180, from: '#44474d', to: '#131416' } } },
  { id: 'dusk', label: 'Dusk', plate: { mode: 'gradient', gradient: { kind: 'linear', angle: 135, from: '#3b1d4a', to: '#e9875b' } } },
  { id: 'sea', label: 'Sea', plate: { mode: 'gradient', gradient: { kind: 'linear', angle: 180, from: '#0f4655', to: '#08161c' } } },
  { id: 'paper', label: 'Paper', plate: { mode: 'gradient', gradient: { kind: 'linear', angle: 180, from: '#f7f3ea', to: '#e3dccb' } } },
  { id: 'black', label: 'Black', plate: { mode: 'color', color: '#000000' } },
  { id: 'white', label: 'White', plate: { mode: 'color', color: '#ffffff' } },
  { id: 'green', label: 'Chroma green', plate: { mode: 'color', color: '#00b140' } },
  { id: 'blue', label: 'Chroma blue', plate: { mode: 'color', color: '#0047bb' } },
];

const HEX = /^#[0-9a-f]{6}$/i;
const IMAGE = /\.(png|jpe?g|webp|gif|avif)$/i;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };

/** Clean up a plate from settings, the UI or the mailbox. Throws on bad input. */
export function normalizePlate(input) {
  const p = { ...PLATE_DEFAULT, ...(input || {}) };
  p.gradient = { ...PLATE_DEFAULT.gradient, ...((input && input.gradient) || {}) };
  if (!PLATE_MODES.includes(p.mode)) throw new Error(`Unknown background "${p.mode}". Use ${PLATE_MODES.join(', ')}.`);
  for (const c of [p.color, p.gradient.from, p.gradient.to]) {
    if (!HEX.test(String(c))) throw new Error(`Background colours are #rrggbb, not "${c}".`);
  }
  if (!['linear', 'radial'].includes(p.gradient.kind)) throw new Error('A background gradient is linear or radial.');
  p.gradient.angle = ((Number(p.gradient.angle) % 360) + 360) % 360;
  p.replace = !!p.replace;
  if (p.mode === 'image') {
    if (!p.image || !IMAGE.test(String(p.image))) throw new Error('A background image is a PNG, JPEG, WebP, GIF or AVIF file.');
    p.image = path.resolve(String(p.image));
  } else {
    p.image = p.image ? String(p.image) : null;
  }
  return p;
}

export const plateActive = (p) => !!p && p.mode && p.mode !== 'page';

/** What changes the pixels: for cache keys. An image counts by path and modification time. */
export function plateKey(p) {
  if (!plateActive(p)) return 0;
  const k = { m: p.mode, r: p.replace };
  if (p.mode === 'color') k.c = p.color.toLowerCase();
  if (p.mode === 'gradient') k.g = [p.gradient.kind, p.gradient.angle, p.gradient.from.toLowerCase(), p.gradient.to.toLowerCase()];
  if (p.mode === 'image') {
    let mtime = 0;
    try { mtime = statSync(p.image).mtimeMs; } catch { /* missing: plateCss says so */ }
    k.i = [p.image, mtime];
  }
  return k;
}

const dataUrlCache = new Map();

/** The CSS the page paints. Null when the plate is off. */
export function plateCss(p) {
  if (!plateActive(p)) return null;
  let css;
  if (p.mode === 'color') css = p.color;
  else if (p.mode === 'gradient') {
    const g = p.gradient;
    css = g.kind === 'radial'
      ? `radial-gradient(farthest-corner at 50% 45%, ${g.from}, ${g.to})`
      : `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})`;
  } else {
    let st;
    try { st = statSync(p.image); } catch { throw new Error(`Background image not found: ${p.image}`); }
    const key = `${p.image}:${st.mtimeMs}`;
    let url = dataUrlCache.get(key);
    if (!url) {
      const mime = MIME[path.extname(p.image).toLowerCase()] || 'image/png';
      url = `data:${mime};base64,${readFileSync(p.image).toString('base64')}`;
      dataUrlCache.clear();
      dataUrlCache.set(key, url);
    }
    css = `url("${url}") center / cover no-repeat, #000`;
  }
  return { css, replace: p.replace };
}
