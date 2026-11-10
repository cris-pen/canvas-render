// CSS clip-path -> After Effects masks.
//
// A clip-path wipe (`inset()` animating open), an iris (`circle()` growing) or
// a diagonal reveal (`polygon()`) is one of the most common moves in motion
// design, and none of it survives as a transform. Here it becomes masks.
//
// The clip's numbers become Slider Controls on the clipping layer: "Clip Left",
// "Clip Top", "Clip Right", "Clip Bottom" and so on, keyframed with the same
// fitted, exactly-eased tracks as every other property. Each mask builds its
// path from those sliders with an expression, so the wipe is retimed or
// re-eased by editing ordinary keyframes rather than a mask path.
//
// CSS clips an element's descendants as well as its own paint, but an AE mask
// only cuts the layer it is on. So every painting layer under the clipper gets
// a mask too, with an expression that maps the clipper's region into its own
// space through toComp/fromComp. Children that move under a fixed clip stay
// clipped correctly, which a mask copied in layer space would not.
//
// Values are in the clipping element's border box, in CSS pixels.

import { buildScalarTrack } from './track.mjs';
import { collectSubtree } from './precomp.mjs';
import { computeFit } from '../ingest/assets.mjs';
import { svgUserFrame } from '../analyze/layers.mjs';

const PAINTS = new Set(['shape', 'text', 'image', 'path', 'precomp', 'raster']);
const CLIPPER_KINDS = new Set(['shape', 'null', 'text', 'image']);

