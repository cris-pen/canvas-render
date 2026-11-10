// CSS timing functions <-> After Effects KeyframeEase.
//
// This conversion is EXACT, not sampled. AE stores each keyframe segment as a
// temporal bezier in (time, value) space. For a segment from key A at (tA, vA)
// to key B at (tB, vB), with dt = tB - tA and dv = vB - vA, AE places:
//
//   outgoing control point of A at
//       ( tA + (influenceOut/100) * dt ,  vA + speedOut * (influenceOut/100) * dt )
//   incoming control point of B at
//       ( tB - (influenceIn/100)  * dt ,  vB - speedIn  * (influenceIn/100)  * dt )
//
// CSS cubic-bezier(x1,y1,x2,y2) places its control points at
//       ( tA + x1*dt , vA + y1*dv )   and   ( tA + x2*dt , vA + y2*dv )
//
// Matching term by term:
//       influenceOut = 100 * x1          speedOut = (y1 / x1)         * (dv/dt)
//       influenceIn  = 100 * (1 - x2)    speedIn  = ((1-y2) / (1-x2)) * (dv/dt)
//
// so a CSS ease becomes an AE ease with zero loss of shape. The only wrinkles are
// the degenerate control points CSS allows and AE does not (see below).

// AE clamps influence to [0.1, 100] percent. A control point sitting exactly on
// its keyframe (x1 === 0, or x2 === 1) is legal in CSS but inexpressible in AE,
// so we approximate it with the minimum influence and the tangent DIRECTION the
// degenerate bezier actually leaves along -- which is the direction toward the
// next non-coincident control point.
export const MIN_INFLUENCE = 0.1;
export const MAX_INFLUENCE = 100;

// A finite stand-in for the infinite slope of a vertical control-point offset
// (e.g. cubic-bezier(0, 1, ...) asks for instantaneous velocity). Expressed as a
// multiple of the segment's average speed so it scales with the property.
const MAX_SLOPE = 1e4;
const EPS = 1e-7;

export const CSS_KEYWORD_BEZIERS = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

export function clampInfluence(v) {
  if (!Number.isFinite(v)) return MIN_INFLUENCE;
  if (v < MIN_INFLUENCE) return MIN_INFLUENCE;
  if (v > MAX_INFLUENCE) return MAX_INFLUENCE;
  return v;
}

// Parse a CSS `animation-timing-function` / `transition-timing-function` value
// into either a cubic-bezier control tuple or a step description. Returns null
// for anything unrecognised so the caller can fall back to sampling.
export function parseTimingFunction(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === 'step-start') return { type: 'steps', count: 1, position: 'start' };
  if (value === 'step-end') return { type: 'steps', count: 1, position: 'end' };
  if (Object.prototype.hasOwnProperty.call(CSS_KEYWORD_BEZIERS, value)) {
    return { type: 'bezier', points: CSS_KEYWORD_BEZIERS[value].slice() };
  }
  const bezier = /^cubic-bezier\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)$/.exec(value);
  if (bezier) {
    const points = bezier.slice(1, 5).map(Number);
    if (points.some((n) => !Number.isFinite(n))) return null;
    // CSS requires the time coordinates in [0,1]; the value coordinates may
    // overshoot (that is how bounce/anticipation eases are written).
    points[0] = Math.min(1, Math.max(0, points[0]));
    points[2] = Math.min(1, Math.max(0, points[2]));
    return { type: 'bezier', points };
  }
  const steps = /^steps\(\s*(\d+)\s*(?:,\s*(jump-start|jump-end|jump-none|jump-both|start|end)\s*)?\)$/.exec(value);
  if (steps) {
    const count = Number(steps[1]);
    if (!Number.isFinite(count) || count < 1) return null;
    return { type: 'steps', count, position: steps[2] || 'end' };
  }
  // `linear(...)` (the CSS linear-easing function) is a polyline; sampling
  // handles it correctly, so report it as unsupported-analytically.
  return null;
}

// Evaluate cubic-bezier(x1,y1,x2,y2) at a normalised time in [0,1].
// Newton-Raphson with a bisection fallback, which is what browsers do.
export function cubicBezierAt(x1, y1, x2, y2, t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (u) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u) => ((ay * u + by) * u + cy) * u;
  const slopeX = (u) => (3 * ax * u + 2 * bx) * u + cx;

  let u = t;
  for (let i = 0; i < 8; i += 1) {
    const x = sampleX(u) - t;
    if (Math.abs(x) < 1e-9) return sampleY(u);
    const d = slopeX(u);
    if (Math.abs(d) < 1e-9) break;
    u -= x / d;
  }
  let lo = 0;
  let hi = 1;
  u = t;
  for (let i = 0; i < 60; i += 1) {
    const x = sampleX(u);
    if (Math.abs(x - t) < 1e-9) break;
    if (x < t) lo = u; else hi = u;
    u = (lo + hi) / 2;
  }
  return sampleY(u);
}

// The tangent slope (dy/dx in normalised space) the curve actually leaves the
// start point along. Normally y1/x1, but when P1 coincides with the origin the
// curve leaves toward P2 instead, and when both coincide it is a straight line.
function startSlope(x1, y1, x2, y2) {
  if (x1 > EPS) return y1 / x1;
  if (Math.abs(y1) > EPS) return y1 > 0 ? MAX_SLOPE : -MAX_SLOPE; // vertical departure
  if (x2 > EPS) return y2 / x2;
  if (Math.abs(y2) > EPS) return y2 > 0 ? MAX_SLOPE : -MAX_SLOPE;
  return 1;
}

