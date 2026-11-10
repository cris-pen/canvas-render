import test from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '../engine/src/browser.mjs';
import { readFileSync } from 'node:fs';
import { aeTransformAt, aeToMatrix } from '../engine/src/ae/analyze/layers.mjs';
import { parseCssMatrix, eulerToMatrix, matrixError, flipZ, EULER_ORDERS, decompose3d, quaternionToEuler } from '../engine/src/ae/math/matrix.mjs';

const CLOCK = readFileSync(new URL('../engine/src/clock.js', import.meta.url), 'utf8');
const PROBE = readFileSync(new URL('../engine/src/ae/capture/probe.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../fixtures/ae/motion-suite.html', import.meta.url), 'utf8');

test('every Euler order round-trips against its own composition', () => {
  for (const order of EULER_ORDERS) {
    for (const angles of [[25, -40, 15], [0, 0, 0], [80, 10, -70], [-33, 12, 170]]) {
      const src = eulerToMatrix(angles, order);
      const back = quaternionToEuler(decompose3d(src).quaternion, order);
      assert.ok(matrixError(src, eulerToMatrix(back, order)) < 1e-9, `${order} ${angles}`);
    }
  }
});

test("After Effects' measured Orientation convention is Rx . Ry . Rz", () => {
  // Measured from AE 26.3 by setting Orientation [25,-40,15] on a 3D null and
  // reading the rotated basis vectors back through an expression's toWorld().
  // Recorded here so a future change to the Euler code cannot silently drift
  // away from the application without a test noticing.
  const measured = [
    0.739942, -0.027828, 0.672095, 0,
    -0.198267, 0.945735, 0.257439, 0,
    -0.642788, -0.323744, 0.694272, 0,
    0, 0, 0, 1,
  ];
  const ours = eulerToMatrix([25, -40, 15], 'XYZ');
  assert.ok(matrixError(measured, ours) < 1e-5, `error ${matrixError(measured, ours)}`);
  // And no other order comes close, so the identification is unambiguous.
  for (const order of EULER_ORDERS.filter((o) => o !== 'XYZ')) {
    assert.ok(matrixError(measured, eulerToMatrix([25, -40, 15], order)) > 0.01, `${order} is ambiguous with XYZ`);
  }
});

test('flipZ is an involution and leaves rotation about z alone', () => {
  const r = eulerToMatrix([20, 35, 10], 'XYZ');
  assert.ok(matrixError(flipZ(flipZ(r)), r) < 1e-12);
  const zOnly = eulerToMatrix([0, 0, 30], 'XYZ');
  assert.ok(matrixError(flipZ(zOnly), zOnly) < 1e-12, 'a pure z rotation must be unchanged by a z flip');
});

test('a CSS 3D transform under perspective maps to where the browser draws it', async () => {
  // Ground truth is measured, not modelled: a 1px marker is placed at the
  // panel's own local origin and its on-screen rect read back. The check then
  // runs the same frames through this repo's AE transform model plus AE's
  // camera projection. Passing means the 3D path is right without needing
  // After Effects in the loop.
  const times = [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0];
  const browser = await launchBrowser();
  let samples;
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
    await page.addInitScript({ content: `${CLOCK}\nwindow.__crClock.install(); window.__d2aeClock = window.__crClock;` });
    await page.addInitScript({ content: PROBE });
    await page.goto('about:blank');
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => { window.__d2ae.index(null); window.__d2ae.seek(0); });
    samples = await page.evaluate((ts) => ts.map((t) => {
      window.__d2ae.seek(t * 1000);
      const panel = document.getElementById('panel');
      const scene = document.getElementById('scene');
      const dot = document.createElement('div');
      dot.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px';
      panel.appendChild(dot);
      const r = dot.getBoundingClientRect();
      dot.remove();
      const sr = scene.getBoundingClientRect();
      const cs = getComputedStyle(panel);
      const origin = cs.transformOrigin.split(/\s+/).map(parseFloat);
      const po = getComputedStyle(scene).perspectiveOrigin.split(/\s+/).map(parseFloat);
      return {
        t,
        truth: [r.x, r.y],
        transform: cs.transform,
        origin: [origin[0] || 0, origin[1] || 0, origin[2] || 0],
        box: [sr.x, sr.y, sr.width, sr.height],
        perspective: parseFloat(getComputedStyle(scene).perspective),
        pivot: [sr.x + (po[0] || 0), sr.y + (po[1] || 0)],
      };
    }), times);
  } finally {
    await browser.close();
  }

  const apply = (m, v) => [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ];

  let worst = 0;
  let sawRotation = false;
  for (const s of samples) {
    const entry = { present: true, box: s.box, origin: s.origin, m: parseCssMatrix(s.transform), style: { opacity: 1 } };
    const t = aeTransformAt(entry, null);
    if (Math.abs(t.orientation[1]) > 5) sawRotation = true;
    const R = aeToMatrix(t, 'XYZ');
    const w = apply(R, [-t.anchorPoint[0], -t.anchorPoint[1], -t.anchorPoint[2]]);
    const W = [t.position[0] + w[0], t.position[1] + w[1], t.position[2] + w[2]];
    const k = s.perspective / (W[2] + s.perspective);
    const u = s.pivot[0] + (W[0] - s.pivot[0]) * k;
    const v = s.pivot[1] + (W[1] - s.pivot[1]) * k;
    worst = Math.max(worst, Math.abs(u - s.truth[0]), Math.abs(v - s.truth[1]));
  }
  assert.ok(sawRotation, 'the fixture should actually rotate, or this proves nothing');
  assert.ok(worst < 0.5, `worst 3D projection error was ${worst.toFixed(4)}px`);
});

