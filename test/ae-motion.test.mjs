// Tests for the four features that decide how a design LOOKS once it is in
// After Effects: staggered text, repeating backgrounds, group opacity and the
// background-position arithmetic underneath both image paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStaggers } from '../engine/src/ae/ir/stagger.mjs';
import { repeatAxes, tileParams } from '../engine/src/ae/ir/tile.mjs';
import { subtreeOverlaps } from '../engine/src/ae/ir/group.mjs';
import { parseBackgroundPosition, computeFit, parseBackgroundSize } from '../engine/src/ae/ingest/assets.mjs';

const FPS = 30;
const FRAMES = 30;

/** A span whose animation is a two-state blend, delayed by `delay` seconds. */
function span({ id, parentId, name, text, x, delay, rise = 40, ease = (u) => u, width = 60, fade = 'in', spin = 0 }) {
  const perFrame = [];
  for (let i = 0; i < FRAMES; i += 1) {
    const time = i / FPS;
    const raw = (time - delay) / 0.5;
    const p = Math.max(0, Math.min(1, raw));
    const u = 1 - ease(p);                      // 1 at the start, 0 once settled
    const y = 100 + u * rise;
    perFrame.push({
      time,
      entry: {
        present: true,
        box: [x, 100, width, 20],
        text,
        style: { color: 'rgb(0,0,0)', fontStyle: 'normal', fontWeight: '400', fontFamily: 'X', fontSize: 20 },
      },
      transform: {
        absolutePosition: [x, y, 0],
        scale: [100, 100],
        rotation: u * spin,
        orientation: [0, 0, 0],
        // 'in' fades up from nothing; 'out' fades down to it.
        opacity: fade === 'out' ? 100 * u : 100 * (1 - u),
        boxQuad: [[x, y], [x + width, y], [x + width, y + 20], [x, y + 20]],
      },
    });
  }
  return { node: { id, parentId, role: 'text', name, depth: 2 }, perFrame };
}

test('a delayed run of spans collapses into one animator', () => {
  const kids = [
    span({ id: 1, parentId: 9, name: 'w1', text: 'Motion', x: 0, delay: 0 }),
    span({ id: 2, parentId: 9, name: 'w2', text: 'that', x: 70, delay: 0.15 }),
    span({ id: 3, parentId: 9, name: 'w3', text: 'carries', x: 140, delay: 0.3 }),
  ];
  const parent = { node: { id: 9, parentId: null, role: 'box', name: 'h1', depth: 1 }, perFrame: kids[0].perFrame };
  const runs = detectStaggers([parent, ...kids]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, 'Motion that carries');
  // Character ranges are what the Range Selectors are written from, so an
  // off-by-one here moves a whole word's animation onto its neighbour.
  assert.deepEqual(runs[0].members.map((m) => [m.charStart, m.charEnd]), [[0, 6], [7, 11], [12, 19]]);
  assert.ok(Math.abs(runs[0].from.position[1] - 40) < 0.01, 'carries the rise as a position offset');
  assert.equal(runs[0].from.opacity, 0);
  assert.ok(runs[0].residual < 0.01, 'a true two-state blend fits exactly');
});

test('spans that move together are not a stagger', () => {
  const kids = [
    span({ id: 1, parentId: 9, name: 'w1', text: 'one', x: 0, delay: 0.1 }),
    span({ id: 2, parentId: 9, name: 'w2', text: 'two', x: 70, delay: 0.1 }),
  ];
  const parent = { node: { id: 9, parentId: null, role: 'box', name: 'p', depth: 1 }, perFrame: kids[0].perFrame };
  assert.equal(detectStaggers([parent, ...kids]).length, 0);
});