function endSlope(x1, y1, x2, y2) {
  const dx = 1 - x2;
  const dy = 1 - y2;
  if (dx > EPS) return dy / dx;
  if (Math.abs(dy) > EPS) return dy > 0 ? MAX_SLOPE : -MAX_SLOPE;
  const dx1 = 1 - x1;
  const dy1 = 1 - y1;
  if (dx1 > EPS) return dy1 / dx1;
  if (Math.abs(dy1) > EPS) return dy1 > 0 ? MAX_SLOPE : -MAX_SLOPE;
  return 1;
}

/**
 * THE conversion, in absolute units. A temporal bezier segment is fully
 * described by its two interior control points; AE stores each as an
 * (influence, speed) pair where influence is the handle's horizontal reach as a
 * percentage of the segment duration and speed is its slope in value-units per
 * second:
 *
 *     speedOut = (V1 - v0) / (x1 * dt)          influenceOut = 100 * x1
 *     speedIn  = (v1 - V2) / ((1 - x2) * dt)    influenceIn  = 100 * (1 - x2)
 *
 * Working in absolute units rather than normalised progress matters: when a
 * segment starts and ends at the SAME value but bulges in between (a shake, a
 * bounce settling, an overshoot returning), the normalised form divides by a
 * zero value delta, while this form handles it exactly -- AE's speed is
 * independent of the value delta, so the bulge survives.
 *
 * `handles` is { x1, V1, x2, V2 }: x1/x2 are normalised times in [0,1] and
 * V1/V2 are absolute control VALUES.
 */
export function handlesToAeEase({ x1, V1, x2, V2 }, v0, v1, dt) {
  const safeDt = Math.abs(dt) > EPS ? dt : EPS;
  const runOut = Math.max(x1, MIN_INFLUENCE / 100);
  const runIn = Math.max(1 - x2, MIN_INFLUENCE / 100);
  const speedOut = clampSpeed((V1 - v0) / (runOut * safeDt), v0, v1, safeDt);
  const speedIn = clampSpeed((v1 - V2) / (runIn * safeDt), v0, v1, safeDt);
  return {
    out: { speed: speedOut, influence: clampInfluence(x1 * 100) },
    in: { speed: speedIn, influence: clampInfluence((1 - x2) * 100) },
  };
}

function clampSpeed(speed, v0, v1, dt) {
  if (!Number.isFinite(speed)) return 0;
  const reference = Math.max(Math.abs(v1 - v0) / Math.abs(dt), 1);
  const limit = reference * MAX_SLOPE;
  if (speed > limit) return limit;
  if (speed < -limit) return -limit;
  return speed;
}

/**
 * Convert one CSS cubic-bezier segment into the pair of AE eases that describe
 * it: the OUTGOING ease of the segment's first keyframe and the INCOMING ease
 * of its second. Exact -- see the derivation at the top of this file.
 */
export function bezierToAeEase(points, dv, dt) {
  const [x1, y1, x2, y2] = points;
  return handlesToAeEase({ x1, V1: y1 * dv, x2, V2: y2 * dv }, 0, dv, dt);
}

/**
 * Inverse of bezierToAeEase -- recover the CSS control tuple from a pair of AE
 * eases. Used by the round-trip test and by the AE probe harness to confirm the
 * host application agrees with our model.
 */
export function aeEaseToBezier(outEase, inEase, dv, dt) {
  const safeDt = Math.abs(dt) > EPS ? dt : EPS;
  const x1 = outEase.influence / 100;
  const x2 = 1 - inEase.influence / 100;
  if (Math.abs(dv) < EPS) return [x1, 0, x2, 1];
  const y1 = (outEase.speed * x1 * safeDt) / dv;
  const y2 = 1 - (inEase.speed * (1 - x2) * safeDt) / dv;
  return [x1, y1, x2, y2];
}

/**
 * A CSS steps() function becomes AE HOLD keyframes. Returns the intermediate
 * stops as normalised { t, progress } pairs; the caller emits each as a hold
 * key. `jump-none` spreads count stops across [0,1] inclusive; the others
 * follow the CSS spec's jump semantics.
 */
export function stepsToHoldKeys(count, position) {
  const stops = [];
  const n = Math.max(1, Math.floor(count));
  switch (position) {
    case 'start':
    case 'jump-start':
      for (let i = 0; i < n; i += 1) stops.push({ t: i / n, progress: (i + 1) / n });
      break;
    case 'jump-none':
      if (n === 1) { stops.push({ t: 0, progress: 0 }); break; }
      for (let i = 0; i < n; i += 1) stops.push({ t: i / (n - 1), progress: i / (n - 1) });
      break;
    case 'jump-both':
      for (let i = 0; i < n; i += 1) stops.push({ t: i / n, progress: (i + 1) / (n + 1) });
      break;
    case 'end':
    case 'jump-end':
    default:
      for (let i = 0; i < n; i += 1) stops.push({ t: i / n, progress: i / n });
      break;
  }
  return stops;
}

// Linear ease, for segments we deliberately do not shape (e.g. between baked
// samples that are already dense enough).
export function linearEase(dv, dt) {
  return bezierToAeEase(CSS_KEYWORD_BEZIERS.linear, dv, dt);
}
