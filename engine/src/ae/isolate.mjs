// Raster fallback: render one element's subtree on its own, with alpha, for
// the elements After Effects cannot rebuild as layers (a 3D skew, a matrix AE
// cannot decompose, a <video>).
//
// Everything else on the page is hidden with `visibility`, which removes an
// element's own paint but leaves its descendants free to show. So the target's
// ancestors still contribute what they do to it -- opacity, clipping, filters --
// and their backgrounds and siblings do not. What comes out is exactly that
// element's share of each frame, baked with its motion, ready to sit in the
// root comp as footage.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { wireContext } from '../browser.mjs';
import { frameTime } from '../rates.mjs';
import { INIT, STAGE_ROOT } from './capture.mjs';

const ISOLATE_CSS = `
*:not([data-d2ae-iso]):not([data-d2ae-iso] *) { visibility: hidden !important; }
[data-d2ae-iso="show"] { visibility: visible !important; }
`;

function cancelled() {
  const e = new Error('Cancelled.');
  e.code = 'CANCELLED';
  return e;
}

/**
 * Render each id's subtree for `frames` frames. Returns a Map of id ->
 *   { files, width, height, offset: [x, y], frames, static } or { empty: true }
 * Files are cropped to the union of everything the element ever painted, so a
 * small element does not ship as full-frame footage.
 */
export async function isolateNodes({ browser, roots, scene, info, rate, ids, outDir, frames, onFrame, signal }) {
  const out = new Map();
  if (!ids.length) return out;
  const stage = info.mode === 'stage';
  const { width, height } = info;
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block',
    reducedMotion: 'no-preference', colorScheme: 'light',
  });
  await wireContext(context, roots);
  await context.addInitScript({ content: INIT });
  const page = await context.newPage();
  const work = path.join(outDir, '.isolate');
  const full = new Map(ids.map((id) => [id, []]));
  try {
    await page.goto(scene.url, { waitUntil: 'load', timeout: 90000 });
    await page.evaluate((o) => window.__cr.ready(o), { transparent: true });
    await page.evaluate(async ({ r, st, css }) => {
      if (st) await window.__cr.seek(0); else window.__d2ae.seek(0);
      window.__d2ae.index(r);
      const s = document.createElement('style');
      s.id = 'd2ae-isolate';
      s.textContent = css;
      window.__d2aeIsolateSheet = s;
    }, { r: stage ? STAGE_ROOT : null, st: stage, css: ISOLATE_CSS });

    for (const id of ids) mkdirSync(path.join(work, String(id)), { recursive: true });
    for (let f = 0; f < frames; f += 1) {
      if (signal && signal.aborted) throw cancelled();
      const ms = frameTime(f, rate) * 1000;
      // Same sequence of calls as the capture, so ids land on the same elements.
      await page.evaluate(async ({ t, n, st }) => {
        window.__d2ae.setGeneration(n);
        if (st) await window.__cr.seek(t); else window.__d2ae.seek(t);
        window.__d2ae.index();
      }, { t: ms, n: f, st: stage });
      for (const id of ids) {
        const present = await page.evaluate((target) => {
          const el = document.querySelector(`[data-d2ae-id="${target}"]`);
          if (!el) return false;
          const cs = getComputedStyle(el);
          if (cs.display === 'none') return false;
          el.setAttribute('data-d2ae-iso', cs.visibility === 'hidden' ? 'hide' : 'show');
          document.head.appendChild(window.__d2aeIsolateSheet);
          void document.documentElement.offsetWidth;
          return true;
        }, id);
        const file = path.join(work, String(id), `${String(f).padStart(5, '0')}.png`);
        if (present) {
          writeFileSync(file, await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width, height } }));
          await page.evaluate((target) => {
            const el = document.querySelector(`[data-d2ae-id="${target}"]`);
            if (el) el.removeAttribute('data-d2ae-iso');
            window.__d2aeIsolateSheet.remove();
          }, id);
        } else {
          writeFileSync(file, await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
        }
        full.get(id).push(file);
      }
      if (onFrame) onFrame(f + 1, frames);
    }
  } finally {
    await context.close().catch(() => {});
  }

  // Crop every frame to the union of what the element painted across the run.
  for (const id of ids) {
    const files = full.get(id);
    let box = null;
    for (const file of files) {
      const b = await alphaBounds(file);
      if (!b) continue;
      box = box
        ? { left: Math.min(box.left, b.left), top: Math.min(box.top, b.top), right: Math.max(box.right, b.right), bottom: Math.max(box.bottom, b.bottom) }
        : b;
    }
    if (!box) { out.set(id, { empty: true }); continue; }
    const crop = { left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top };
    const dir = path.join(outDir, `raster-${id}`);
    mkdirSync(dir, { recursive: true });
    const written = [];
    const distinct = new Set();
    for (let i = 0; i < files.length; i += 1) {
      const bytes = await sharp(files[i]).extract(crop).png().toBuffer();
      const file = path.join(dir, `${String(i).padStart(5, '0')}.png`);
      writeFileSync(file, bytes);
      written.push(file);
      distinct.add(createHash('sha1').update(bytes).digest('hex'));
    }
    out.set(id, {
      files: written, width: crop.width, height: crop.height, offset: [crop.left, crop.top],
      frames: written.length, static: distinct.size === 1,
    });
  }
  rmSync(work, { recursive: true, force: true });
  return out;
}