test('a perspective subtree is lifted into a comp centred on the perspective origin', async () => {
  // The whole point of the precomp: After Effects' vanishing point is the comp
  // centre and cannot be moved, so the comp is built so that its centre IS the
  // CSS perspective-origin.
  const { buildPerspectiveComp, collectSubtree } = await import('../engine/src/ae/ir/precomp.mjs');

  const layer = (id, parentId, pos, size) => ({
    id,
    name: `l${id}`,
    parentId,
    kind: 'shape',
    tier: 'A',
    transform: {
      position: { static: pos },
      anchorPoint: { static: [0, 0] },
      scale: { static: [100, 100] },
      opacity: { static: 100 },
    },
    absolute: { static: pos },
    boxSize: { static: size },
    shape: { size: { static: size } },
  });

  const rootComp = {
    id: 'root',
    name: 'test',
    width: 1280,
    height: 400,
    fps: 30,
    duration: 1,
    backgroundColor: { rgb: [0, 0, 0], a: 1 },
    layers: [
      layer(1, null, [0, 0], [1280, 400]),
      layer(2, 1, [110, 130], [400, 104]),   // the perspective container
      layer(3, 2, [10, 10], [380, 84]),      // a child
    ],
  };
  const camera = { id: 2, name: 'scene', distance: 900, point: [110, 182] };

  assert.deepEqual([...collectSubtree(rootComp.layers, 2)].sort(), [2, 3]);

  const lifted = buildPerspectiveComp(rootComp, camera, { parentOffset: [0, 0] });
  assert.ok(lifted, 'expected a precomp for an off-centre perspective origin');

  // Its centre must be the perspective origin, to the pixel.
  assert.equal(lifted.comp.width / 2, lifted.comp.camera.point[0]);
  assert.equal(lifted.comp.height / 2, lifted.comp.camera.point[1]);

  // The container is rebased: it lost its parent, so its position becomes
  // absolute-in-precomp rather than parent-relative.
  const container = lifted.comp.layers.find((l) => l.id === 2);
  assert.equal(container.parentId, null);
  assert.deepEqual(container.rebased, lifted.shift);
  assert.deepEqual(
    container.transform.position.static.slice(0, 2),
    [110 + lifted.shift[0], 130 + lifted.shift[1]],
  );
  // The perspective origin lands exactly on the precomp centre.
  assert.deepEqual(
    [110 + lifted.shift[0] + 0, 182 + lifted.shift[1]],
    [lifted.comp.camera.point[0] - 0, lifted.comp.camera.point[1]],
  );

  // Descendants keep their parent-relative positions untouched.
  const child = lifted.comp.layers.find((l) => l.id === 3);
  assert.equal(child.parentId, 2);
  assert.deepEqual(child.transform.position.static, [10, 10]);

  // The replacement layer sits on the origin with its anchor at the centre.
  assert.equal(lifted.layer.kind, 'precomp');
  assert.deepEqual(lifted.layer.transform.anchorPoint.static, [lifted.comp.width / 2, lifted.comp.height / 2]);
  assert.deepEqual(lifted.layer.transform.position.static, [110, 182]);

  // Sizing must cover every layer's box, not just shapes -- undersizing crops
  // the subtree, and text layers carry no shape.size.
  assert.ok(lifted.comp.width >= 2 * (390 - 110), `precomp too narrow: ${lifted.comp.width}`);
});

test('a perspective origin already at the comp centre needs no precomp', async () => {
  const { buildPerspectiveComp } = await import('../engine/src/ae/ir/precomp.mjs');
  const rootComp = {
    id: 'root', name: 't', width: 800, height: 600, fps: 30, duration: 1,
    backgroundColor: { rgb: [0, 0, 0], a: 1 },
    layers: [{
      id: 1, name: 'a', parentId: null, kind: 'shape', tier: 'A',
      transform: { position: { static: [400, 300] }, anchorPoint: { static: [0, 0] } },
      absolute: { static: [400, 300] }, boxSize: { static: [10, 10] },
    }],
  };
  const camera = { id: 1, name: 'c', distance: 800, point: [400, 300] };
  assert.equal(buildPerspectiveComp(rootComp, camera), null);
});
