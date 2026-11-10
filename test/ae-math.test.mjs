import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../engine/src/ae/math/easing.mjs';
import * as M from '../engine/src/ae/math/matrix.mjs';
import * as F from '../engine/src/ae/math/curveFit.mjs';
import { aeEaseToHandles } from '../engine/src/ae/math/aeEase.mjs';

const normalize = (m) => m.map((v) => v / m[15]);

test('parses every CSS timing-function shape we claim to support', () => {
  assert.deepEqual(E.parseTimingFunction('ease-in-out'), { type: 'bezier', points: [0.42, 0, 0.58, 1] });
  assert.deepEqual(E.parseTimingFunction('cubic-bezier(.17,.67,.83,.67)').points, [0.17, 0.67, 0.83, 0.67]);
  assert.deepEqual(E.parseTimingFunction('steps(4, jump-start)'), { type: 'steps', count: 4, position: 'jump-start' });
  assert.deepEqual(E.parseTimingFunction('step-end'), { type: 'steps', count: 1, position: 'end' });
  // linear() polylines are deliberately NOT claimed analytically; sampling covers them.
  assert.equal(E.parseTimingFunction('linear(0, 0.25 30%, 1)'), null);
});

test('cubicBezierAt matches the browser at the endpoints and is monotone in time', () => {
  assert.equal(E.cubicBezierAt(0.42, 0, 0.58, 1, 0), 0);
  assert.equal(E.cubicBezierAt(0.42, 0, 0.58, 1, 1), 1);
  assert.ok(Math.abs(E.cubicBezierAt(0, 0, 1, 1, 0.37) - 0.37) < 1e-9, 'linear bezier is the identity');
  let prev = -Infinity;
  for (let i = 0; i <= 100; i += 1) {
    const v = E.cubicBezierAt(0.25, 0.1, 0.25, 1, i / 100);
    assert.ok(v >= prev - 1e-12, 'ease is monotone');
    prev = v;
  }
});

test('CSS bezier -> AE ease -> CSS bezier is exact', () => {
  const tuples = [
    [0.42, 0, 0.58, 1], [0.25, 0.1, 0.25, 1], [0.34, 1.56, 0.64, 1],
    [0.5, -0.6, 0.5, 1.6], [0.1, 0.9, 0.9, 0.1],
  ];
  for (const points of tuples) {
    for (const [dv, dt] of [[300, 0.6], [-120, 1.5], [1, 0.0333]]) {
      const ease = E.bezierToAeEase(points, dv, dt);
      const back = E.aeEaseToBezier(ease.out, ease.in, dv, dt);
      for (let i = 0; i < 4; i += 1) {
        assert.ok(Math.abs(back[i] - points[i]) < 1e-9, `${points} dv=${dv} -> ${back}`);
      }
    }
  }
});

test('AE ease round-trips in absolute units even when the value delta is zero', () => {
  // A bulge between two equal-valued keyframes: inexpressible in normalised
  // progress, exact in absolute units. This is the bounce-peak case.
  const handles = { x1: 0.25, V1: 80, x2: 0.75, V2: 80 };
  const ease = E.handlesToAeEase(handles, 0, 0, 0.5);
  const back = aeEaseToHandles(ease.out, ease.in, 0, 0, 0.5);
  assert.ok(Math.abs(back.V1 - 80) < 1e-9);
  assert.ok(Math.abs(back.V2 - 80) < 1e-9);
  assert.ok(ease.out.speed > 0 && ease.in.speed < 0, 'the bulge survives as opposing speeds');
});

test('influence is always inside the range After Effects accepts', () => {
  for (const points of [[0, 0, 1, 1], [0, 1, 1, 0], [1, 0, 0, 1]]) {
    const ease = E.bezierToAeEase(points, 100, 1);
    for (const side of [ease.out, ease.in]) {
      assert.ok(side.influence >= E.MIN_INFLUENCE, `influence ${side.influence} below AE minimum`);
      assert.ok(side.influence <= E.MAX_INFLUENCE, `influence ${side.influence} above AE maximum`);
      assert.ok(Number.isFinite(side.speed), 'speed must be finite');
    }
  }
});

test('steps() expands to the stops the CSS spec defines', () => {
  assert.deepEqual(E.stepsToHoldKeys(2, 'end').map((s) => s.progress), [0, 0.5]);
  assert.deepEqual(E.stepsToHoldKeys(2, 'start').map((s) => s.progress), [0.5, 1]);
  assert.deepEqual(E.stepsToHoldKeys(3, 'jump-none').map((s) => s.progress), [0, 0.5, 1]);
});

test('2D transform decompose/recompose is exact', () => {
  const cases = [
    'matrix(1, 0, 0, 1, 0, 0)',
    'matrix(1.2, 0.6, -0.35, 0.9, 40, -18)',
    'matrix(-1, 0, 0, 1, 10, 10)',           // horizontal flip
    'matrix(0, 1, -1, 0, 0, 0)',             // 90 degrees
    'matrix(2, 0, 1.5, 3, -5, 7)',           // skewed and non-uniform
  ];
  for (const css of cases) {
    const src = M.parseCssMatrix(css);
    const back = M.recompose2d(M.decompose2d(src));
    assert.ok(M.matrixError(src, back) < 1e-12, `${css} -> error ${M.matrixError(src, back)}`);
  }
});

