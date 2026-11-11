// DOM element state -> After Effects layer transform.
//
// The mapping rests on one choice: EVERY LAYER'S COORDINATE SPACE HAS ITS
// ORIGIN AT THE ELEMENT'S UNTRANSFORMED BORDER-BOX TOP-LEFT. Once that is
// fixed, the CSS model and the AE model line up term for term.
//
// CSS maps a local point p into the parent's space as
//     p_parent = layoutOffset + O + M_linear . (p - O) + M_translate
// where O is transform-origin and M is the element's own transform matrix.
//
// After Effects maps a layer point p into its parent layer's space as
//     p_parent = Position + R(rotation) . S(scale) . (p - AnchorPoint)
//
// Setting
//     AnchorPoint = O
//     Position    = layoutOffset + O + M_translate
//     R . S       = M_linear
// makes the two identical. Note what is NOT needed: no correction for the
// parent's anchor point, because AE subtracts the parent's anchor from points
// in the parent's space rather than shifting the space itself. (Verified
// against the host application by the self-check in ae/Design2AE.jsx, which
// refuses to import rather than trust this comment.)
//
// The residue is skew. AE's layer transform has no skew term, but CSS routinely
// produces one. decompose2d yields M_linear = R . SkewX(shear) . S, whereas AE
// offers only R . S -- so we push the skew into a Transform EFFECT, which acts
// on the layer's source before the layer transform. Since
//     R . SkewX(shear) . S  ==  R . S . SkewX(shear * sy / sx)
// the effect's skew is shear*sy/sx, and the composition is exact.
import {
  parseCssMatrix, identity, decompose2d, decompose3d, recompose2d, recompose3d,
  quaternionToEuler, eulerToMatrix, multiply, matrixError, isAffine2d, flipZ, DEG,
} from '../math/matrix.mjs';

// Measured against After Effects 26.3 on 2026-08-20, not assumed: setting an
// Orientation of [25,-40,15] and reading the rotated basis vectors back through
// an expression's toWorld() gives exactly Rx . Ry . Rz, to 4e-7. The per-axis
// matrices themselves are identical to the CSS ones.
export const DEFAULT_EULER_ORDER = 'XYZ';