test('spans moving different distances keep their own layers', () => {
  const kids = [
    span({ id: 1, parentId: 9, name: 'w1', text: 'one', x: 0, delay: 0, rise: 40 }),
    span({ id: 2, parentId: 9, name: 'w2', text: 'two', x: 70, delay: 0.15, rise: 90 }),
  ];
  const parent = { node: { id: 9, parentId: null, role: 'box', name: 'p', depth: 1 }, perFrame: kids[0].perFrame };
  assert.equal(detectStaggers([parent, ...kids]).length, 0, 'one animator cannot hold two different from-states');
});

test('overlap is judged on the transformed box, not the anchor', () => {
  // Two stacked lines at different sizes: reconstructing their boxes from
  // position minus anchor made these appear to overlap, because a text layer's
  // anchor sits on its BASELINE and each was displaced by its own ascent.
  const line = (id, top, height) => ({
    node: { id, parentId: 5, role: 'text', name: `l${id}`, depth: 2 },
    perFrame: [{
      time: 0,
      entry: { present: true, box: [0, top, 100, height] },
      transform: { boxQuad: [[0, top], [100, top], [100, top + height], [0, top + height]] },
    }],
  });
  const stacked = [line(1, 0, 40), line(2, 46, 15)];
  const ids = new Set([1, 2]);
  assert.equal(subtreeOverlaps(stacked, ids, 1, FPS, () => true), false);

  const covering = [line(1, 0, 40), line(2, 20, 15)];
  assert.equal(subtreeOverlaps(covering, ids, 1, FPS, () => true), true);
});

test('an element that paints nothing cannot make a composite denser', () => {
  const box = (id, top) => ({
    node: { id, parentId: 5, role: 'box', name: `b${id}`, depth: 2 },
    perFrame: [{
      time: 0,
      entry: { present: true, box: [0, top, 100, 40] },
      transform: { boxQuad: [[0, top], [100, top], [100, top + 40], [0, top + 40]] },
    }],
  });
  const layers = [box(1, 0), box(2, 10)];
  const ids = new Set([1, 2]);
  assert.equal(subtreeOverlaps(layers, ids, 1, FPS, () => true), true);
  assert.equal(subtreeOverlaps(layers, ids, 1, FPS, (id) => id === 1), false);
});

test('background-repeat maps onto the axes that actually repeat', () => {
  assert.deepEqual(repeatAxes('repeat'), { x: true, y: true });
  assert.deepEqual(repeatAxes('repeat-x'), { x: true, y: false });
  assert.deepEqual(repeatAxes('repeat-y'), { x: false, y: true });
  assert.deepEqual(repeatAxes('no-repeat'), { x: false, y: false });
  assert.deepEqual(repeatAxes('repeat no-repeat'), { x: true, y: false });
});

test('Motion Tile output reaches the far edge, not merely across the box', () => {
  // Output is measured symmetrically about the tile's own centre, so a tile
  // near one edge needs enough output to reach the OTHER one.
  const p = tileParams({
    offset: [0, 0], tile: [40, 40], box: [200, 120],
    axes: { x: true, y: true }, natural: [80, 80],
  });
  assert.deepEqual(p.center, [40, 40], 'the tile is the layer, so its centre is the source centre');
  assert.equal(p.outputWidth, 900);            // 2 * max(20, 180) / 40 * 100
  assert.equal(p.outputHeight, 500);           // 2 * max(20, 100) / 40 * 100

  const oneAxis = tileParams({
    offset: [0, 0], tile: [40, 40], box: [200, 120],
    axes: { x: true, y: false }, natural: [80, 80],
  });
  assert.equal(oneAxis.outputHeight, 100, 'an axis that does not repeat stays a single tile');
});

test('background-position resolves lengths as well as fractions', () => {
  const size = parseBackgroundSize('48px 48px');
  const fit = (pos) => computeFit({
    naturalW: 48, naturalH: 48, boxW: 360, boxH: 260,
    mode: size.mode, sizeW: size.sizeW, sizeH: size.sizeH,
    position: parseBackgroundPosition(pos),
  });
  assert.deepEqual(fit('12px 8px').offset, [12, 8], 'a length is measured from the edge');
  assert.deepEqual(fit('center').offset, [156, 106], 'a fraction resolves against the leftover space');
  assert.deepEqual(fit('0 0').offset, [0, 0]);
  assert.deepEqual(fit('100% 100%').offset, [312, 212]);
});

