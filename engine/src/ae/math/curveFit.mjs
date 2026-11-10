// Densely-sampled property track -> sparse, editable keyframes.
//
// Tier B of the fidelity ladder. Anything we could not resolve analytically
// (spring physics, GSAP, rAF loops, scroll-linked motion) arrives here as one
// value per frame. Handing After Effects a keyframe per frame would be faithful
// but useless -- you cannot retime or restyle a solid wall of keys. So we fit
// cubic beziers and keep only the knots that are load-bearing.
//
// The fit is specialised for a FUNCTION GRAPH (value as a function of time,
// time strictly increasing) rather than a general parametric curve, and it
// solves for exactly the four numbers an AE keyframe pair can store: the two
// handle reaches x1, x2 (normalised times, which become influence) and the two
// handle values V1, V2 (absolute, which become speed).
//
//     B(u) = (1-u)^3 P0 + 3(1-u)^2 u P1 + 3(1-u) u^2 P2 + u^3 P3
//     P1 = (t0 + x1*dt, V1)      P2 = (t0 + x2*dt, V2)
//
// Constraining x1, x2 to [0,1] makes time strictly monotone inside a segment --
// the failure mode that makes naive curve fitters emit AE curves that run
// backwards. V1 and V2 are left FREE (not pinned to an estimated tangent
// direction), which is what lets a single segment reproduce a source that
// really is one cubic: an `ease-in-out` transition fits with two keyframes and
// zero error rather than a wall of them.
//
// The solve is nested, because the two parameter pairs enter differently:
//   * V1, V2 are LINEAR in the residual, so an exact 2x2 least-squares solve.
//   * x1, x2 are non-linear (they warp time, changing which u each sample maps
//     to), so a bounded pattern search wraps the linear solve.
// Roughly 60 objective evaluations per segment; the objective is L-infinity
// error, matching the tolerance contract exactly rather than approximating it
// with RMS.

const EPS = 1e-12;
const MIN_X = 0.001;   // AE's minimum influence is 0.1%
const MAX_X = 0.999;

