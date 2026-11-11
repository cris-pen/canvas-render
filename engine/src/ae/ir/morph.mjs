// SVG path morphs: a `d` (or cx/cy/points) that changes over time becomes
// keyframes on the AE Path property.
//
// After Effects interpolates a path between two keyframes vertex by vertex,
// moving every vertex and every tangent handle in a straight line. So a morph
// can only be keyed directly when every frame's path has the same structure
// (same vertex count, same open/closed state); the keys themselves are chosen
// greedily, each one pushed as far forward as linear interpolation stays within
// tolerance of every frame it skips. A wave that scrolls its phase needs a key
// every couple of frames; a shape that snaps between two states needs two.
import { pathToShape } from '../emit/jsx.mjs';

const round = (v) => Math.round(v * 100) / 100;
const count = (shape) => (shape ? shape.reduce((n, c) => n + c.vertices.length, 0) : 0);

/** The frame's outline as a list of contours, or null when it has none. */
function shapeAt(entry, tag) {
  if (!entry || !entry.present) return undefined; // not on the page: no say
  const { contours } = pathToShape({ d: entry.d || null, geom: entry.geom || null, tag });
  return contours.length ? contours : null;
}

function sameStructure(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((c, k) => c.vertices.length === b[k].vertices.length && c.closed === b[k].closed);
}

function maxDelta(a, b) {
  let worst = 0;
  a.forEach((ca, k) => {
    const cb = b[k];
    for (let v = 0; v < ca.vertices.length; v += 1) {
      for (let d = 0; d < 2; d += 1) {
        worst = Math.max(worst,
          Math.abs(ca.vertices[v][d] - cb.vertices[v][d]),
          Math.abs(ca.inTangents[v][d] - cb.inTangents[v][d]),
          Math.abs(ca.outTangents[v][d] - cb.outTangents[v][d]));
      }
    }
  });
  return worst;
}

/** Error of linearly interpolating a->b at fraction f, against `want`. */
function lerpError(a, b, f, want) {
  let worst = 0;
  a.forEach((ca, k) => {
    const cb = b[k];
    const cw = want[k];
    for (let v = 0; v < ca.vertices.length; v += 1) {
      for (let d = 0; d < 2; d += 1) {
        const vx = ca.vertices[v][d] + (cb.vertices[v][d] - ca.vertices[v][d]) * f;
        const ix = ca.inTangents[v][d] + (cb.inTangents[v][d] - ca.inTangents[v][d]) * f;
        const ox = ca.outTangents[v][d] + (cb.outTangents[v][d] - ca.outTangents[v][d]) * f;
        // Tangent handles are checked where they land, not as offsets: a handle
        // that is off by a pixel bends the curve by up to that much.
        worst = Math.max(worst,
          Math.abs(vx - cw.vertices[v][d]),
          Math.abs(vx + ix - (cw.vertices[v][d] + cw.inTangents[v][d])),
          Math.abs(vx + ox - (cw.vertices[v][d] + cw.outTangents[v][d])));
      }
    }
  });
  return worst;
}

/**
 * Key a path's morph. `tolerance` is in layer units.
 * Returns null when the path never changes, `{ mismatch }` when frames differ in
 * structure (point count, number of subpaths, or an outline that comes and
 * goes), otherwise `{ keys, straight, closed }`.
 */
export function keyPathMorph(analysis, tolerance = 0.25, tag = null) {
  const samples = [];
  for (const p of analysis.perFrame) {
    const s = shapeAt(p.entry, tag);
    if (s !== undefined) samples.push({ t: p.time, s });
  }
  const drawn = samples.filter((x) => x.s);
  if (!drawn.length) return null;
  const first = drawn[0].s;
  if (samples.some((x) => !sameStructure(x.s, first))) {
    // Report the first change in time order: "from 0 to 2 points at 0.10s".
    const odd = samples.find((x, k) => k > 0 && !sameStructure(x.s, samples[k - 1].s));
    const before = samples[samples.indexOf(odd) - 1];
    return { mismatch: { time: odd.t, vertices: [count(before.s), count(odd.s)] } };
  }
  if (samples.length < 2 || samples.every((x) => maxDelta(x.s, first) < 1e-6)) return null;

  const fits = (i, j) => {
    const a = samples[i];
    const b = samples[j];
    const span = b.t - a.t;
    for (let f = i + 1; f < j; f += 1) {
      if (lerpError(a.s, b.s, (samples[f].t - a.t) / span, samples[f].s) > tolerance) return false;
    }
    return true;
  };

  const picked = [0];
  let i = 0;
  while (i < samples.length - 1) {
    let j = i + 1;
    while (j + 1 < samples.length && fits(i, j + 1)) j += 1;
    picked.push(j);
    i = j;
  }

  const zero = (h) => h[0] === 0 && h[1] === 0;
  const straight = samples.every((x) => x.s.every((c) => c.inTangents.every(zero) && c.outTangents.every(zero)));
  const r2 = (list) => list.map((v) => [round(v[0]), round(v[1])]);
  const keys = picked.map((k) => {
    const { t, s } = samples[k];
    return {
      t,
      contours: s.map((c) => (straight ? { vertices: r2(c.vertices) } : { vertices: r2(c.vertices), inTangents: r2(c.inTangents), outTangents: r2(c.outTangents) })),
    };
  });
  return { keys, straight, closed: first.map((c) => c.closed), frames: samples.length };
}
