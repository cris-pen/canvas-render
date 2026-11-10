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

function shapeAt(entry) {
  if (!entry || !entry.present) return null;
  if (!entry.d && !entry.geom) return null;
  const s = pathToShape({ d: entry.d || null, geom: entry.geom || null });
  return s && s.vertices && s.vertices.length ? s : null;
}

function sameStructure(a, b) {
  return a.vertices.length === b.vertices.length && a.closed === b.closed;
}

function maxDelta(a, b) {
  let worst = 0;
  for (let v = 0; v < a.vertices.length; v += 1) {
    for (let k = 0; k < 2; k += 1) {
      worst = Math.max(worst,
        Math.abs(a.vertices[v][k] - b.vertices[v][k]),
        Math.abs(a.inTangents[v][k] - b.inTangents[v][k]),
        Math.abs(a.outTangents[v][k] - b.outTangents[v][k]));
    }
  }
  return worst;
}

/** Error of linearly interpolating a->b at fraction f, against `want`. */
function lerpError(a, b, f, want) {
  let worst = 0;
  for (let v = 0; v < a.vertices.length; v += 1) {
    for (let k = 0; k < 2; k += 1) {
      const vx = a.vertices[v][k] + (b.vertices[v][k] - a.vertices[v][k]) * f;
      const ix = a.inTangents[v][k] + (b.inTangents[v][k] - a.inTangents[v][k]) * f;
      const ox = a.outTangents[v][k] + (b.outTangents[v][k] - a.outTangents[v][k]) * f;
      // Tangent handles are checked where they land, not as offsets: a handle
      // that is off by a pixel bends the curve by up to that much.
      worst = Math.max(worst,
        Math.abs(vx - want.vertices[v][k]),
        Math.abs(vx + ix - (want.vertices[v][k] + want.inTangents[v][k])),
        Math.abs(vx + ox - (want.vertices[v][k] + want.outTangents[v][k])));
    }
  }
  return worst;
}

/**
 * Key a path's morph. `tolerance` is in layer units.
 * Returns null when the path never changes, `{ mismatch }` when frames differ in
 * structure (it cannot be keyed as a morph), otherwise `{ keys, straight }`.
 */
export function keyPathMorph(analysis, tolerance = 0.25) {
  const samples = [];
  for (const p of analysis.perFrame) {
    const s = shapeAt(p.entry);
    if (s) samples.push({ t: p.time, s });
  }
  if (samples.length < 2) return null;
  const first = samples[0].s;
  if (samples.every((x) => sameStructure(x.s, first) && maxDelta(x.s, first) < 1e-6)) return null;
  const mismatch = samples.find((x) => !sameStructure(x.s, first));
  if (mismatch) {
    return { mismatch: { time: mismatch.t, vertices: [first.vertices.length, mismatch.s.vertices.length] } };
  }

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

  const straight = samples.every((x) => x.s.inTangents.every((h) => h[0] === 0 && h[1] === 0)
    && x.s.outTangents.every((h) => h[0] === 0 && h[1] === 0));
  const keys = picked.map((k) => {
    const { t, s } = samples[k];
    const key = { t, vertices: s.vertices.map((v) => [round(v[0]), round(v[1])]) };
    if (!straight) {
      key.inTangents = s.inTangents.map((v) => [round(v[0]), round(v[1])]);
      key.outTangents = s.outTangents.map((v) => [round(v[0]), round(v[1])]);
    }
    return key;
  });
  return { keys, straight, closed: first.closed, frames: samples.length };
}