function splitTop(str, sep) {
  // Split on a separator outside parentheses.
  const out = []; let depth = 0; let cur = '';
  for (const ch of str) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A CSS length or percentage against `basis`. */
function len(token, basis) {
  if (token === undefined) return null;
  const t = String(token).trim();
  if (t === '0') return 0;
  const m = /^(-?[\d.]+(?:e-?\d+)?)(px|%)?$/i.exec(t);
  if (!m) return null;
  const v = Number(m[1]);
  return m[2] === '%' ? (v / 100) * basis : v;
}

/** `at x y` positions, with keywords. */
function position(tokens, w, h) {
  const kw = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
  const pick = (t, basis) => (t in kw ? (kw[t] / 100) * basis : len(t, basis));
  if (!tokens.length) return [w / 2, h / 2];
  let [a, b] = tokens;
  if (b === undefined) b = 'center';
  // `top left` order is allowed; normalise to horizontal first.
  if ((a === 'top' || a === 'bottom') && (b === 'left' || b === 'right' || b === 'center')) [a, b] = [b, a];
  return [pick(a, w), pick(b, h)];
}

/**
 * Parse one computed clip-path value into a shape in border-box pixels.
 * Returns null for none, { unsupported } for what this does not convert.
 */
export function parseClipPath(value, box) {
  if (!value || value === 'none') return null;
  const [w, h] = box.size;
  const [bt, br, bb, bl] = box.border || [0, 0, 0, 0];
  const [pt, pr, pb, pl] = box.padding || [0, 0, 0, 0];
  let v = value.trim();
  // A trailing reference box moves the origin and shrinks the basis.
  let ref = 'border-box';
  const refMatch = /\s(border-box|padding-box|content-box|margin-box|fill-box|stroke-box|view-box)$/.exec(v);
  if (refMatch) { ref = refMatch[1]; v = v.slice(0, refMatch.index).trim(); }
  let ox = 0; let oy = 0; let rw = w; let rh = h;
  if (ref === 'padding-box') { ox = bl; oy = bt; rw = w - bl - br; rh = h - bt - bb; }
  if (ref === 'content-box') { ox = bl + pl; oy = bt + pt; rw = w - bl - br - pl - pr; rh = h - bt - bb - pt - pb; }
  const fn = /^([a-z-]+)\((.*)\)$/s.exec(v);
  if (!fn) return { unsupported: `clip-path "${value}" is not a shape this converts` };
  const [, name, args] = fn;

  if (name === 'inset') {
    const [edges, round] = args.split(/\sround\s/);
    const parts = splitTop(edges, ' ');
    const top = len(parts[0], rh);
    const right = len(parts[1] ?? parts[0], rw);
    const bottom = len(parts[2] ?? parts[0], rh);
    const left = len(parts[3] ?? parts[1] ?? parts[0], rw);
    if ([top, right, bottom, left].some((x) => x === null)) return { unsupported: `clip-path "${value}" uses units this does not resolve` };
    let radius = 0;
    let note = null;
    if (round) {
      const radii = splitTop(round.replace('/', ' '), ' ').map((r) => len(r, Math.min(rw, rh)));
      radius = radii[0] || 0;
      if (radii.some((r) => r !== null && Math.abs(r - radius) > 0.01)) note = 'corners with different radii use the first radius';
    }
    return { shape: 'inset', note, values: { left: ox + left, top: oy + top, right: ox + rw - right, bottom: oy + rh - bottom, radius } };
  }

  if (name === 'circle' || name === 'ellipse') {
    const [radiusPart, atPart = ''] = args.split(/\bat\b/);
    const radii = splitTop(radiusPart.trim(), ' ');
    const [cx, cy] = position(splitTop(atPart.trim(), ' '), rw, rh);
    if (cx === null || cy === null) return { unsupported: `clip-path "${value}" uses a position this does not resolve` };
    const side = (axis, kind) => {
      const near = axis === 'x' ? Math.min(cx, rw - cx) : Math.min(cy, rh - cy);
      const far = axis === 'x' ? Math.max(cx, rw - cx) : Math.max(cy, rh - cy);
      return kind === 'farthest-side' ? far : near;
    };
    let rx; let ry;
    if (name === 'circle') {
      const r = radii[0] || 'closest-side';
      if (r === 'closest-side' || r === 'farthest-side') {
        rx = Math.min(side('x', r), side('y', r));
        if (r === 'farthest-side') rx = Math.max(side('x', r), side('y', r));
      } else {
        // A percentage radius resolves against the normalised diagonal.
        rx = /%$/.test(r) ? (parseFloat(r) / 100) * Math.sqrt((rw * rw + rh * rh) / 2) : len(r, rw);
      }
      ry = rx;
    } else {
      const a = radii[0] || 'closest-side';
      const b = radii[1] || 'closest-side';
      rx = a === 'closest-side' || a === 'farthest-side' ? side('x', a) : len(a, rw);
      ry = b === 'closest-side' || b === 'farthest-side' ? side('y', b) : len(b, rh);
    }
    if (rx === null || ry === null) return { unsupported: `clip-path "${value}" uses a radius this does not resolve` };
    return { shape: 'ellipse', values: { centerX: ox + cx, centerY: oy + cy, radiusX: rx, radiusY: ry } };
  }

  if (name === 'polygon') {
    let list = args.trim();
    let note = null;
    if (/^(evenodd|nonzero)\s*,/.test(list)) {
      if (/^evenodd/.test(list)) note = 'even-odd fill is drawn as non-zero';
      list = list.replace(/^(evenodd|nonzero)\s*,/, '');
    }
    const points = splitTop(list, ',').map((p) => splitTop(p, ' '));
    const values = {};
    for (let i = 0; i < points.length; i += 1) {
      const x = len(points[i][0], rw);
      const y = len(points[i][1], rh);
      if (x === null || y === null) return { unsupported: `clip-path "${value}" uses units this does not resolve` };
      values[`point${i + 1}X`] = ox + x;
      values[`point${i + 1}Y`] = oy + y;
    }
    return { shape: 'polygon', note, count: points.length, values };
  }

  return { unsupported: `clip-path ${name}() is not converted yet` };
}

const KAPPA = 0.5522847498307936;

/** The clip as a closed AE path in the clipper's layer space. */
export function pathFor(shape, v, map = { off: [0, 0], scale: [1, 1] }) {
  const L = (x, y) => [(x - map.off[0]) / map.scale[0], (y - map.off[1]) / map.scale[1]];
  const T = (dx, dy) => [dx / map.scale[0], dy / map.scale[1]];
  const Z = [0, 0];
  let vertices; let inT; let outT;
  if (shape === 'inset') {
    const [l, t, r, b] = v;
    const k = Math.max(0, Math.min(v[4] || 0, (r - l) / 2, (b - t) / 2));
    if (k < 0.01) {
      vertices = [L(l, t), L(r, t), L(r, b), L(l, b)];
      inT = vertices.map(() => Z); outT = vertices.map(() => Z);
    } else {
      const q = k * KAPPA;
      vertices = [L(l + k, t), L(r - k, t), L(r, t + k), L(r, b - k), L(r - k, b), L(l + k, b), L(l, b - k), L(l, t + k)];
      inT = [T(-q, 0), Z, T(0, -q), Z, T(q, 0), Z, T(0, q), Z];
      outT = [Z, T(q, 0), Z, T(0, q), Z, T(-q, 0), Z, T(0, -q)];
    }
  } else if (shape === 'ellipse') {
    const [cx, cy, rx, ry] = v;
    const qx = rx * KAPPA; const qy = ry * KAPPA;
    vertices = [L(cx, cy - ry), L(cx + rx, cy), L(cx, cy + ry), L(cx - rx, cy)];
    inT = [T(-qx, 0), T(0, -qy), T(qx, 0), T(0, qy)];
    outT = [T(qx, 0), T(0, qy), T(-qx, 0), T(0, -qy)];
  } else {
    vertices = [];
    for (let i = 0; i < v.length; i += 2) vertices.push(L(v[i], v[i + 1]));
    inT = vertices.map(() => Z); outT = vertices.map(() => Z);
  }
  return { vertices, inTangents: inT, outTangents: outT, closed: true };
}

const LABEL = {
  left: 'Clip Left', top: 'Clip Top', right: 'Clip Right', bottom: 'Clip Bottom', radius: 'Clip Radius',
  centerX: 'Clip Center X', centerY: 'Clip Center Y', radiusX: 'Clip Radius X', radiusY: 'Clip Radius Y',
};
export function sliderName(key) {
  if (LABEL[key]) return LABEL[key];
  const m = /^point(\d+)([XY])$/.exec(key);
  return m ? `Clip Point ${m[1]} ${m[2]}` : `Clip ${key}`;
}

/** How a point in the clipper's border box maps into its AE layer space. */
function boxToLayer(layer, entry) {
  if (layer.kind === 'text' && entry.baseline) return { off: entry.baseline.slice(0, 2), scale: [1, 1] };
  if (layer.kind === 'image' && layer.image) {
    const fit = computeFit({
      naturalW: layer.image.natural[0], naturalH: layer.image.natural[1],
      boxW: entry.box[2], boxH: entry.box[3], mode: layer.image.objectFit || 'fill',
    });
    return { off: fit.offset, scale: fit.scale };
  }
  // An SVG shape's layer space is its user space (see svgUserFrame): a box
  // point b sits at (box.xy + b - origin) / unit in layer units.
  if (layer.kind === 'path') {
    const user = svgUserFrame(entry);
    if (user) return { off: [user.origin[0] - entry.box[0], user.origin[1] - entry.box[1]], scale: user.scale };
  }
  return { off: [0, 0], scale: [1, 1] };
}

/**
 * Find every element with a clip-path and attach mask specs to its layer and
 * to the painting layers beneath it. Mutates the comp's layers; records what
 * it did, and anything it could not do, in the report.
 */
export function applyClipPaths({ comps, analyses, frames, at, report }) {
  const names = new Map();
  for (const c of comps) for (const l of c.layers) names.set(l.name, (names.get(l.name) || 0) + 1);

  for (const analysis of analyses) {
    const id = analysis.node.id;
    const series = frames.map((f) => ({ t: f.time, entry: at(f, id) }));
    const clipped = series.filter((s) => s.entry && s.entry.present && s.entry.style && s.entry.style.clipPath && s.entry.style.clipPath !== 'none');
    if (!clipped.length) continue;
    const comp = comps.find((c) => c.layers.some((l) => l.id === id));
    const layer = comp && comp.layers.find((l) => l.id === id);
    const say = (note) => (report.approximations || (report.approximations = [])).push({ id, name: analysis.node.name, note });
    if (!layer) { say('clip-path on an element that has no layer of its own; not converted'); continue; }
    if (!CLIPPER_KINDS.has(layer.kind)) { say(`clip-path on a ${layer.kind} layer is not converted`); continue; }

    const parsed = series.map((s) => {
      if (!s.entry || !s.entry.present) return null;
      const st = s.entry.style || {};
      const box = { size: [s.entry.box[2], s.entry.box[3]], border: st.borderWidth, padding: st.padding };
      const p = parseClipPath(st.clipPath, box);
      // `none` mid-animation means unclipped: the whole border box.
      return p || { shape: 'none', values: { left: 0, top: 0, right: box.size[0], bottom: box.size[1], radius: 0 } };
    });
    const real = parsed.filter((p) => p && p.shape !== 'none');
    const unsupported = real.find((p) => p.unsupported);
    if (unsupported) { say(unsupported.unsupported); continue; }
    const shape = real[0].shape;
    if (real.some((p) => p.shape !== shape || (shape === 'polygon' && p.count !== real[0].count))) {
      say('clip-path changes shape type during the animation; not converted');
      continue;
    }
    if (parsed.some((p) => p && p.shape === 'none') && shape !== 'inset') {
      say('clip-path switches between none and a shape; frames without a clip use the nearest shape');
    }
    const keys = Object.keys(real[0].values);
    const tracks = {};
    let animated = false;
    for (const key of keys) {
      let last = real[0].values[key];
      const samples = series.map((s, i) => {
        const p = parsed[i];
        if (p && p.values && p.values[key] !== undefined && p.shape !== 'none') last = p.values[key];
        else if (p && p.shape === 'none' && shape === 'inset') last = p.values[key];
        return { t: s.t, v: last };
      });
      const kind = key === 'radius' || key.startsWith('radius') ? 'size' : 'position';
      tracks[key] = buildScalarTrack(samples, kind);
      if (tracks[key].keys) animated = true;
    }
    const note = real.find((p) => p.note);
    if (note) say(`clip-path: ${note.note}`);

    // The clipper's name is how members find it, so it has to be unique.
    if (names.get(layer.name) > 1) {
      let n = 2;
      while (names.has(`${layer.name} ${n}`)) n += 1;
      names.set(`${layer.name} ${n}`, 1);
      layer.name = `${layer.name} ${n}`;
    }
    const map = boxToLayer(layer, clipped[0].entry);
    const statics = keys.map((k) => (tracks[k].keys ? null : tracks[k].static));
    const spec = { shape, keys, tracks, statics, animated, clipper: layer.name, off: map.off, scale: map.scale };
    if (!animated && layer.kind !== 'null') spec.path = pathFor(shape, statics, map);
    // An element's own paint is clipped too, except a null, which paints nothing
    // but still carries the sliders.
    layer.clip = { ...spec, role: layer.kind === 'null' ? 'host' : 'self' };

    const members = collectSubtree(comp.layers, id);
    members.delete(id);
    let count = 0;
    for (const member of comp.layers) {
      if (!members.has(member.id) || !PAINTS.has(member.kind)) continue;
      member.clipBy = { ...spec, tracks: undefined, role: 'member' };
      count += 1;
    }
    (report.clipPaths || (report.clipPaths = [])).push({ id, name: layer.name, shape, animated, members: count });
  }
}
