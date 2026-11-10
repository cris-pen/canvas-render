// Resolve the images a design references into real files, and work out how each
// one is fitted into its box.
//
// Claude Design inlines images as data URIs (that is how they ride inside a
// published canvas), a plain HTML page usually links them over http or from
// disk, and either way After Effects needs an actual file on disk to import.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_FOR_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif', 'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

/** Every distinct image URL a capture referenced, with where it came from. */
export function collectImageUrls(capture) {
  const urls = new Set();
  for (const frame of capture.frames) {
    for (const entry of frame.elements) {
      if (!entry.present) continue;
      if (entry.src) urls.add(entry.src);
      const bg = entry.style && entry.style.backgroundImage;
      if (bg && bg !== 'none') {
        for (const m of bg.matchAll(/url\((['"]?)(.*?)\1\)/g)) urls.add(m[2]);
      }
    }
  }
  return [...urls];
}

/**
 * Bytes for one image URL, or null when it cannot be reached.
 * Handles the three shapes a design can use: an inline data URI, something the
 * page fetched over the network, and a path on disk.
 */
export function resolveAsset(url, { assetFiles, baseDir } = {}) {
  if (!url) return null;

  const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (data) {
    const mime = data[1] || 'application/octet-stream';
    const bytes = data[2]
      ? Buffer.from(data[3], 'base64')
      : Buffer.from(decodeURIComponent(data[3]), 'utf8');
    return { bytes, mime, ext: EXT_FOR_MIME[mime] || '.bin' };
  }

  if (assetFiles && assetFiles.has(url)) {
    const hit = assetFiles.get(url);
    const mime = (hit.contentType || '').split(';')[0];
    return { bytes: hit.bytes, mime, ext: EXT_FOR_MIME[mime] || path.extname(url) || '.bin' };
  }

  let file = null;
  if (url.startsWith('file://')) file = fileURLToPath(url);
  else if (baseDir && !/^https?:/.test(url)) file = path.resolve(baseDir, url);
  if (file && existsSync(file)) {
    const ext = path.extname(file).toLowerCase();
    return { bytes: readFileSync(file), mime: null, ext: ext || '.bin' };
  }
  return null;
}

/**
 * How an image sits inside its box.
 *
 * Returns { scale: [sx, sy], offset: [dx, dy], clips } where a source pixel p
 * lands at `offset + p * scale` in the element's box space, and `clips` marks
 * the fits that deliberately overflow (cover, and an oversized `none`).
 *
 * `mode` takes object-fit values and the background-size keywords, which share
 * the same geometry; `position` is the CSS position as fractions of the leftover
 * space, matching how CSS resolves percentages for both properties.
 */
export function computeFit({ naturalW, naturalH, boxW, boxH, mode = 'fill', position = [0.5, 0.5], sizeW, sizeH }) {
  if (!naturalW || !naturalH) return { scale: [1, 1], offset: [0, 0], clips: false };
  let sx;
  let sy;
  switch (mode) {
    case 'contain':
    case 'scale-down': {
      let k = Math.min(boxW / naturalW, boxH / naturalH);
      if (mode === 'scale-down') k = Math.min(1, k);
      sx = k; sy = k;
      break;
    }
    case 'cover': {
      const k = Math.max(boxW / naturalW, boxH / naturalH);
      sx = k; sy = k;
      break;
    }
    case 'none':
      sx = 1; sy = 1;
      break;
    case 'explicit':
      sx = (sizeW || naturalW) / naturalW;
      sy = (sizeH || naturalH) / naturalH;
      break;
    case 'fill':
    default:
      sx = boxW / naturalW;
      sy = boxH / naturalH;
      break;
  }
  const drawnW = naturalW * sx;
  const drawnH = naturalH * sy;
  // CSS distributes the leftover space by the position fraction; when the image
  // is larger than the box the leftover is negative and the same formula
  // centres the overflow, which is what cover does.
  // A fraction resolves against the space left over; a length is measured
  // from the box's own edge. A bare number is read as a fraction, which is what
  // this used to take.
  const place = (spec, box, drawn) => {
    if (typeof spec === 'number') return (box - drawn) * spec;
    if (spec && spec.length !== undefined) return spec.length;
    return (box - drawn) * ((spec && spec.fraction) || 0);
  };
  const offset = [place(position[0], boxW, drawnW), place(position[1], boxH, drawnH)];
  return { scale: [sx, sy], offset, clips: drawnW > boxW + 0.5 || drawnH > boxH + 0.5 };
}

/** `background-position` -> fractions of the leftover space. */
export function parseBackgroundPosition(value) {
  const parts = String(value || '50% 50%').trim().split(/\s+/);
  // Each axis is either a FRACTION of the leftover space (keywords and
  // percentages) or an absolute LENGTH from the box's edge. The two cannot be
  // collapsed into one number here -- the leftover space is not known until
  // the image has been sized -- so both are carried through to computeFit,
  // which is the only place that knows it.
  const axis = (v, fallback) => {
    if (v === undefined) return { fraction: fallback };
    if (v.endsWith('%')) return { fraction: parseFloat(v) / 100 };
    if (v === 'left' || v === 'top') return { fraction: 0 };
    if (v === 'right' || v === 'bottom') return { fraction: 1 };
    if (v === 'center') return { fraction: 0.5 };
    const n = parseFloat(v);
    return Number.isFinite(n) ? { length: n } : { fraction: fallback };
  };
  return [axis(parts[0], 0.5), axis(parts[1], 0.5)];
}

/** `background-size` -> a mode computeFit understands, plus explicit lengths. */
export function parseBackgroundSize(value) {
  const v = String(value || 'auto').trim().toLowerCase();
  if (v === 'cover') return { mode: 'cover' };
  if (v === 'contain') return { mode: 'contain' };
  if (v === 'auto' || v === 'auto auto') return { mode: 'none' };
  const parts = v.split(/\s+/);
  const px = parts.map((p) => (p.endsWith('px') ? parseFloat(p) : null));
  if (px[0] !== null) return { mode: 'explicit', sizeW: px[0], sizeH: px[1] ?? px[0] };
  return { mode: 'none' };
}