test('spans laid out flush are joined without an invented space', () => {
  // The canonical per-character stagger. Inserting a separator between every
  // pair turned "Motion" into "M o t i o n" -- six extra characters, and every
  // Range Selector indexing a string the design never had.
  const letters = 'Motion'.split('');
  const kids = letters.map((ch, i) => span({
    id: i + 1, parentId: 9, name: `c${i}`, text: ch,
    x: i * 40, width: 40, delay: i * 0.05,
  }));
  const parent = { node: { id: 9, parentId: null, role: 'box', name: 'h1', depth: 1 }, perFrame: kids[0].perFrame };
  const runs = detectStaggers([parent, ...kids]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, 'Motion');
  assert.deepEqual(runs[0].members.map((m) => [m.charStart, m.charEnd]),
    [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]);
});

test('spans with a real gap between them keep their space', () => {
  const kids = [
    span({ id: 1, parentId: 9, name: 'w1', text: 'Motion', x: 0, width: 60, delay: 0 }),
    span({ id: 2, parentId: 9, name: 'w2', text: 'that', x: 80, width: 40, delay: 0.15 }),
  ];
  const parent = { node: { id: 9, parentId: null, role: 'box', name: 'h1', depth: 1 }, perFrame: kids[0].perFrame };
  const runs = detectStaggers([parent, ...kids]);
  assert.equal(runs[0].text, 'Motion that');
  assert.deepEqual(runs[0].members.map((m) => [m.charStart, m.charEnd]), [[0, 6], [7, 11]]);
});

test('a staggered fade-OUT is built the other way round', () => {
  // Parking the layer on the settled state is right for an entrance and fatal
  // for an exit: After Effects MULTIPLIES layer Opacity through the text, so a
  // layer parked at 0 renders nothing whatever the animator holds.
  const kids = [
    span({ id: 1, parentId: 9, name: 'w1', text: 'one', x: 0, delay: 0, rise: 0, fade: 'out' }),
    span({ id: 2, parentId: 9, name: 'w2', text: 'two', x: 70, delay: 0.15, rise: 0, fade: 'out' }),
  ];
  const parent = { node: { id: 9, parentId: null, role: 'box', name: 'p', depth: 1 }, perFrame: kids[0].perFrame };
  const runs = detectStaggers([parent, ...kids]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].exit, true, 'recognised as an exit');
  assert.equal(runs[0].from.opacity, 0, 'the animator holds the invisible end');
  // Amount must RISE into the exit rather than fall away from it.
  const first = runs[0].members[0].amount;
  const at = (t) => (first.keys
    ? first.keys.reduce((a, k) => (k.t <= t ? k : a), first.keys[0]).v
    : first.static);
  assert.ok(at(0) < 5, 'starts unselected');
  assert.ok(at(0.9) > 95, 'ends fully selected');
});

test('a rotate-in stagger keeps its rotation', () => {
  // 2D spin lives in transform.rotation; reading only `orientation` made this
  // look like pure translation and deleted the rotation on collapse.
  const kids = [
    span({ id: 1, parentId: 9, name: 'w1', text: 'one', x: 0, delay: 0, rise: 0, spin: 20 }),
    span({ id: 2, parentId: 9, name: 'w2', text: 'two', x: 70, delay: 0.15, rise: 0, spin: 20 }),
  ];
  const parent = { node: { id: 9, parentId: null, role: 'box', name: 'p', depth: 1 }, perFrame: kids[0].perFrame };
  const runs = detectStaggers([parent, ...kids]);
  assert.equal(runs.length, 1);
  assert.ok(runs[0].from.rotation !== null, 'the rotation reached the animator');
  assert.ok(Math.abs(runs[0].from.rotation - 20) < 0.5);
});