/** Newton solve for the bezier parameter u whose normalised time is `tau`. */
export function paramForTime(x1, x2, tau) {
  if (tau <= 0) return 0;
  if (tau >= 1) return 1;
  let u = tau;
  for (let i = 0; i < 16; i += 1) {
    const mu = 1 - u;
    const x = 3 * mu * mu * u * x1 + 3 * mu * u * u * x2 + u * u * u;
    const err = x - tau;
    if (Math.abs(err) < 1e-12) return u;
    const dx = 3 * mu * mu * x1 + 6 * mu * u * (x2 - x1) + 3 * u * u * (1 - x2);
    if (Math.abs(dx) < 1e-12) break;
    let next = u - err / dx;
    if (next < 0) next = 0;
    if (next > 1) next = 1;
    if (Math.abs(next - u) < 1e-14) return next;
    u = next;
  }
  // Bisection fallback for the rare Newton stall.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    const mu = 1 - mid;
    const x = 3 * mu * mu * mid * x1 + 3 * mu * mid * mid * x2 + mid * mid * mid;
    if (x < tau) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Given handle times, solve exactly for the handle values that minimise squared
 * error, then report the resulting L-infinity error. This is the inner solve.
 */
function solveHandles(samples, lo, hi, x1, x2) {
  const t0 = samples[lo].t;
  const t1 = samples[hi].t;
  const v0 = samples[lo].v;
  const v1 = samples[hi].v;
  const dt = t1 - t0;

  let sAA = 0; let sAB = 0; let sBB = 0; let sAr = 0; let sBr = 0;
  const us = new Array(hi - lo - 1);
  for (let i = lo + 1; i < hi; i += 1) {
    const tau = dt > EPS ? (samples[i].t - t0) / dt : 0;
    const u = paramForTime(x1, x2, tau);
    us[i - lo - 1] = u;
    const mu = 1 - u;
    const A = 3 * mu * mu * u;
    const B = 3 * mu * u * u;
    const C = mu * mu * mu * v0 + u * u * u * v1;
    const r = samples[i].v - C;
    sAA += A * A; sAB += A * B; sBB += B * B; sAr += A * r; sBr += B * r;
  }

  let V1;
  let V2;
  const det = sAA * sBB - sAB * sAB;
  if (Math.abs(det) > EPS * Math.max(1, sAA * sBB)) {
    V1 = (sAr * sBB - sAB * sBr) / det;
    V2 = (sAA * sBr - sAB * sAr) / det;
  } else {
    // Too few interior samples (or a degenerate configuration) to pin both
    // handles: fall back to the straight-line handles, which are always valid.
    V1 = v0 + (v1 - v0) * x1;
    V2 = v0 + (v1 - v0) * x2;
  }

  let error = 0;
  let worstIndex = lo + 1;
  for (let i = lo + 1; i < hi; i += 1) {
    const u = us[i - lo - 1];
    const mu = 1 - u;
    const value = mu * mu * mu * v0 + 3 * mu * mu * u * V1 + 3 * mu * u * u * V2 + u * u * u * v1;
    const diff = Math.abs(value - samples[i].v);
    if (diff > error) { error = diff; worstIndex = i; }
  }
  return { x1, x2, V1, V2, error, worstIndex };
}

/**
 * Fit one cubic segment across samples[lo..hi]. Bounded pattern search over the
 * two handle times, with the exact linear solve for the handle values inside.
 */
export function fitSegment(samples, lo, hi) {
  if (hi - lo < 2) {
    // Two adjacent samples: the segment is exactly a straight line.
    const v0 = samples[lo].v;
    const v1 = samples[hi].v;
    return {
      x1: 1 / 3, x2: 2 / 3,
      V1: v0 + (v1 - v0) / 3,
      V2: v0 + (v1 - v0) * 2 / 3,
      error: 0, worstIndex: lo,
    };
  }

  let best = solveHandles(samples, lo, hi, 1 / 3, 2 / 3);
  let step = 0.25;
  while (step > 1e-4) {
    let improved = false;
    for (const [dx1, dx2] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step], [step, -step], [-step, step]]) {
      const nx1 = Math.min(MAX_X, Math.max(MIN_X, best.x1 + dx1));
      const nx2 = Math.min(MAX_X, Math.max(MIN_X, best.x2 + dx2));
      if (nx1 === best.x1 && nx2 === best.x2) continue;
      const candidate = solveHandles(samples, lo, hi, nx1, nx2);
      if (candidate.error < best.error - 1e-12) { best = candidate; improved = true; }
    }
    if (!improved) step /= 2;
  }
  return best;
}

/**
 * Split samples into runs separated by DISCONTINUITIES -- a jump large enough,
 * over a single frame, that it is a cut rather than motion (a `display` toggle,
 * an animation restarting, a steps() stop). Each boundary becomes a hold
 * keyframe rather than a ramp.
 */
export function findDiscontinuities(samples, jumpThreshold) {
  const cuts = [];
  for (let i = 1; i < samples.length; i += 1) {
    if (Math.abs(samples[i].v - samples[i - 1].v) >= jumpThreshold) cuts.push(i);
  }
  return cuts;
}

/**
 * Fit a whole track. Returns { keys, maxError, static } where each key is
 *   { t, v, hold, outHandle: {x, V}, inHandle: {x, V} }
 * in real units and seconds -- ready for easing.handlesToAeEase().
 *
 * `tolerance` is in value units (px, degrees, percent) and is the contract: no
 * sample deviates from the emitted curve by more than this.
 */
