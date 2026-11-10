// `overflow: hidden` -> a composition that actually clips.
//
// CSS clips an element's descendants to its PADDING box, with the inner
// border-radius. After Effects has no equivalent: parenting composes transforms
// and nothing else, so a child drawn outside its parent's bounds simply stays
// visible. The faithful equivalent is what a motion designer would do by hand --
// put the descendants in their own composition sized to the clip box, which
// clips them by definition, and mask that layer when the corners are round.
//
// The clipping element's OWN paint stays outside: a background and border are
// drawn normally and are not subject to the element's own overflow.
import { evaluate } from './track.mjs';
import { collectSubtree } from './precomp.mjs';

const CLIPPING = new Set(['hidden', 'clip', 'auto', 'scroll']);

export function clipsContent(style) {
  if (!style || !style.overflow) return false;
  return CLIPPING.has(style.overflow[0]) || CLIPPING.has(style.overflow[1]);
}

/** The padding box and its inner corner radii, from a probe snapshot. */
export function clipGeometry(entry) {
  const [x, y, w, h] = entry.box;
  const bw = entry.style.borderWidth || [0, 0, 0, 0];
  const [top, right, bottom, left] = bw.map((v) => v || 0);
  const radii = (entry.style.borderRadius || []).map((r) => parseFloat(r) || 0);
  // The inner radius is the outer radius less the border on that side; CSS
  // shrinks it exactly this way, and using the outer radius would round the
  // clip more than the design does.
  const inner = [
    Math.max(0, (radii[0] || 0) - Math.max(top, left)),
    Math.max(0, (radii[1] || 0) - Math.max(top, right)),
    Math.max(0, (radii[2] || 0) - Math.max(bottom, right)),
    Math.max(0, (radii[3] || 0) - Math.max(bottom, left)),
  ];
  return {
    origin: [x + left, y + top],
    size: [Math.max(1, w - left - right), Math.max(1, h - top - bottom)],
    radii: inner,
    borderOffset: [left, top],
  };
}

const KAPPA = 0.5522847498307936;

/**
 * A rounded rectangle as an AE mask path, spanning (0,0)..(w,h) with per-corner
 * radii in CSS order (top-left, top-right, bottom-right, bottom-left).
 */
export function roundedRectPath(w, h, radii) {
  const r = radii.map((v) => Math.max(0, Math.min(v, Math.min(w, h) / 2)));
  const [tl, tr, br, bl] = r;
  const vertices = [];
  const inTangents = [];
  const outTangents = [];
  const push = (v, i, o) => { vertices.push(v); inTangents.push(i); outTangents.push(o); };

  if (r.every((v) => v === 0)) {
    for (const v of [[0, 0], [w, 0], [w, h], [0, h]]) push(v, [0, 0], [0, 0]);
    return { vertices, inTangents, outTangents, closed: true };
  }

  // Two vertices per rounded corner, with tangents of length kappa*r pointing
  // along the edges -- the standard circular-arc approximation.
  push([tl, 0], [0, 0], [0, 0]);
  push([w - tr, 0], [0, 0], [tr * KAPPA, 0]);
  push([w, tr], [0, -tr * KAPPA], [0, 0]);
  push([w, h - br], [0, 0], [0, br * KAPPA]);
  push([w - br, h], [br * KAPPA, 0], [0, 0]);
  push([bl, h], [0, 0], [-bl * KAPPA, 0]);
  push([0, h - bl], [0, bl * KAPPA], [0, 0]);
  push([0, tl], [0, 0], [0, -tl * KAPPA]);
  outTangents[0] = [-tl * KAPPA, 0];
  return { vertices, inTangents, outTangents, closed: true };
}

/**
 * Does anything in the subtree actually leave the clip box? Clipping when
 * nothing escapes is a no-op that costs a composition, so it is skipped.
 */
function subtreeEscapes(layers, ids, geom, duration, fps) {
  const [cx, cy] = geom.origin;
  const [cw, ch] = geom.size;
  const steps = Math.max(2, Math.round(duration * fps) + 1);
  for (const layer of layers) {
    if (!ids.has(layer.id)) continue;
    for (let i = 0; i < steps; i += 1) {
      const t = (i / (steps - 1)) * duration;
      const pos = evaluate(layer.absolute, t);
      if (!pos) continue;
      const anchor = evaluate(layer.transform.anchorPoint, t) || [0, 0];
      const dims = layer.boxSize ? evaluate(layer.boxSize, t) : [0, 0];
      const left = pos[0] - anchor[0];
      const top = pos[1] - anchor[1];
      if (left < cx - 0.5 || top < cy - 0.5
        || left + (dims[0] || 0) > cx + cw + 0.5
        || top + (dims[1] || 0) > cy + ch + 0.5) return true;
    }
  }
  return false;
}

/**
 * Build the clipping composition for one element, or null when it is not worth
 * one. Returns { comp, layer } where `layer` replaces the subtree, parented to
 * the clipping element itself.
 */
export function buildClipComp(rootComp, clipper, geom, options = {}) {
  const ids = collectSubtree(rootComp.layers, clipper.id);
  ids.delete(clipper.id); // the clipper's own paint is NOT clipped by itself
  if (!ids.size) return null;

  const subtree = rootComp.layers.filter((l) => ids.has(l.id));
  // Rounded corners clip even when nothing overflows the RECTANGLE: a child
  // that exactly fills its parent still has its corners cut. Skipping the comp
  // whenever content fits the box therefore loses every rounded frame whose
  // content is flush with it -- which is most of them.
  const rounded = geom.radii.some((r) => r > 0.01);
  if (!rounded && !subtreeEscapes(rootComp.layers, ids, geom, rootComp.duration, rootComp.fps)) return null;

  const [cw, ch] = geom.size.map((v) => Math.max(1, Math.round(v)));
  const shift = [-geom.origin[0], -geom.origin[1]];
  const compId = `clip-${clipper.id}`;

  const layers = subtree.map((layer) => {
    // Only the clipper's DIRECT children lost their parent; deeper descendants
    // keep parents that came along, so their positions are already correct.
    if (layer.parentId !== clipper.id) return layer;
    return {
      ...layer,
      parentId: null,
      rebased: shift,
      transform: {
        ...layer.transform,
        position: shiftTrack(layer.absolute || layer.transform.position, shift),
      },
    };
  });

  return {
    comp: {
      id: compId,
      name: `${clipper.name} · clip`,
      width: cw,
      height: ch,
      fps: rootComp.fps,
      duration: rootComp.duration,
      backgroundColor: { rgb: [0, 0, 0], a: 0 },
      camera: null,
      layers,
    },
    layer: {
      id: `${clipper.id}-clip`,
      name: `${clipper.name} · contents`,
      parentId: clipper.id,
      kind: 'precomp',
      compId,
      tier: 'A',
      threeD: false,
      role: 'clip',
      inPoint: null,
      outPoint: null,
      transform: {
        anchorPoint: { static: [0, 0] },
        // Relative to the clipper's border-box origin, which is where a child's
        // position is measured from; the padding box starts inside the border.
        position: { static: geom.borderOffset.slice() },
        scale: { static: [100, 100] },
        opacity: { static: 100 },
        rotation: { static: 0 },
      },
      blendMode: null,
      effects: [],
      mask: geom.radii.some((r) => r > 0.01)
        ? roundedRectPath(cw, ch, geom.radii)
        : null,
    },
    shift,
    size: [cw, ch],
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
