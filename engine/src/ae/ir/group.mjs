// CSS group opacity -> a composition that composites before it fades.
//
// `opacity` below 1 makes an element a stacking context: the element AND its
// descendants are rendered together, and the finished group is faded as one.
// After Effects has no equivalent, because parenting composes transforms and
// nothing else -- so an imported card that fades from 0 keeps its text at full
// strength the whole way, which is the single most visible way this importer can
// be wrong.
//
// Two things follow, and only the second needs a composition:
//   * The fade has to apply to the whole subtree, not just the element.
//   * Overlapping children must not fade independently. Baking the group's
//     opacity into each descendant looks right until two of them overlap, and
//     then the overlap is twice as opaque as the design.
//
// Compositing the subtree in its own comp and fading THAT layer is what CSS
// does, and what a motion designer would build by hand.
import { evaluate } from './track.mjs';
import { collectSubtree, subtreeBounds } from './precomp.mjs';

/** Does this element ever fade, at any sampled frame? */
export function fadesAsGroup(track) {
  if (!track) return false;
  if (track.keys === undefined) return track.static < 99.99;
  return track.keys.some((k) => k.v < 99.99);
}

/**
 * Can anything inside this group overlap anything else?
 *
 * This is the whole question. Fading a group is only different from fading its
 * parts when two of those parts cover each other: where they do not, the two
 * are identical and baking the opacity down is exact AND free. Where they do,
 * baking makes the overlap denser than the design -- two children at 50% over
 * each other read 75%.
 *
 * The element's OWN paint is one of those parts, which is why a card with a
 * background and text on it overlaps by definition and still needs a comp.
 * Only elements that actually paint are considered: an empty layout wrapper
 * contributes nothing to the composite and so cannot make it denser.
 *
 * Boxes are deliberately conservative -- axis-aligned bounds of the transformed
 * border box, so two glyphs that never touch inside overlapping boxes are
 * judged to overlap. That costs a composition; the other way costs correctness.
 */
export function subtreeOverlaps(analyses, ids, duration, fps, paintsId) {
  const members = analyses.filter((a) => ids.has(a.node.id) && paintsId(a.node.id));
  if (members.length < 2) return false;
  // A large subtree is not worth an O(n^2) sweep per frame; assume it overlaps.
  if (members.length > 24) return true;

  const frames = members[0].perFrame.length;
  const step = Math.max(1, Math.round(frames / 60));
  for (let i = 0; i < frames; i += step) {
    const boxes = [];
    for (const member of members) {
      const p = member.perFrame[i];
      // A layer absent at this frame has no transform, so it drops out here.
      if (!p || !p.transform || !p.transform.boxQuad) continue;
      const q = p.transform.boxQuad;
      const xs = q.map((c) => c[0]);
      const ys = q.map((c) => c[1]);
      boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const A = boxes[a];
        const B = boxes[b];
        // A shared edge is not an overlap; require real area in common.
        if (A[0] < B[2] - 0.01 && A[2] > B[0] + 0.01
          && A[1] < B[3] - 0.01 && A[3] > B[1] + 0.01) return true;
      }
    }
  }
  void duration; void fps;
  return false;
}

/**
 * Build the compositing comp for one faded element, or null when it is not
 * needed -- an element with no descendants fades correctly on its own.
 */
export function buildGroupComp(rootComp, groupLayer, options = {}) {
  const ids = collectSubtree(rootComp.layers, groupLayer.id);
  if (ids.size < 2) return null; // nothing but the element itself

  const bounds = subtreeBounds(rootComp.layers, ids, rootComp.duration, rootComp.fps);
  if (!bounds) return null;

  // The comp must NOT clip -- unlike an overflow comp, this one exists only to
  // composite. Margin covers strokes, shadows and blurs that paint outside the
  // layout box.
  const margin = options.margin ?? 64;
  const originX = Math.floor(bounds.minX - margin);
  const originY = Math.floor(bounds.minY - margin);
  const width = Math.max(2, Math.ceil(bounds.maxX + margin) - originX);
  const height = Math.max(2, Math.ceil(bounds.maxY + margin) - originY);
  const shift = [-originX, -originY];

  const compId = `group-${groupLayer.id}`;
  const subtree = rootComp.layers.filter((l) => ids.has(l.id));

  const layers = subtree.map((layer) => {
    if (layer.id !== groupLayer.id) return layer;
    // The element keeps its geometry but loses its opacity, which moves out to
    // the wrapper so it applies to the composited group instead of to this one
    // layer. It also loses its parent, which stayed behind.
    return {
      ...layer,
      parentId: null,
      rebased: shift,
      // Flagged so verification looks for this element's opacity on the wrapper
      // instead of on the layer it was moved off.
      opacityHoisted: true,
      transform: {
        ...layer.transform,
        position: shiftTrack(layer.absolute || layer.transform.position, shift),
        opacity: { static: 100 },
      },
    };
  });

  return {
    comp: {
      id: compId,
      name: `${groupLayer.name} · group`,
      width,
      height,
      fps: rootComp.fps,
      duration: rootComp.duration,
      backgroundColor: { rgb: [0, 0, 0], a: 0 },
      camera: null,
      layers,
    },
    layer: {
      id: `${groupLayer.id}-group`,
      name: `${groupLayer.name} · faded`,
      parentId: groupLayer.parentId,
      kind: 'precomp',
      compId,
      tier: 'A',
      threeD: false,
      role: 'group-opacity',
      groupSourceId: groupLayer.id,
      inPoint: null,
      outPoint: null,
      transform: {
        anchorPoint: { static: [0, 0] },
        position: { static: [originX - (options.parentOffset?.[0] ?? 0), originY - (options.parentOffset?.[1] ?? 0)] },
        scale: { static: [100, 100] },
        // The whole point: the group's own opacity, applied once, to the
        // composited result.
        opacity: groupLayer.transform.opacity,
        rotation: { static: 0 },
      },
      blendMode: groupLayer.blendMode || null,
      effects: [],
    },
    shift,
    size: [width, height],
    lifted: ids.size,
  };
}

function shiftTrack(track, shift) {
  if (!track) return track;
  if (track.keys === undefined) {
    return { ...track, static: track.static.map((v, i) => (i < 2 ? v + shift[i] : v)) };
  }
  return {
    ...track,
    keys: track.keys.map((key) => ({
      ...key,
      v: key.v.map((v, i) => (i < 2 ? v + shift[i] : v)),
    })),
  };
}
