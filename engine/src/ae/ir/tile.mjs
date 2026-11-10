// A repeating CSS background, rebuilt with After Effects' Motion Tile.
//
// `background-repeat` is the one CSS background feature that has an exact AND
// editable answer in After Effects, so it is simply done -- no decision, no
// fallback. Motion Tile repeats the layer's own content outward from a centre,
// which is the same grid CSS lays down from the background-position anchor.
//
// The catch is render order. Masks are applied BEFORE effects, so a mask on the
// layer clips the single tile and Motion Tile then repeats the clipped result:
// the padding box cannot be enforced that way. The tiled layer therefore goes
// into a composition the size of the padding box, which clips it by definition
// -- the same answer overflow:hidden and group opacity already use, and the
// layer inside stays a plain image layer with an effect anyone can re-time.
import { roundedRectPath } from './clip.mjs';

// Motion Tile's outputs are bounded; a tile far smaller than its box would
// otherwise ask for a number After Effects will not take.
const MAX_OUTPUT = 8000;

/** Which axes actually repeat, from the computed `background-repeat`. */
export function repeatAxes(value) {
  const parts = String(value || 'repeat').trim().split(/\s+/);
  if (parts.length === 1 && parts[0] === 'repeat-x') return { x: true, y: false };
  if (parts.length === 1 && parts[0] === 'repeat-y') return { x: false, y: true };
  const yes = (v) => v === 'repeat' || v === 'round' || v === 'space';
  return { x: yes(parts[0]), y: yes(parts.length > 1 ? parts[1] : parts[0]) };
}

/**
 * Motion Tile parameters that cover `box` with tiles of `tile`, laid out from
 * a first tile whose top-left sits at `offset` inside the box.
 *
 * Output Width and Height are percentages of the layer, measured symmetrically
 * about the tile's own centre -- so each one has to reach whichever box edge is
 * further away, not merely span the box.
 */
export function tileParams({ offset, tile, box, axes, natural }) {
  const centreX = offset[0] + tile[0] / 2;
  const centreY = offset[1] + tile[1] / 2;
  const halfX = Math.max(Math.abs(centreX), Math.abs(box[0] - centreX));
  const halfY = Math.max(Math.abs(centreY), Math.abs(box[1] - centreY));
  return {
    // In the layer's own source pixels, which is where Motion Tile measures.
    center: [natural[0] / 2, natural[1] / 2],
    tileWidth: 100,
    tileHeight: 100,
    outputWidth: axes.x ? Math.min(MAX_OUTPUT, Math.ceil((2 * halfX) / tile[0] * 100)) : 100,
    outputHeight: axes.y ? Math.min(MAX_OUTPUT, Math.ceil((2 * halfY) / tile[1] * 100)) : 100,
  };
}

/**
 * Lift a tiled background layer into a composition the size of its padding box.
 *
 * Returns the comp and the precomp layer that replaces it, or null when the
 * layer is not tiled after all.
 */
export function buildTileComp(bgLayer, options) {
  const { boxW, boxH, radii, fps, duration, index } = options;
  if (!bgLayer.tile) return null;
  const width = Math.max(1, Math.round(boxW));
  const height = Math.max(1, Math.round(boxH));

  // Inside the comp the layer keeps its fit, re-based to the padding box's own
  // origin: the comp IS the padding box, so the border offset it carried
  // outside is exactly what has to come off.
  const inner = {
    ...bgLayer,
    parentId: null,
    transform: {
      ...bgLayer.transform,
      position: { static: [0, 0] },
    },
    // The mask went with the box, and the box is now the comp's own edge.
    mask: null,
  };

  const comp = {
    id: `tile-${index}`,
    name: `${bgLayer.name} · tiled`,
    width,
    height,
    fps,
    duration,
    backgroundColor: { rgb: [0, 0, 0], a: 0 },
    layers: [inner],
  };

  const layer = {
    id: bgLayer.id,
    name: bgLayer.name,
    parentId: bgLayer.parentId,
    // The precomp stands where the background layer stood, so it inherits the
    // page-space position too -- without it a later clip pass rebases it from
    // parent-relative coordinates and the tiling lands outside the comp.
    absolute: bgLayer.absolute || null,
    kind: 'precomp',
    compId: comp.id,
    tier: 'A',
    role: 'background-tile',
    threeD: bgLayer.threeD,
    inPoint: bgLayer.inPoint,
    outPoint: bgLayer.outPoint,
    transform: {
      anchorPoint: { static: [0, 0] },
      position: { static: [options.originX, options.originY] },
      scale: { static: [100, 100] },
      opacity: { static: 100 },
      rotation: { static: 0 },
    },
    // Rounded corners still have to be cut, but now on the comp's output --
    // after the tiling rather than before it.
    mask: radii.some((r) => r > 0.01) ? roundedRectMask(width, height, radii) : null,
    blendMode: null,
    effects: [],
  };
  return { comp, layer };
}

function roundedRectMask(w, h, radii) {
  const path = roundedRectPath(w, h, radii);
  return {
    vertices: path.vertices,
    inTangents: path.inTangents,
    outTangents: path.outTangents,
    closed: true,
  };
}