/** The bounding box of non-transparent pixels, or null for an empty frame. */
async function alphaBounds(file) {
  const { data, info } = await sharp(file).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let left = width; let right = -1; let top = height; let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let rowHit = false;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x] === 0) continue;
      rowHit = true;
      if (x < left) left = x;
      if (x > right) right = x;
    }
    if (rowHit) { if (y < top) top = y; bottom = y; }
  }
  if (right < 0) return null;
  return { left, top, right: right + 1, bottom: bottom + 1 };
}

function rootOf(ir) {
  return ir.comps.find((c) => c.id === ir.rootCompId) || ir.comps[ir.comps.length - 1];
}

/**
 * The elements to render in isolation: unexpressible layers in the root comp,
 * and ones that a precomp was built around (a perspective subtree), whose
 * precomp layer in the root gets replaced as a whole. A raster deeper inside a
 * precomp stays a placeholder: its footage would be in page space, and the
 * precomp's space is not.
 */
export function rasterTargets(ir) {
  const root = rootOf(ir);
  const ids = [];
  for (const c of ir.comps) {
    for (const l of c.layers) {
      if (l.kind !== 'raster') continue;
      if (c === root) ids.push(l.id);
      else if (root.layers.some((x) => x.kind === 'precomp' && x.compId === c.id && (x.id === l.id || c.pageShift))) ids.push(l.id);
    }
  }
  return ids;
}

const moves = (track) => !!(track && track.keys && track.keys.length);

/** Whether a root layer and every parent above it hold still for the whole run. */
function chainStill(root, id) {
  const byId = new Map(root.layers.map((l) => [l.id, l]));
  let l = byId.get(id);
  while (l) {
    if (Object.values(l.transform || {}).some(moves)) return false;
    l = l.parentId === null || l.parentId === undefined ? null : byId.get(l.parentId);
  }
  return true;
}

/**
 * Put the isolated footage in place of each target. Descendants are baked into
 * the footage, so their layers go, and any comp no longer reachable from the
 * root goes with them. Returns the dropped layer ids.
 */
function descendants(layers, id) {
  const below = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of layers) {
      if (!below.has(l.id) && l.parentId !== null && l.parentId !== undefined && below.has(l.parentId)) { below.add(l.id); grew = true; }
    }
  }
  below.delete(id);
  return below;
}

function footageAsset(layer, shot) {
  return {
    id: `raster-${layer.id}`,
    kind: shot.static ? 'still' : 'sequence',
    ext: '.png',
    files: shot.static ? [shot.files[0]] : shot.files,
    frames: shot.static ? 1 : shot.frames,
    width: shot.width,
    height: shot.height,
    source: `${layer.name} rendered in isolation, ${shot.frames} frame(s) at ${shot.width}x${shot.height}${shot.static ? ' (static)' : ''}`,
  };
}

