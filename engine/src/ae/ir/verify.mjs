// Independent verification of a built IR against the capture it came from.
//
// This is deliberately NOT a check that the fitter agrees with itself. It
// replays each track through the same (influence, speed) pairs that will be
// written into After Effects, and compares against the raw browser measurement
// for every element on every frame. Whatever number this reports is what the
// comp will actually be off by.
import { evaluate } from './track.mjs';
import { identity } from '../math/matrix.mjs';
import { layerFrame } from '../analyze/layers.mjs';

/**
 * The time a looped layer's keyframes should be read at.
 *
 * A looping layer carries ONE cycle plus loopOut(), so evaluating its tracks at
 * a later time would hold the last keyframe. After Effects wraps; so must the
 * check, or every loop reports an error for the whole span after its first
 * cycle while rendering perfectly.
 */
function loopedTime(layer, t) {
  const loop = layer.loop;
  if (!loop || !(loop.period > 0)) return t;
  if (t <= loop.start + loop.period) return t;
  const into = (t - loop.start) % loop.period;
  return loop.start + into;
}

export function verifyIR(ir, capture) {
  // Check every composition, not just the root: a perspective subtree lives in
  // its own comp, and skipping it would silently stop verifying the hardest
  // layers in the import.
  const frameIndex = capture.frames.map((f) => new Map(f.elements.map((e) => [e.id, e])));
  const roleById = new Map((capture.nodes || []).map((n) => [n.id, n.role]));
  const allLayers = [];
  for (const c of ir.comps) for (const l of c.layers) allLayers.push(l);

  let worstPositionError = 0;
  let worstOpacityError = 0;
  let worstScaleError = 0;
  let worstLayer = null;
  let samples = 0;

  for (const layer of allLayers) {
    // A precomp layer is structural: it exists to hold a perspective subtree and
    // is positioned on the perspective origin by construction, not on the
    // element's animated position. The element itself is verified inside the
    // precomp, so checking the wrapper too would compare two different things
    // and report a failure that is not one.
    if (layer.kind === 'precomp') {
      // A group-opacity wrapper is the one precomp worth checking: it now
      // carries the fade that used to sit on the element, and that is exactly
      // the thing this feature exists to get right.
      if (layer.groupSourceId === undefined) continue;
      for (let i = 0; i < capture.frames.length; i += 1) {
        const entry = frameIndex[i].get(layer.groupSourceId);
        if (!entry || !entry.present) continue;
        const want = (entry.style.opacity ?? 1) * 100;
        const got = evaluate(layer.transform.opacity, capture.frames[i].time);
        worstOpacityError = Math.max(worstOpacityError, Math.abs(got - want));
      }
      continue;
    }
    for (let i = 0; i < capture.frames.length; i += 1) {
      const frame = capture.frames[i];
      const entry = frameIndex[i].get(layer.id);
      if (!entry || !entry.present) continue;
      const parent = layer.parentId === null ? null : frameIndex[i].get(layer.parentId);
      const m = entry.m || identity();
      // The same layer-space rule the analyzer uses: HTML boxes in page pixels,
      // SVG shapes in their own user space (see layerFrame).
      const frameOf = layerFrame(entry, parent, {
        self: roleById.get(layer.id) ?? null,
        parent: layer.parentId === null ? null : (roleById.get(layer.parentId) ?? null),
      });
      const ox = frameOf.reference[0] + entry.origin[0];
      const oy = frameOf.reference[1] + entry.origin[1];
      const pageX = frameOf.origin[0] + frameOf.unit[0] * (ox + m[12]);
      const pageY = frameOf.origin[1] + frameOf.unit[1] * (oy + m[13]);

      // A layer lifted into a perspective precomp lost its parent and had its
      // position rebased into that comp's coordinates, so it is checked against
      // page-absolute plus the same shift rather than against a parent it no
      // longer has.
      let wantX;
      let wantY;
      if (layer.rebased) {
        wantX = pageX + layer.rebased[0];
        wantY = pageY + layer.rebased[1];
      } else {
        wantX = (pageX - frameOf.parentOrigin[0]) / frameOf.parentUnit[0];
        wantY = (pageY - frameOf.parentOrigin[1]) / frameOf.parentUnit[1];
      }
      // A collapsed stagger has handed its motion to a text animator, so the
      // layer itself is deliberately parked in the settled state. Checking it
      // against the browser mid-animation would measure the animation it no
      // longer carries. The run's own fidelity is the blend residual, reported
      // separately by the detector.
      if (layer.stagger && i < capture.frames.length - 1) continue;
      const sampleTime = loopedTime(layer, frame.time);
      const got = evaluate(layer.transform.position, sampleTime);
      const err = Math.max(Math.abs(got[0] - wantX), Math.abs(got[1] - wantY));
      if (err > worstPositionError) {
        worstPositionError = err;
        worstLayer = { name: layer.name, time: frame.time, got: [got[0], got[1]], want: [wantX, wantY] };
      }

      // A hoisted opacity lives on the wrapper now; checking it here would
      // compare the neutralised 100% against the element's real fade.
      if (!layer.opacityHoisted) {
        // Where a group's opacity was folded down instead of composited, the
        // layer legitimately carries the PRODUCT, so the expectation has to
        // include every ancestor whose fade was baked into it.
        let wantOpacity = entry.style.opacity ?? 1;
        for (const gid of layer.opacityBakedFrom || []) {
          const g = frameIndex[i].get(gid);
          if (g && g.present) wantOpacity *= g.style.opacity ?? 1;
        }
        wantOpacity *= 100;
        worstOpacityError = Math.max(worstOpacityError, Math.abs(evaluate(layer.transform.opacity, sampleTime) - wantOpacity));
      }

      const scale = evaluate(layer.transform.scale, sampleTime);
      const linear = Math.hypot(m[0], m[1]) * 100 * (frameOf.unit[0] / frameOf.parentUnit[0]);
      worstScaleError = Math.max(worstScaleError, Math.abs(scale[0] - linear));
      samples += 1;
    }
  }

  return {
    samples,
    worstPositionError,
    worstOpacityError,
    worstScaleError,
    worstLayer,
    withinTolerance: worstPositionError <= 0.6 && worstOpacityError <= 1.0,
  };
}
