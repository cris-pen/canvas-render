// A "track" is one animatable After Effects property over time.
//
// Every track arrives here as one sample per captured frame and leaves as
// either a constant (no keyframes at all) or a short list of keyframes carrying
// native AE eases. The reduction is what makes the imported comp editable: a
// 3-second 60fps capture is 181 samples, and a designer cannot retime a wall of
// 181 keyframes -- but they can drag four.
import { fitTrack, fitSegment, segmentHandles, paramForTime, bezierValueAt } from '../math/curveFit.mjs';
import { handlesToAeEase } from '../math/easing.mjs';
import { aeEaseToHandles } from '../math/aeEase.mjs';

// Per-property tolerances, in that property's own units. These are the visible
// error budget: a quarter pixel of position, a fifth of a percent of scale (on
// a 1000px layer that is 2px), a tenth of a degree of rotation.
export const TOLERANCE = {
  position: 0.25,
  anchorPoint: 0.25,
  scale: 0.2,
  rotation: 0.1,
  orientation: 0.1,
  opacity: 0.4,
  size: 0.25,
  roundness: 0.25,
  color: 1.0,          // 0..255 channel units
  length: 0.25,
  number: 0.005,
  angle: 0.1,
  default: 0.25,
};

/**
 * Build one dimension of a track.
 * `samples` is [{ t, v }]; returns { static: value } or { keys: [...] }.
 */
export function buildScalarTrack(samples, kind = 'default', options = {}) {
  const tolerance = options.tolerance ?? TOLERANCE[kind] ?? TOLERANCE.default;
  const fit = fitTrack(samples, {
    tolerance,
    jumpThreshold: options.jumpThreshold ?? Infinity,
    maxKeys: options.maxKeys ?? 2048,
  });
  if (fit.static || fit.keys.length <= 1) {
    return { static: fit.keys.length ? fit.keys[0].v : 0, maxError: fit.maxError };
  }

  const keys = fit.keys.map((key, i) => {
    const prev = fit.keys[i - 1];
    const next = fit.keys[i + 1];
    const out = {};
    if (next && !key.hold) {
      const dt = next.t - key.t;
      const ease = handlesToAeEase(segmentHandles(key, next), key.v, next.v, dt);
      out.outEase = ease.out;
      // The incoming ease of the NEXT key belongs to that key, and is written
      // when we get there -- AE stores in/out on the keyframes, not the segment.
    }
    if (prev && !prev.hold) {
      const dt = key.t - prev.t;
      const ease = handlesToAeEase(segmentHandles(prev, key), prev.v, key.v, dt);
      out.inEase = ease.in;
    }
    return {
      t: key.t,
      v: key.v,
      hold: Boolean(key.hold),
      inEase: out.inEase ?? { speed: 0, influence: 16.666667 },
      outEase: out.outEase ?? { speed: 0, influence: 16.666667 },
    };
  });

  return { keys, maxError: fit.maxError, sampleCount: fit.sampleCount };
}

/**
 * Build a multi-dimensional track (position, scale, colour...). Each dimension
 * is fitted independently, then the knot times are UNIONISED so the emitted
 * property has one keyframe list -- After Effects has no per-dimension keyframe
 * times unless dimensions are separated, and separating position by default
 * would hand the user a comp that does not look like one a human made.
 */
export function buildVectorTrack(dimensionSamples, kind = 'default', options = {}) {
  const dims = dimensionSamples.length;
  const perDim = dimensionSamples.map((s) => buildScalarTrack(s, kind, options));

  if (perDim.every((d) => d.keys === undefined)) {
    return { static: perDim.map((d) => d.static), dims, maxError: Math.max(...perDim.map((d) => d.maxError || 0)) };
  }

  const times = new Set();
  const holdTimes = new Set();
  for (const d of perDim) {
    if (!d.keys) continue;
    for (const k of d.keys) {
      times.add(round6(k.t));
      if (k.hold) holdTimes.add(round6(k.t));
    }
  }
  const first = dimensionSamples[0];
  times.add(round6(first[0].t));
  times.add(round6(first[first.length - 1].t));
  const ordered = [...times].sort((a, b) => a - b);

  const refit = dimensionSamples.map((samples) => resampleToKnots(samples, ordered, holdTimes));

  const keys = ordered.map((t, i) => ({
    t,
    v: refit.map((d) => d.values[i]),
    hold: refit.some((d) => d.holds[i]),
    inEase: refit.map((d) => d.inEases[i] ?? { speed: 0, influence: 16.666667 }),
    outEase: refit.map((d) => d.outEases[i] ?? { speed: 0, influence: 16.666667 }),
  }));

  const track = { keys, dims };
  // Measure the error of what we are ACTUALLY emitting, across every original
  // sample, so the report cannot claim a fidelity the comp will not deliver.
  let maxError = 0;
  for (let dim = 0; dim < dims; dim += 1) {
    for (const sample of dimensionSamples[dim]) {
      const got = evaluate(track, sample.t);
      maxError = Math.max(maxError, Math.abs(got[dim] - sample.v));
    }
  }
  track.maxError = maxError;
  return track;
}