function footageLayer(layer, shot, offset, rate) {
  const stat = (v) => ({ static: v, dims: Array.isArray(v) ? v.length : 1, maxError: 0 });
  return {
    id: layer.id,
    name: layer.kind === 'precomp' ? layer.name.replace(/ \(3D\)$/, '') : layer.name,
    parentId: null,
    kind: 'image',
    tier: 'C',
    threeD: false,
    role: layer.role,
    inPoint: 0,
    outPoint: (shot.frames - 1) * rate.den / rate.num,
    loop: null,
    image: { assetId: `raster-${layer.id}`, natural: [shot.width, shot.height], objectFit: 'fill', sequence: !shot.static },
    transform: {
      anchorPoint: stat([0, 0]),
      position: stat([offset[0], offset[1]]),
      scale: stat([100, 100]),
      opacity: stat(100),
      rotation: stat(0),
    },
    // Its own filters, opacity and motion are in the pixels already. Blending
    // is not: the footage was drawn over nothing, so it still blends in AE.
    blendMode: layer.blendMode,
    effects: [],
    rasterised: true,
  };
}

export function applyIsolation(ir, isolated, rate) {
  const root = rootOf(ir);
  const dropped = new Set();
  for (const [id, shot] of isolated) {
    // Inside a clip comp: the footage already carries the clipping, so it goes
    // in that comp at its page position (shifted into the comp's space) while
    // the clipped content holds still, or straight into the root above the
    // clip comp when it moves.
    const clipComp = ir.comps.find((c) => c !== root && c.pageShift && c.layers.some((l) => l.id === id));
    if (clipComp) {
      const k = clipComp.layers.findIndex((l) => l.id === id);
      const layer = clipComp.layers[k];
      const holderIndex = root.layers.findIndex((l) => l.kind === 'precomp' && l.compId === clipComp.id);
      const below = descendants(clipComp.layers, id);
      clipComp.layers = clipComp.layers.filter((l) => !below.has(l.id));
      for (const d of below) dropped.add(d);
      if (shot.empty) { clipComp.layers = clipComp.layers.filter((l) => l.id !== id); dropped.add(id); continue; }
      const still = holderIndex !== -1 && chainStill(root, root.layers[holderIndex].id);
      const offset = still ? [shot.offset[0] + clipComp.pageShift[0], shot.offset[1] + clipComp.pageShift[1]] : shot.offset;
      const footage = footageLayer(layer, shot, offset, rate);
      if (still) {
        clipComp.layers[clipComp.layers.findIndex((l) => l.id === id)] = footage;
      } else {
        clipComp.layers = clipComp.layers.filter((l) => l.id !== id);
        root.layers.splice(holderIndex + 1, 0, footage);
      }
      ir.assets.push(footageAsset(layer, shot));
      continue;
    }
    const index = root.layers.findIndex((l) => l.id === id);
    if (index === -1) continue;
    const layer = root.layers[index];
    const inner = layer.kind === 'precomp' ? ir.comps.find((c) => c.id === layer.compId) : null;
    if (inner) for (const l of inner.layers) if (l.id !== id) dropped.add(l.id);
    // Root layers parented beneath it are in the footage now too.
    const below = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const l of root.layers) {
        if (!below.has(l.id) && l.parentId !== null && below.has(l.parentId)) { below.add(l.id); grew = true; }
      }
    }
    below.delete(id);
    for (const d of below) dropped.add(d);
    if (shot.empty) { dropped.add(id); continue; }
    ir.assets.push(footageAsset(layer, shot));
    root.layers[index] = footageLayer(layer, shot, shot.offset, rate);
  }
  if (dropped.size) root.layers = root.layers.filter((l) => !dropped.has(l.id));
  // Comps nothing points at any more (a perspective comp whose subject became
  // footage, and anything only it contained).
  const reachable = new Set([root.id]);
  const walk = (comp) => {
    for (const l of comp.layers) {
      if (l.kind !== 'precomp' || reachable.has(l.compId)) continue;
      reachable.add(l.compId);
      const next = ir.comps.find((c) => c.id === l.compId);
      if (next) walk(next);
    }
  };
  walk(root);
  ir.comps = ir.comps.filter((c) => reachable.has(c.id));
  // A clip-path member whose clipper was baked away has nothing to follow.
  for (const l of root.layers) {
    if (l.clipBy && !root.layers.some((x) => x.name === l.clipBy.clipper)) delete l.clipBy;
  }
  return { dropped: [...dropped] };
}