/** Recompose the AE parameters back into a matrix, using AE's own model. */
export function aeToMatrix(t, eulerOrder = DEFAULT_EULER_ORDER) {
  const scale = identity();
  scale[0] = t.scale[0] / 100;
  scale[5] = t.scale[1] / 100;
  scale[10] = (t.scale[2] ?? 100) / 100;

  let linear;
  if (t.threeD) {
    linear = multiply(eulerToMatrix(t.orientation, eulerOrder), scale);
  } else {
    const r = (t.rotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const rot = [cos, sin, 0, 0, -sin, cos, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    linear = multiply(rot, scale);
  }
  if (t.skew && Math.abs(t.skew) > 1e-9) {
    const sk = identity();
    sk[4] = Math.tan((t.skew * Math.PI) / 180);
    linear = multiply(linear, sk);
  }
  return linear;
}

/**
 * Where an SVG shape's own coordinate system sits on the page.
 *
 * A path's `d` (and a circle's cx/cy, a polygon's points) is written in the
 * shape's USER space. The page reaches that space through the root's viewBox
 * mapping, so the layer's own space has to be user space too: origin at the
 * user-space origin, one layer unit per user unit, and the viewBox scale folded
 * into the layer's Scale. Positioning the layer at the shape's bounding box
 * instead (the HTML rule) puts every vertex off by the bbox offset, and moves
 * the whole path whenever its outline changes.
 *
 * Prefers the screen CTM the probe records with transforms off; falls back to
 * deriving it from the page box and getBBox() for older captures.
 */
export function svgUserFrame(entry) {
  if (!entry || !entry.present) return null;
  if (entry.user) return entry.user;
  if (!entry.bbox) return null;
  const [bx, by, bw, bh] = entry.bbox;
  const [X, Y, W, H] = entry.box;
  const sx = bw > 1e-9 ? W / bw : (bh > 1e-9 ? H / bh : 1);
  const sy = bh > 1e-9 ? H / bh : sx;
  return { origin: [X - bx * sx, Y - by * sy], scale: [sx, sy] };
}

/**
 * The transform-origin's reference point in user space. Computed
 * transform-origin is relative to the transform-box: the bbox for fill-box
 * (and content-box, which maps to it in SVG), the user-space origin for
 * view-box, the stroke box for stroke-box and border-box.
 */
function svgReferenceOrigin(entry) {
  const box = entry.style && entry.style.transformBox;
  const b = entry.bbox || [0, 0, 0, 0];
  if (box === 'fill-box' || box === 'content-box') return [b[0], b[1]];
  if (box === 'stroke-box' || box === 'border-box') {
    const half = (entry.style.strokeWidth || 0) / 2;
    return [b[0] - half, b[1] - half];
  }
  return [0, 0];
}

/**
 * The frame a layer's transform is expressed in, for this element and its
 * parent. HTML elements: layer space is the border box, in page pixels.
 * SVG shapes: layer space is user space (see svgUserFrame). `roles` gives the
 * element's and the parent's probe roles; without it everything is HTML.
 */
const SVG_SPACE = new Set(['svgShape', 'svgGroup', 'svgOther']);

/** Roles whose layer space is SVG user space rather than a CSS box. */
export const inSvgSpace = (role) => SVG_SPACE.has(role);

export function layerFrame(entry, parentEntry, roles) {
  const [X, Y] = entry.box;
  const self = roles && SVG_SPACE.has(roles.self) ? svgUserFrame(entry) : null;
  const parentPresent = parentEntry && parentEntry.present;
  const parent = parentPresent && roles && SVG_SPACE.has(roles.parent) ? svgUserFrame(parentEntry) : null;
  const ref = self ? svgReferenceOrigin(entry) : [0, 0];
  return {
    // Page position of the layer's (0,0) with every transform off.
    origin: self ? self.origin : [X, Y],
    // Page pixels per layer unit.
    unit: self ? self.scale : [1, 1],
    // The same two things for the parent layer's space.
    parentOrigin: parentPresent ? (parent ? parent.origin : [parentEntry.box[0], parentEntry.box[1]]) : [0, 0],
    parentUnit: parent ? parent.scale : [1, 1],
    // Where transform-origin is measured from, in layer units.
    reference: ref,
  };
}

/**
 * Compute the AE transform for one element on one frame.
 * `entry` and `parentEntry` are probe snapshots. Returns null when the element
 * is not present on this frame.
 */
export function aeTransformAt(entry, parentEntry, options = {}, roles = null) {
  if (!entry || !entry.present) return null;
  const eulerOrder = options.eulerOrder || DEFAULT_EULER_ORDER;
  const [X, Y, W, H] = entry.box;
  const frame = layerFrame(entry, parentEntry, roles);
  // The anchor, in layer units: transform-origin measured from its reference
  // box. For HTML the reference is the border box, so this is the origin as-is.
  const ox = frame.reference[0] + entry.origin[0];
  const oy = frame.reference[1] + entry.origin[1];
  const oz = entry.origin[2];
  const raw = entry.m ? entry.m.slice() : identity();
  const threeD = !isAffine2d(raw);

  // CSS z points TOWARD the viewer; After Effects z points away from it. A 3D
  // transform therefore has to be conjugated by diag(1, 1, -1, 1), which negates
  // the z translation and reverses rotation about x and y while leaving rotation
  // about z alone. Without it a rotated panel projects the wrong way through the
  // camera and lands tens of pixels from where the browser drew it.
  let m = threeD ? flipZ(raw) : raw;

  // `perspective()` used as a TRANSFORM FUNCTION (rather than `perspective:` on
  // an ancestor) leaves a projection term inside the element's own matrix, and
  // the browser serialises that matrix UN-normalised: m44 comes back as 1.0618
  // for a 22-degree tilt pushed 60px back.
  //
  // Neither obvious handling is right. Normalising by m44 IS the perspective
  // divide, so it bakes the projection into the layer -- scale comes out 0.9418
  // instead of 1 and the translation arrives pre-projected. Leaving it alone
  // mixes an un-normalised translation with a normalised rotation. The
  // projection has to be REMOVED instead, algebraically, and handed to the comp
  // camera which is the thing that can actually perform it:
  //
  //     M = P . M'   =>   M' = P^-1 . M
  //
  // with P^-1 the perspective matrix negated. What is left is an ordinary 3D
  // transform with m44 = 1, unit scale and a true 3D translation.
  let ownPerspective = null;
  let perspectivePoint = null;
  if (threeD) {
    const probe = decompose3d(m);
    if (probe && Math.abs(probe.perspective[2]) > 1e-12) {
      ownPerspective = Math.abs(1 / probe.perspective[2]);
      perspectivePoint = [X + ox, Y + oy];
      const pInv = identity();
      pInv[11] = -probe.perspective[2];
      m = multiply(pInv, m);
      if (Math.abs(m[15] - 1) > 1e-12 && Math.abs(m[15]) > 1e-12) {
        const w = m[15];
        m = m.map((v) => v / w);
      }
    }
  }
  const anchorZ = threeD ? -oz : oz;
  const [ux, uy] = frame.unit;
  const [kx, ky] = frame.parentUnit;

  const anchorPoint = [ox, oy, anchorZ];
  // The anchor's page position is origin + unit * (anchor + translation); the
  // parent's layer space is reached by undoing the parent's own origin and unit.
  const pageX = frame.origin[0] + ux * (ox + m[12]);
  const pageY = frame.origin[1] + uy * (oy + m[13]);
  const position = [
    (pageX - frame.parentOrigin[0]) / kx,
    (pageY - frame.parentOrigin[1]) / ky,
    anchorZ + m[14],
  ];
  // The same point without the parent subtraction: where this layer's anchor
  // sits in PAGE coordinates. Needed when a layer is lifted out of its parent
  // chain into a precomp, where it becomes a root layer and its position can no
  // longer be expressed relative to a parent that stayed behind.
  const absolutePosition = [pageX, pageY, anchorZ + m[14]];

  // Layer units to parent units: an SVG shape under an HTML parent carries the
  // viewBox scale in its own Scale; under another SVG shape the two cancel.
  const relX = ux / kx;
  const relY = uy / ky;
  if (Math.abs(relX - 1) > 1e-12 || Math.abs(relY - 1) > 1e-12) {
    m = m.slice();
    m[0] *= relX; m[4] *= relX; m[8] *= relX;
    m[1] *= relY; m[5] *= relY; m[9] *= relY;
  }

  const out = {
    anchorPoint,
    position,
    absolutePosition,
    size: [W, H],
    opacity: (entry.style.opacity ?? 1) * 100,
    threeD: false,
    skew: 0,
    skew3d: 0,
    rotation: 0,
    orientation: [0, 0, 0],
    scale: [100, 100, 100],
    error: 0,
  };

  if (!threeD) {
    const d = decompose2d(m);
    out.rotation = d.rotate;
    out.scale = [d.scale[0] * 100, d.scale[1] * 100, 100];
    if (Math.abs(d.shear) > 1e-9) {
      const ratio = Math.abs(d.scale[0]) > 1e-9 ? (d.scale[1] / d.scale[0]) : 1;
      out.skew = Math.atan(d.shear * ratio) * DEG;
    }
  } else {
    const d = decompose3d(m);
    if (!d) {
      out.error = Infinity;
      out.unrepresentable = 'singular-matrix';
      return out;
    }
    out.threeD = true;
    out.scale = [d.scale[0] * 100, d.scale[1] * 100, d.scale[2] * 100];
    out.orientation = quaternionToEuler(d.quaternion, eulerOrder);
    out.perspective = d.perspective;
    // `perspective()` used as a TRANSFORM FUNCTION, rather than `perspective:`
    // on an ancestor, leaves a projection term in the element's own matrix.
    // After Effects has no per-layer perspective -- but a camera at the right
    // distance produces exactly the same projection, so the term is lifted out
    // to the comp camera and the rest of the transform stays a normal 3D layer.
    // Real Claude Design output uses this spelling, and without handling it the
    // element would be rasterised along with everything parented to it.
    if (ownPerspective) {
      out.ownPerspective = ownPerspective;
      out.perspectivePoint = perspectivePoint;
    }
    out.skew3d = Math.hypot(d.skew[0], d.skew[1], d.skew[2]);
  }

  // Self-check: rebuild the matrix from what we are about to write into After
  // Effects and compare it to the browser's. This is the tier gate -- a layer
  // whose transform cannot be expressed in AE's model gets rasterised instead
  // of being written out wrong.
  // The border box's four corners, transformed, in the same page space as
  // absolutePosition. Every other geometric read here is anchor-relative, and
  // the anchor means different things per layer kind -- a text layer's sits on
  // the first baseline, an image layer's is measured in SOURCE pixels -- so
  // reconstructing a box from `position - anchor` is wrong for exactly the
  // layers whose boxes matter most. These corners are kind-independent.
  // Corners relative to the anchor, in page pixels. The page-space linear map
  // is the layer's own one scaled back up by the parent's unit.
  const ax = X - pageX + ux * m[12];
  const ay = Y - pageY + uy * m[13];
  const corners = [[ax, ay], [W + ax, ay], [W + ax, H + ay], [ax, H + ay]];
  const pm = [m[0] * kx, m[1] * ky, m[4] * kx, m[5] * ky];
  // Corners are in page pixels; the linear part maps LAYER units, so divide the
  // page offset back into layer units first.
  out.boxQuad = corners.map(([cx, cy]) => {
    const lx = cx / ux;
    const ly = cy / uy;
    return [
      absolutePosition[0] + pm[0] * lx + pm[2] * ly,
      absolutePosition[1] + pm[1] * lx + pm[3] * ly,
    ];
  });

  const rebuilt = aeToMatrix(out, eulerOrder);
  // Compare against the source with any projection term removed: that term is
  // the camera's job, not the layer's, so leaving it in would fail every
  // element that uses perspective() and rasterise it for no reason.
  // m has already had any projection term removed above, so it compares
  // directly against what After Effects will rebuild from these values.
  const source = m.slice();
  source[12] = 0; source[13] = 0; source[14] = 0;
  source[3] = 0; source[7] = 0; source[11] = 0; source[15] = 1;
  out.error = matrixError(source, rebuilt);
  // Express the error where it can actually be judged: as the worst corner
  // displacement in pixels for a box this size. A raw matrix-element threshold
  // is meaningless here, because getComputedStyle serialises matrix3d() to six
  // decimals -- a pure rotation comes back very slightly non-orthogonal, which
  // shows up as ~5e-7 of phantom skew. Measured as pixels on a 320x200 panel
  // that is 0.0003px, and rasterising a layer over it would be absurd.
  const diagonal = Math.hypot(W, H) || 1;
  out.pixelError = out.error * diagonal;
  out.skewPixelError = (out.skew3d || 0) * diagonal;
  return out;
}

/**
 * Walk every frame for one node and produce per-frame AE transforms plus the
 * visibility interval. `frames` is the capture result's frame list.
 */
export function analyzeNode(node, frames, indexById, options = {}) {
  const perFrame = [];
  let firstVisible = null;
  let lastVisible = null;
  let worstError = 0;
  let worstPixelError = 0;
  let worstSkewPixels = 0;
  let unrepresentable = null;
  const roles = {
    self: node.role,
    parent: node.parentId === null || !options.roleOf ? null : options.roleOf(node.parentId),
  };

  for (const frame of frames) {
    const entry = indexById(frame, node.id);
    const parentEntry = node.parentId === null ? null : indexById(frame, node.parentId);
    const t = aeTransformAt(entry, parentEntry, options, roles);
    perFrame.push({ time: frame.time, transform: t, entry });
    if (t) {
      const visible = entry.style.display !== 'none'
        && entry.style.visibility !== 'hidden'
        && (entry.style.opacity ?? 1) > 0.0001;
      if (visible) {
        if (firstVisible === null) firstVisible = frame.time;
        lastVisible = frame.time;
      }
      if (Number.isFinite(t.pixelError)) worstPixelError = Math.max(worstPixelError, t.pixelError);
      else worstPixelError = Infinity;
      if (Number.isFinite(t.error)) worstError = Math.max(worstError, t.error);
      if (Number.isFinite(t.skewPixelError)) worstSkewPixels = Math.max(worstSkewPixels, t.skewPixelError);
      if (t.unrepresentable) unrepresentable = t.unrepresentable;
    }
  }

  return {
    node,
    perFrame,
    firstVisible,
    lastVisible,
    worstError,
    worstPixelError,
    worstSkewPixels,
    unrepresentable,
    everPresent: perFrame.some((p) => p.transform !== null),
    everThreeD: perFrame.some((p) => p.transform && p.transform.threeD),
    everSkewed: perFrame.some((p) => p.transform && Math.abs(p.transform.skew) > 0.01),
  };
}

/**
 * Rotation angles can wrap: a spin that passes 180 degrees comes back as -179
 * from atan2, which After Effects would interpolate as a sudden reverse. Unwrap
 * the sequence so 0 -> 360 -> 720 stays monotonic and a full spin imports as a
 * full spin.
 */
export function unwrapAngles(values) {
  const out = values.slice();
  for (let i = 1; i < out.length; i += 1) {
    if (out[i] === null || out[i - 1] === null) continue;
    let delta = out[i] - out[i - 1];
    while (delta > 180) { out[i] -= 360; delta = out[i] - out[i - 1]; }
    while (delta < -180) { out[i] += 360; delta = out[i] - out[i - 1]; }
  }
  return out;
}