test('3D transform decompose/recompose is exact, including perspective and reflection', () => {
  const I = M.identity;
  const T = (x, y, z) => { const m = I(); m[12] = x; m[13] = y; m[14] = z; return m; };
  const S = (x, y, z) => { const m = I(); m[0] = x; m[5] = y; m[10] = z; return m; };
  const P = (d) => { const m = I(); m[11] = -1 / d; return m; };
  const R = (e) => M.eulerToMatrix(e, 'ZYX');
  const skew = I(); skew[4] = 0.3;

  const cases = {
    rotate: R([25, -40, 15]),
    rotateScale: M.multiply(R([25, -40, 15]), S(1.4, 0.7, 1.1)),
    translateRotateScale: M.multiply(T(120, -45, 60), M.multiply(R([25, -40, 15]), S(1.4, 0.7, 1.1))),
    perspective: M.multiply(P(800), M.multiply(T(120, -45, 60), M.multiply(R([25, -40, 15]), S(1.4, 0.7, 1.1)))),
    skewed: M.multiply(T(10, 20, 30), M.multiply(R([10, 20, 30]), M.multiply(skew, S(2, 1.5, 1)))),
    reflected: M.multiply(R([0, 0, 30]), S(-1.2, 0.8, 1)),
  };
  for (const [name, src] of Object.entries(cases)) {
    const d = M.decompose3d(src);
    assert.ok(d, `${name} decomposed`);
    const err = M.matrixError(normalize(src), M.recompose3d(d));
    assert.ok(err < 1e-12, `${name} -> error ${err}`);
  }
});

test('euler recovery returns the angles the rotation was built from', () => {
  for (const angles of [[25, -40, 15], [0, 0, 0], [90, 0, 0], [0, 89, 0], [-33, 12, 170]]) {
    const q = M.decompose3d(M.eulerToMatrix(angles, 'ZYX')).quaternion;
    const back = M.quaternionToEuler(q, 'ZYX');
    const rebuilt = M.eulerToMatrix(back, 'ZYX');
    assert.ok(M.matrixError(M.eulerToMatrix(angles, 'ZYX'), rebuilt) < 1e-9, `${angles} -> ${back}`);
  }
});

test('a true CSS cubic fits in exactly two keyframes', () => {
  const fps = 60;
  for (const points of [[0.42, 0, 0.58, 1], [0.25, 0.1, 0.25, 1], [0.34, 1.56, 0.64, 1]]) {
    const samples = [];
    for (let f = 0; f <= fps; f += 1) {
      samples.push({ t: f / fps, v: 300 * E.cubicBezierAt(...points, f / fps) });
    }
    const fit = F.fitTrack(samples, { tolerance: 0.5 });
    assert.equal(fit.keys.length, 2, `${points} needed ${fit.keys.length} keys`);
    assert.ok(fit.maxError < 0.01, `${points} error ${fit.maxError}`);
  }
});

test('fitted tracks honour the tolerance contract on hard motion', () => {
  const fps = 60;
  const shapes = {
    spring: (p) => 300 * (1 - Math.exp(-6 * p) * Math.cos(12 * p)),
    bounce: (p) => 300 * Math.abs(Math.sin(4 * Math.PI * p)) * (1 - p),
    shake: (p) => 18 * Math.sin(20 * Math.PI * p) * (1 - p),
    stall: (p) => (p < 0.5 ? 0 : 200 * (p - 0.5) * 2),
  };
  for (const [name, fn] of Object.entries(shapes)) {
    const samples = [];
    for (let f = 0; f <= fps; f += 1) samples.push({ t: f / fps, v: fn(f / fps) });
    const tolerance = 0.5;
    const fit = F.fitTrack(samples, { tolerance });
    for (const s of samples) {
      const err = Math.abs(F.evaluateTrack(fit.keys, s.t) - s.v);
      assert.ok(err <= tolerance + 1e-6, `${name} at t=${s.t}: error ${err} > ${tolerance}`);
    }
    assert.ok(fit.keys.length < samples.length, `${name} did not reduce key count`);
  }
});

test('every fitted segment survives the AE ease round-trip', () => {
  const fps = 60;
  const samples = [];
  for (let f = 0; f <= fps; f += 1) {
    const p = f / fps;
    samples.push({ t: p, v: 300 * Math.abs(Math.sin(4 * Math.PI * p)) * (1 - p) });
  }
  const fit = F.fitTrack(samples, { tolerance: 0.5 });
  for (let i = 0; i < fit.keys.length - 1; i += 1) {
    const A = fit.keys[i];
    const B = fit.keys[i + 1];
    if (A.hold) continue;
    const dt = B.t - A.t;
    const h = F.segmentHandles(A, B);
    const ease = E.handlesToAeEase(h, A.v, B.v, dt);
    const back = aeEaseToHandles(ease.out, ease.in, A.v, B.v, dt);
    assert.ok(Math.abs(back.V1 - h.V1) < 1e-9, `V1 drift ${back.V1} vs ${h.V1}`);
    assert.ok(Math.abs(back.V2 - h.V2) < 1e-9, `V2 drift ${back.V2} vs ${h.V2}`);
  }
});

test('a track that never moves produces no keyframes', () => {
  const samples = [];
  for (let f = 0; f <= 60; f += 1) samples.push({ t: f / 60, v: 42 });
  const fit = F.fitTrack(samples, { tolerance: 0.25 });
  assert.equal(fit.static, true);
  assert.equal(fit.keys.length, 1);
});

test('a hard cut becomes a hold keyframe, not a ramp', () => {
  const samples = [];
  for (let f = 0; f <= 60; f += 1) samples.push({ t: f / 60, v: f < 30 ? 0 : 100 });
  const fit = F.fitTrack(samples, { tolerance: 0.25, jumpThreshold: 50 });
  const held = fit.keys.filter((k) => k.hold);
  assert.ok(held.length >= 1, 'expected at least one hold keyframe');
  assert.ok(Math.abs(F.evaluateTrack(fit.keys, 0.4) - 0) < 1e-6, 'value holds before the cut');
  assert.ok(Math.abs(F.evaluateTrack(fit.keys, 0.6) - 100) < 1e-6, 'value holds after the cut');
});