/**
 * Fit a sample series to a FIXED set of knot times: exact values at the knots,
 * least-squares handles between them. Used to reconcile dimensions that each
 * wanted different knots.
 *
 * This calls fitSegment directly rather than fitTrack, because fitTrack's job
 * is to CHOOSE knots and it short-circuits to "this never moves" when handed a
 * permissive tolerance -- which would silently turn every segment linear.
 */
function resampleToKnots(samples, knotTimes, holdTimes) {
  const values = knotTimes.map((t) => sampleAt(samples, t));
  const inEases = new Array(knotTimes.length).fill(null);
  const outEases = new Array(knotTimes.length).fill(null);
  const holds = knotTimes.map((t) => holdTimes.has(round6(t)));

  for (let i = 0; i < knotTimes.length - 1; i += 1) {
    const lo = knotTimes[i];
    const hi = knotTimes[i + 1];
    const dt = hi - lo;
    if (holds[i] || dt <= 0) {
      outEases[i] = { speed: 0, influence: 16.666667 };
      inEases[i + 1] = { speed: 0, influence: 16.666667 };
      continue;
    }
    // Endpoints are pinned to the knot values so neighbouring segments join
    // exactly; only the interior samples drive the handle solve.
    const interior = samples.filter((s) => s.t > lo + 1e-9 && s.t < hi - 1e-9);
    const points = [{ t: lo, v: values[i] }, ...interior, { t: hi, v: values[i + 1] }];
    const fit = fitSegment(points, 0, points.length - 1);
    const ease = handlesToAeEase(
      { x1: fit.x1, V1: fit.V1, x2: fit.x2, V2: fit.V2 },
      values[i], values[i + 1], dt,
    );
    outEases[i] = ease.out;
    inEases[i + 1] = ease.in;
  }
  return { values, inEases, outEases, holds };
}

function sampleAt(samples, t) {
  if (!samples.length) return 0;
  if (t <= samples[0].t) return samples[0].v;
  const last = samples[samples.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < samples.length - 1 && samples[i + 1].t < t) i += 1;
  const a = samples[i];
  const b = samples[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  return a.v + (b.v - a.v) * ((t - a.t) / span);
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }

/** Is this track worth emitting at all? */
export function isStatic(track) {
  return track && track.keys === undefined;
}

/**
 * Reconstruct a track's value at time t by replaying the AE eases we are about
 * to write -- NOT the fitter's internal handles. That distinction is the point:
 * this is how we prove the numbers landing in After Effects describe the motion
 * we captured, rather than proving the fitter agrees with itself.
 */
export function evaluate(track, t) {
  if (!track) return null;
  if (track.keys === undefined) return track.static;
  const keys = track.keys;
  const vector = Array.isArray(keys[0].v);
  const at = (dim) => {
    const val = (k) => (vector ? k.v[dim] : k.v);
    if (t <= keys[0].t) return val(keys[0]);
    const last = keys[keys.length - 1];
    if (t >= last.t) return val(last);
    let i = 0;
    while (i < keys.length - 1 && t >= keys[i + 1].t) i += 1;
    const A = keys[i];
    const B = keys[i + 1];
    if (A.hold) return val(A);
    const dt = B.t - A.t;
    if (dt <= 0) return val(B);
    const outEase = vector ? A.outEase[dim] : A.outEase;
    const inEase = vector ? B.inEase[dim] : B.inEase;
    const h = aeEaseToHandles(outEase, inEase, val(A), val(B), dt);
    const u = paramForTime(h.x1, h.x2, (t - A.t) / dt);
    return bezierValueAt(u, val(A), h.V1, h.V2, val(B));
  };
  return vector ? keys[0].v.map((_, dim) => at(dim)) : at(0);
}
