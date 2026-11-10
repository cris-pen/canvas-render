// Lift a CSS perspective container's subtree into its own composition, centred
// on the perspective origin.
//
// Why this exists: CSS projects a 3D transform about `perspective-origin`;
// After Effects projects about the COMPOSITION CENTRE, and no camera placement
// changes that -- parking the camera elsewhere just slides the whole scene
// (measured: exactly cameraXY - compCentre). So when the two points differ,
// anything off the z = 0 plane drifts in proportion to its depth.
//
// A composition whose centre IS the perspective origin makes the two coincide.
// The subtree moves into it, a camera sits at its centre, and the precomp layer
// is placed back in the parent comp so the centre lands on the origin again.
// Inside, the projection is exact; outside, it is an ordinary 2D layer.
import { evaluate } from './track.mjs';

/** Every descendant of `rootId`, plus the root itself. */
export function collectSubtree(layers, rootId) {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const layer of layers) {
      if (layer.parentId !== null && ids.has(layer.parentId) && !ids.has(layer.id)) {
        ids.add(layer.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * The area the subtree occupies, in page coordinates, across the whole capture.
 * Sampled from the layers' own size and position tracks rather than the raw
 * frames so it stays correct after keyframe fitting.
 */
export function subtreeBounds(layers, ids, duration, fps) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const steps = Math.max(2, Math.round(duration * fps) + 1);
  for (const layer of layers) {
    if (!ids.has(layer.id)) continue;
    // boxSize covers every layer type; shape.size only exists on shapes, and
    // sizing a precomp from those alone leaves out all the text.
    const size = layer.boxSize || (layer.shape ? layer.shape.size : null);
    for (let i = 0; i < steps; i += 1) {
      const t = (i / (steps - 1)) * duration;
      const dims = size ? evaluate(size, t) : [0, 0];
      // The box's own page-space corner where it is known. `position - anchor`
      // is only the box corner for a plain shape: a text layer's anchor sits on
      // its BASELINE and an image layer's is measured in source pixels, so that
      // arithmetic sized -- and therefore placed -- every composition holding
      // text a whole ascent out.
      const origin = layer.boxOrigin ? evaluate(layer.boxOrigin, t) : null;
      let left;
      let top;
      if (origin) {
        [left, top] = origin;
      } else {
        const pos = evaluate(layer.absolute || layer.transform.position, t);
        if (!pos) continue;
        const anchor = evaluate(layer.transform.anchorPoint, t) || [0, 0];
        left = pos[0] - anchor[0];
        top = pos[1] - anchor[1];
      }
      minX = Math.min(minX, left);
      minY = Math.min(minY, top);
      maxX = Math.max(maxX, left + (dims[0] || 0));
      maxY = Math.max(maxY, top + (dims[1] || 0));
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Build the precomp. Returns { comp, layer } -- the new composition and the
 * layer that replaces the subtree in the parent comp -- or null when the
 * perspective origin already sits at the parent comp's centre, in which case a
 * precomp would add a layer of indirection for nothing.
 */
export function buildPerspectiveComp(rootComp, camera, options = {}) {
  const [px, py] = camera.point;
  const centred = Math.abs(px - rootComp.width / 2) < 1
    && Math.abs(py - rootComp.height / 2) < 1;
  if (centred) return null;

  const ids = collectSubtree(rootComp.layers, camera.id);
  const subtree = rootComp.layers.filter((l) => ids.has(l.id));
  if (!subtree.length) return null;

  const bounds = subtreeBounds(rootComp.layers, ids, rootComp.duration, rootComp.fps);
  if (!bounds) return null;

  // The comp has to be symmetric about the perspective origin, because that is
  // the whole point -- its centre must BE the origin. Margin covers the way a
  // perspective projection enlarges geometry that leans toward the viewer.
  const margin = options.margin ?? 0.35;
  const spanX = Math.max(px - bounds.minX, bounds.maxX - px);
  const spanY = Math.max(py - bounds.minY, bounds.maxY - py);
  const halfW = Math.ceil(spanX * (1 + margin)) + 2;
  const halfH = Math.ceil(spanY * (1 + margin)) + 2;
  const width = Math.max(2, halfW * 2);
  const height = Math.max(2, halfH * 2);

  // Page coordinates -> precomp coordinates.
  const shift = [halfW - px, halfH - py];

  const compId = `persp-${camera.id}`;
  const rootParent = subtree.find((l) => l.id === camera.id).parentId;

  const layers = subtree.map((layer) => {
    if (layer.id !== camera.id) return layer;
    // The container loses its parent (which stayed behind), so its position has
    // to become absolute inside the precomp rather than parent-relative.
    return {
      ...layer,
      parentId: null,
      // Recorded so verification knows this layer's position is no longer
      // parent-relative page space but absolute precomp space.
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
      name: `${rootComp.name} · perspective`,
      width,
      height,
      fps: rootComp.fps,
      duration: rootComp.duration,
      backgroundColor: { rgb: [0, 0, 0], a: 0 },
      camera: { ...camera, point: [halfW, halfH] },
      layers,
    },
    layer: {
      id: camera.id,
      name: `${camera.name} (3D)`,
      parentId: rootParent,
      kind: 'precomp',
      compId,
      tier: 'A',
      threeD: false,
      role: 'precomp',
      inPoint: null,
      outPoint: null,
      // Anchor at the precomp's centre, positioned so that centre lands back on
      // the perspective origin in the parent comp.
      transform: {
        anchorPoint: { static: [halfW, halfH] },
        position: { static: [px - (options.parentOffset?.[0] ?? 0), py - (options.parentOffset?.[1] ?? 0)] },
        scale: { static: [100, 100] },
        opacity: { static: 100 },
        rotation: { static: 0 },
      },
      blendMode: null,
      effects: [],
    },
    shift,
    size: [width, height],
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
