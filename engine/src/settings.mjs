// Render settings: the formats, sizes and defaults an editor picks from.

import { PLATE_DEFAULT, normalizePlate, plateActive, plateKey } from './plate.mjs';
import { parseRate } from './rates.mjs';

export const FORMATS = {
  prores4444: { label: 'ProRes 4444 (alpha)', ext: '.mov', alpha: true, intra: true, suffix: '4444' },
  prores4444xq: { label: 'ProRes 4444 XQ (alpha)', ext: '.mov', alpha: true, intra: true, suffix: '4444XQ' },
  prores422hq: { label: 'ProRes 422 HQ', ext: '.mov', alpha: false, intra: true, suffix: '422HQ' },
  h264: { label: 'H.264 review', ext: '.mp4', alpha: false, intra: false, suffix: 'h264' },
  png: { label: 'PNG sequence (alpha)', ext: '', alpha: true, intra: true, suffix: 'png' },
  // Not a render: a script that builds the scene in After Effects as native,
  // editable layers. See engine/src/ae/.
  ae: { label: 'After Effects (editable layers)', ext: '.jsx', alpha: true, intra: false, suffix: 'AE', editable: true },
};

export const SIZES = {
  native: 'Native size',
  half: '50%',
  hd: 'Fit 1920×1080',
  uhd: 'Fit 3840×2160',
};

export const DEFAULTS = {
  format: 'prores4444',
  rate: '23.976',
  size: 'native',
  width: null,            // custom output width; overrides size
  transparent: false,     // drop the page background (the stage keeps its own)
  motionBlur: { enabled: false, shutter: 180, samples: 8 },
  review: false,          // also make an H.264 review copy beside the master
  partial: true,          // re-render only frames that changed since the last render
  xml: true,              // write a Premiere/Resolve XML for the batch
  pageSize: null,         // [w, h] for plain HTML pages; null = detect
  workers: 0,             // 0 = automatic
  aeFallbacks: [],        // After Effects: trade editability for fidelity, e.g. ['gradients']
  background: PLATE_DEFAULT, // a plate behind the render; see plate.mjs
};

// Starting points an editor picks from. Rate and size stay as set unless a preset names them.
export const PRESETS = [
  { id: 'master-alpha', label: 'Edit master', detail: 'ProRes 4444 with alpha, native size', settings: { format: 'prores4444', size: 'native', review: false } },
  { id: 'master-review', label: 'Master + review copy', detail: 'ProRes 4444 with alpha, plus an H.264 to send', settings: { format: 'prores4444', size: 'native', review: true } },
  { id: 'full-frame', label: 'Full-frame master', detail: 'ProRes 422 HQ, no alpha', settings: { format: 'prores422hq', size: 'native', review: false } },
  { id: 'client-review', label: 'Client review', detail: 'H.264 at 1080p', settings: { format: 'h264', size: 'hd', review: false } },
  { id: 'ae-layers', label: 'After Effects layers', detail: 'Editable shape, text and null layers with keyframes', settings: { format: 'ae' } },
  { id: 'ae-png', label: 'PNG sequence', detail: 'PNG sequence with alpha', settings: { format: 'png', size: 'native', review: false } },
  { id: 'uhd-master', label: '4K master', detail: 'ProRes 4444 with alpha at 3840 wide', settings: { format: 'prores4444', size: 'uhd', review: false } },
];

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export function normalizeSettings(input = {}) {
  const s = { ...DEFAULTS, ...input, motionBlur: { ...DEFAULTS.motionBlur, ...(input.motionBlur || {}) } };
  if (!FORMATS[s.format]) throw new Error(`Unknown format "${s.format}". Use ${Object.keys(FORMATS).join(', ')}.`);
  s.rateInfo = parseRate(s.rate);
  s.rate = s.rateInfo.label;
  s.motionBlur.shutter = Math.min(720, Math.max(1, Number(s.motionBlur.shutter) || 180));
  s.motionBlur.samples = Math.min(64, Math.max(2, Math.round(Number(s.motionBlur.samples) || 8)));
  s.background = normalizePlate(input.background || DEFAULTS.background);
  // A plate fills the frame, so there is nothing left to be transparent.
  if (plateActive(s.background)) s.transparent = false;
  s.aeFallbacks = Array.isArray(s.aeFallbacks) ? s.aeFallbacks.filter((k) => ['gradients', 'all'].includes(k)) : [];
  return s;
}

/** Output pixel size for a source of w×h. */
export function outputSize(w, h, settings) {
  let scale = 1;
  if (settings.width) scale = Number(settings.width) / w;
  else if (settings.size === 'half') scale = 0.5;
  else if (settings.size === 'hd') scale = Math.min(1920 / w, 1080 / h);
  else if (settings.size === 'uhd') scale = Math.min(3840 / w, 2160 / h);
  const outW = even(w * scale);
  const outH = even(h * scale);
  return { width: outW, height: outH, scale: outW / w };
}

/** Everything that changes the pixels of a frame, for deciding if a cached render still applies. */
export function pixelKey(settings, out, info) {
  return JSON.stringify({
    f: settings.format, r: settings.rate, w: out.width, h: out.height,
    t: !!settings.transparent, b: settings.motionBlur.enabled ? [settings.motionBlur.shutter, settings.motionBlur.samples] : 0,
    m: info.mode, sw: info.width, sh: info.height,
    p: plateKey(settings.background),
  });
}
