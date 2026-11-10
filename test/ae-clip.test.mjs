import test from 'node:test';
import assert from 'node:assert/strict';
import { clipsContent, clipGeometry, roundedRectPath, buildClipComp } from '../engine/src/ae/ir/clip.mjs';

test('overflow values that clip are recognised', () => {
  for (const v of ['hidden', 'clip', 'auto', 'scroll']) {
    assert.equal(clipsContent({ overflow: [v, 'visible'] }), true, v);
    assert.equal(clipsContent({ overflow: ['visible', v] }), true, `${v} on y`);
  }
  assert.equal(clipsContent({ overflow: ['visible', 'visible'] }), false);
  assert.equal(clipsContent(null), false);
});

test('the clip box is the PADDING box with inner radii', () => {
  // CSS clips descendants to the padding box, and the inner corner radius is the
  // outer radius less the border -- using the outer one rounds the clip more
  // than the design does.
  const g = clipGeometry({
    box: [100, 50, 300, 200],
    style: { borderWidth: [2, 2, 2, 2], borderRadius: ['18px', '18px', '18px', '18px'] },
  });
  assert.deepEqual(g.origin, [102, 52]);
  assert.deepEqual(g.size, [296, 196]);
  assert.deepEqual(g.radii, [16, 16, 16, 16]);
  assert.deepEqual(g.borderOffset, [2, 2]);
});

test('a square clip needs no mask path detour', () => {
  const p = roundedRectPath(100, 60, [0, 0, 0, 0]);
  assert.deepEqual(p.vertices, [[0, 0], [100, 0], [100, 60], [0, 60]]);
  assert.ok(p.inTangents.every((t) => t[0] === 0 && t[1] === 0));
  assert.equal(p.closed, true);
});

test('a rounded clip produces eight vertices with corner tangents', () => {
  const p = roundedRectPath(100, 60, [10, 10, 10, 10]);
  assert.equal(p.vertices.length, 8);
  assert.deepEqual(p.vertices[0], [10, 0]);
  assert.deepEqual(p.vertices[2], [100, 10]);
  // Radii are clamped so they cannot exceed half the shorter side.
  const clamped = roundedRectPath(40, 20, [999, 999, 999, 999]);
  for (const [x, y] of clamped.vertices) {
    assert.ok(x >= -0.001 && x <= 40.001 && y >= -0.001 && y <= 20.001, `${x},${y}`);
  }
});

// `position` is parent-relative and `absolute` is page-space -- they are
// genuinely different numbers, and conflating them in a fixture produces a test
// that fails for reasons the code is not responsible for.
function fixture() {
  const layer = (id, parentId, pos, abs, size) => ({
    id, name: `l${id}`, parentId, kind: 'shape', tier: 'A',
    transform: { position: { static: pos }, anchorPoint: { static: [0, 0] } },
    absolute: { static: abs },
    boxSize: { static: size },
  });
  return {
    id: 'root', name: 't', width: 900, height: 260, fps: 30, duration: 1,
    backgroundColor: { rgb: [0, 0, 0], a: 1 },
    layers: [
      layer(1, null, [0, 0], [0, 0], [900, 260]),
      layer(2, 1, [40, 40], [40, 40], [824, 184]),        // the clipper
      layer(3, 2, [-100, 42], [-60, 82], [400, 100]),     // a child off the left edge
      layer(4, 3, [10, 10], [-50, 92], [50, 50]),         // a grandchild
    ],
  };
}

test('escaping content is lifted into a comp the size of the clip box', () => {
  const rootComp = fixture();
  const clipper = rootComp.layers.find((l) => l.id === 2);
  const geom = clipGeometry({ box: [40, 40, 824, 184], style: { borderWidth: [2, 2, 2, 2], borderRadius: ['44px', '44px', '44px', '44px'] } });
  const built = buildClipComp(rootComp, clipper, geom);
  assert.ok(built, 'expected a clip comp when content escapes');
  assert.deepEqual(built.size, [820, 180]);
  assert.deepEqual(built.shift, [-42, -42]);
  assert.ok(built.layer.mask, 'rounded corners need a mask');

  // The clipper's own paint stays outside -- an element's background and border
  // are not clipped by its own overflow.
  assert.ok(!built.comp.layers.some((l) => l.id === 2));

  // Direct children lost their parent and are rebased; deeper ones did not.
  const child = built.comp.layers.find((l) => l.id === 3);
  assert.equal(child.parentId, null);
  // Rebased from its PAGE position (-60, 82) by the clip shift, not from its
  // parent-relative one.
  assert.deepEqual(child.transform.position.static, [-60 - 42, 82 - 42]);
  const grandchild = built.comp.layers.find((l) => l.id === 4);
  assert.equal(grandchild.parentId, 3);
  assert.deepEqual(grandchild.transform.position.static, [10, 10]);

  // The replacement layer hangs off the clipper, offset by its border.
  assert.equal(built.layer.parentId, 2);
  assert.deepEqual(built.layer.transform.position.static, [2, 2]);
});

test('square content that never escapes is left alone', () => {
  const rootComp = fixture();
  // Move both descendants fully inside the clip box (42,42)..(862,222).
  rootComp.layers[2].absolute.static = [100, 60];
  rootComp.layers[3].absolute.static = [110, 70];
  const clipper = rootComp.layers.find((l) => l.id === 2);
  const geom = clipGeometry({ box: [40, 40, 824, 184], style: { borderWidth: [2, 2, 2, 2], borderRadius: ['0px', '0px', '0px', '0px'] } });
  assert.equal(buildClipComp(rootComp, clipper, geom), null,
    'a clip that clips nothing should not cost a composition');
});

test('rounded corners clip even when the content fits', () => {
  // A child exactly filling a rounded frame still has its corners cut, so the
  // "nothing escapes" shortcut must not apply once there is a radius.
  const rootComp = fixture();
  rootComp.layers[2].absolute.static = [100, 60];
  rootComp.layers[3].absolute.static = [110, 70];
  const clipper = rootComp.layers.find((l) => l.id === 2);
  const geom = clipGeometry({ box: [40, 40, 824, 184], style: { borderWidth: [2, 2, 2, 2], borderRadius: ['20px', '20px', '20px', '20px'] } });
  const built = buildClipComp(rootComp, clipper, geom);
  assert.ok(built, 'a rounded clip must still produce a comp');
  assert.ok(built.layer.mask, 'and it must carry the rounded mask');
});