export function fitTrack(samples, options = {}) {
  const tolerance = options.tolerance ?? 0.25;
  const maxKeys = options.maxKeys ?? 4096;
  const jumpThreshold = options.jumpThreshold ?? Infinity;
  const clean = samples.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.v));
  if (clean.length === 0) return { keys: [], maxError: 0, static: true };
  if (clean.length === 1) return { keys: [{ t: clean[0].t, v: clean[0].v }], maxError: 0, static: true };

  let lo = clean[0].v;
  let hi = clean[0].v;
  for (const s of clean) { if (s.v < lo) lo = s.v; if (s.v > hi) hi = s.v; }
  if (hi - lo <= tolerance) {
    // Never moves (within tolerance): no keyframes at all, just a constant.
    return { keys: [{ t: clean[0].t, v: (hi + lo) / 2 }], maxError: (hi - lo) / 2, static: true };
  }

  const cuts = Number.isFinite(jumpThreshold) ? findDiscontinuities(clean, jumpThreshold) : [];
  const cutSet = new Set(cuts);
  const runs = [];
  let runStart = 0;
  for (const cut of cuts) { runs.push([runStart, cut - 1]); runStart = cut; }
  runs.push([runStart, clean.length - 1]);

  const knots = new Set();
  for (const [a, b] of runs) { knots.add(a); knots.add(b); }

  for (const [runLo, runHi] of runs) {
    if (runHi <= runLo) continue;
    const stack = [[runLo, runHi]];
    while (stack.length) {
      const [segLo, segHi] = stack.pop();
      if (segHi - segLo < 2) continue;
      if (knots.size > maxKeys) break;
      const fit = fitSegment(clean, segLo, segHi);
      if (fit.error <= tolerance) continue;
      const split = Math.min(segHi - 1, Math.max(segLo + 1, fit.worstIndex));
      if (knots.has(split)) continue;
      knots.add(split);
      stack.push([segLo, split], [split, segHi]);
    }
  }

  const ordered = [...knots].sort((x, y) => x - y);
  const segments = [];
  let maxError = 0;
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const segLo = ordered[i];
    const segHi = ordered[i + 1];
    if (cutSet.has(segHi) && segHi === segLo + 1) {
      segments.push({ lo: segLo, hi: segHi, hold: true, error: 0 });
      continue;
    }
    const fit = fitSegment(clean, segLo, segHi);
    maxError = Math.max(maxError, fit.error);
    segments.push({ lo: segLo, hi: segHi, hold: false, ...fit });
  }

  const keys = ordered.map((index, i) => {
    const before = segments[i - 1];
    const after = segments[i];
    return {
      t: clean[index].t,
      v: clean[index].v,
      hold: Boolean(after && after.hold),
      inHandle: before && !before.hold ? { x: before.x2, V: before.V2 } : null,
      outHandle: after && !after.hold ? { x: after.x1, V: after.V1 } : null,
    };
  });

  return { keys, maxError, static: false, segments, sampleCount: clean.length };
}

/** The handle tuple for the segment between two fitted keys. */
export function segmentHandles(keyA, keyB) {
  return {
    x1: keyA.outHandle ? keyA.outHandle.x : 1 / 3,
    V1: keyA.outHandle ? keyA.outHandle.V : keyA.v + (keyB.v - keyA.v) / 3,
    x2: keyB.inHandle ? keyB.inHandle.x : 2 / 3,
    V2: keyB.inHandle ? keyB.inHandle.V : keyA.v + (keyB.v - keyA.v) * 2 / 3,
  };
}

/** Evaluate a fitted track at an arbitrary time; used by the verification pass. */
export function evaluateTrack(keys, t) {
  if (keys.length === 0) return 0;
  if (keys.length === 1 || t <= keys[0].t) return keys[0].v;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
  let i = 0;
  while (i < keys.length - 1 && t >= keys[i + 1].t) i += 1;
  const A = keys[i];
  const B = keys[i + 1];
  if (A.hold) return A.v;
  const dt = B.t - A.t;
  if (dt <= EPS) return B.v;
  const h = segmentHandles(A, B);
  const u = paramForTime(h.x1, h.x2, (t - A.t) / dt);
  const mu = 1 - u;
  return mu * mu * mu * A.v + 3 * mu * mu * u * h.V1 + 3 * mu * u * u * h.V2 + u * u * u * B.v;
}

/** Evaluate a cubic segment given its endpoint values and both handle values. */
export function bezierValueAt(u, v0, V1, V2, v1) {
  const mu = 1 - u;
  return mu * mu * mu * v0 + 3 * mu * mu * u * V1 + 3 * mu * u * u * V2 + u * u * u * v1;
}
