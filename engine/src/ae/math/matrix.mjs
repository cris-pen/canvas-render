// CSS transform matrices <-> After Effects layer transforms.
//
// Storage is a flat 16-element array in the SAME order CSS matrix3d() uses
// (column-major), so parsing and serialising are memcpy-shaped and there is one
// less convention to get wrong:
//
//     m[0..3]   = m11 m12 m13 m14   (basis vector for x, plus its perspective term)
//     m[4..7]   = m21 m22 m23 m24
//     m[8..11]  = m31 m32 m33 m34
//     m[12..15] = m41 m42 m43 m44   (translation, plus w)
//
// A point is transformed as
//     x' = m11*x + m21*y + m31*z + m41
//     y' = m12*x + m22*y + m32*z + m42
//     z' = m13*x + m23*y + m33*z + m43
//     w' = m14*x + m24*y + m34*z + m44
//
// getComputedStyle().transform only ever yields "none", "matrix(...)" or
// "matrix3d(...)" -- the browser has already resolved every function, keyword
// and percentage for us -- so those three are the only inputs we must parse.

const EPS = 1e-9;
export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

export function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function isIdentity(m, tol = 1e-6) {
  const id = identity();
  for (let i = 0; i < 16; i += 1) if (Math.abs(m[i] - id[i]) > tol) return false;
  return true;
}

/** Parse a computed `transform` value. Returns the identity for "none". */
export function parseCssMatrix(value) {
  if (!value || value === 'none') return identity();
  const m3 = /^matrix3d\(([^)]+)\)$/.exec(value.trim());
  if (m3) {
    const parts = m3[1].split(',').map((s) => Number(s.trim()));
    if (parts.length === 16 && parts.every(Number.isFinite)) return parts;
    return identity();
  }
  const m2 = /^matrix\(([^)]+)\)$/.exec(value.trim());
  if (m2) {
    const p = m2[1].split(',').map((s) => Number(s.trim()));
    if (p.length === 6 && p.every(Number.isFinite)) {
      const [a, b, c, d, e, f] = p;
      return [a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1];
    }
  }
  return identity();
}

/** a then b, i.e. the matrix equivalent to applying `a` and then `b`. */
export function multiply(b, a) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += b[k * 4 + row] * a[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function transformPoint(m, x, y, z = 0) {
  const px = m[0] * x + m[4] * y + m[8] * z + m[12];
  const py = m[1] * x + m[5] * y + m[9] * z + m[13];
  const pz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const pw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (Math.abs(pw) > EPS && Math.abs(pw - 1) > EPS) return [px / pw, py / pw, pz / pw];
  return [px, py, pz];
}

export function translationOf(m) {
  return [m[12], m[13], m[14]];
}

/** True when the matrix has no z, no perspective and no z-rotation component. */
export function isAffine2d(m, tol = 1e-6) {
  return (
    Math.abs(m[2]) < tol && Math.abs(m[3]) < tol &&
    Math.abs(m[6]) < tol && Math.abs(m[7]) < tol &&
    Math.abs(m[8]) < tol && Math.abs(m[9]) < tol &&
    Math.abs(m[10] - 1) < tol && Math.abs(m[11]) < tol &&
    Math.abs(m[14]) < tol && Math.abs(m[15] - 1) < tol
  );
}

/**
 * Decompose the 2x2 linear part of a 2D matrix into rotation, scale and an x
 * skew, following the CSS Transforms recomposition order
 *     M = Translate . Rotate . SkewX . Scale
 * so that recompose2d() is an exact inverse.
 */
export function decompose2d(m) {
  let row0x = m[0];
  let row0y = m[1];
  let row1x = m[4];
  let row1y = m[5];

  let scaleX = Math.hypot(row0x, row0y);
  if (scaleX > EPS) { row0x /= scaleX; row0y /= scaleX; }

  let shear = row0x * row1x + row0y * row1y;
  row1x -= row0x * shear;
  row1y -= row0y * shear;

  let scaleY = Math.hypot(row1x, row1y);
  if (scaleY > EPS) { row1x /= scaleY; row1y /= scaleY; shear /= scaleY; }

  // A negative determinant means a reflection; fold it into scaleX so the
  // rotation stays a true rotation.
  if (row0x * row1y - row0y * row1x < 0) {
    row0x = -row0x; row0y = -row0y;
    scaleX = -scaleX;
    shear = -shear;
  }

  return {
    translate: [m[12], m[13]],
    rotate: Math.atan2(row0y, row0x) * DEG,
    scale: [scaleX, scaleY],
    skewX: Math.atan(shear) * DEG,
    shear,
  };
}

export function recompose2d({ translate, rotate, scale, shear }) {
  const r = rotate * RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const [sx, sy] = scale;
  // Rotate . SkewX . Scale
  const a = cos * sx;
  const b = sin * sx;
  const c = sy * (cos * shear - sin);
  const d = sy * (sin * shear + cos);
  return [a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, translate[0], translate[1], 0, 1];
}

// ---------------------------------------------------------------------------
// Full 3D decomposition (Unmatrix, Graphics Gems II / CSS Transforms Level 2).
// ---------------------------------------------------------------------------

function v3Length(v) { return Math.hypot(v[0], v[1], v[2]); }
function v3Normalize(v) {
  const len = v3Length(v);
  return len > EPS ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}
function v3Dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function v3Cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function v3Combine(a, b, ascl, bscl) {
  return [a[0] * ascl + b[0] * bscl, a[1] * ascl + b[1] * bscl, a[2] * ascl + b[2] * bscl];
}

/**
 * Decompose a full 4x4 into perspective, translation, scale, skew and a
 * rotation quaternion. Returns null for a singular matrix.
 */
export function decompose3d(matrix) {
  const m = matrix.slice();
  if (Math.abs(m[15]) < EPS) return null;
  for (let i = 0; i < 16; i += 1) m[i] /= m[15];

  // Perspective lives in the 4th row of the transposed sense: m14, m24, m34.
  const perspectiveMatrix = m.slice();
  perspectiveMatrix[3] = 0; perspectiveMatrix[7] = 0; perspectiveMatrix[11] = 0;
  perspectiveMatrix[15] = 1;
  if (Math.abs(determinant4(perspectiveMatrix)) < EPS) return null;

  let perspective = [0, 0, 0, 1];
  if (Math.abs(m[3]) > EPS || Math.abs(m[7]) > EPS || Math.abs(m[11]) > EPS) {
    const rhs = [m[3], m[7], m[11], m[15]];
    const inv = invert4(transpose4(perspectiveMatrix));
    if (!inv) return null;
    perspective = [
      inv[0] * rhs[0] + inv[4] * rhs[1] + inv[8] * rhs[2] + inv[12] * rhs[3],
      inv[1] * rhs[0] + inv[5] * rhs[1] + inv[9] * rhs[2] + inv[13] * rhs[3],
      inv[2] * rhs[0] + inv[6] * rhs[1] + inv[10] * rhs[2] + inv[14] * rhs[3],
      inv[3] * rhs[0] + inv[7] * rhs[1] + inv[11] * rhs[2] + inv[15] * rhs[3],
    ];
  }

  const translate = [m[12], m[13], m[14]];

  const row = [
    [m[0], m[1], m[2]],
    [m[4], m[5], m[6]],
    [m[8], m[9], m[10]],
  ];

  const scale = [0, 0, 0];
  const skew = [0, 0, 0]; // xy, xz, yz

  scale[0] = v3Length(row[0]);
  row[0] = v3Normalize(row[0]);

  skew[0] = v3Dot(row[0], row[1]);
  row[1] = v3Combine(row[1], row[0], 1, -skew[0]);
  scale[1] = v3Length(row[1]);
  row[1] = v3Normalize(row[1]);
  if (scale[1] > EPS) skew[0] /= scale[1];

  skew[1] = v3Dot(row[0], row[2]);
  row[2] = v3Combine(row[2], row[0], 1, -skew[1]);
  skew[2] = v3Dot(row[1], row[2]);
  row[2] = v3Combine(row[2], row[1], 1, -skew[2]);
  scale[2] = v3Length(row[2]);
  row[2] = v3Normalize(row[2]);
  if (scale[2] > EPS) { skew[1] /= scale[2]; skew[2] /= scale[2]; }

  // Left-handed coordinate system means one axis is flipped.
  if (v3Dot(row[0], v3Cross(row[1], row[2])) < 0) {
    for (let i = 0; i < 3; i += 1) {
      scale[i] = -scale[i];
      row[i] = [-row[i][0], -row[i][1], -row[i][2]];
    }
  }

  // Rotation matrix -> quaternion (Shepperd's method, numerically stable).
  const m00 = row[0][0], m01 = row[0][1], m02 = row[0][2];
  const m10 = row[1][0], m11 = row[1][1], m12 = row[1][2];
  const m20 = row[2][0], m21 = row[2][1], m22 = row[2][2];
  const trace = m00 + m11 + m22;
  let quaternion;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    quaternion = [(m12 - m21) / s, (m20 - m02) / s, (m01 - m10) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    quaternion = [0.25 * s, (m01 + m10) / s, (m20 + m02) / s, (m12 - m21) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    quaternion = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m20 - m02) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    quaternion = [(m20 + m02) / s, (m12 + m21) / s, 0.25 * s, (m01 - m10) / s];
  }

  return { perspective, translate, scale, skew, quaternion, rotationRows: row };
}

function transpose4(m) {
  return [
    m[0], m[4], m[8], m[12],
    m[1], m[5], m[9], m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15],
  ];
}

export function determinant4(m) {
  const [
    a00, a01, a02, a03,
    a10, a11, a12, a13,
    a20, a21, a22, a23,
    a30, a31, a32, a33,
  ] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
}

export function invert4(m) {
  const det = determinant4(m);
  if (Math.abs(det) < EPS) return null;
  const [
    a00, a01, a02, a03,
    a10, a11, a12, a13,
    a20, a21, a22, a23,
    a30, a31, a32, a33,
  ] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const id = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * id,
    (a02 * b10 - a01 * b11 - a03 * b09) * id,
    (a31 * b05 - a32 * b04 + a33 * b03) * id,
    (a22 * b04 - a21 * b05 - a23 * b03) * id,
    (a12 * b08 - a10 * b11 - a13 * b07) * id,
    (a00 * b11 - a02 * b08 + a03 * b07) * id,
    (a32 * b02 - a30 * b05 - a33 * b01) * id,
    (a20 * b05 - a22 * b02 + a23 * b01) * id,
    (a10 * b10 - a11 * b08 + a13 * b06) * id,
    (a01 * b08 - a00 * b10 - a03 * b06) * id,
    (a30 * b04 - a31 * b02 + a33 * b00) * id,
    (a21 * b02 - a20 * b04 - a23 * b00) * id,
    (a11 * b07 - a10 * b09 - a12 * b06) * id,
    (a00 * b09 - a01 * b07 + a02 * b06) * id,
    (a31 * b01 - a30 * b03 - a32 * b00) * id,
    (a20 * b03 - a21 * b01 + a22 * b00) * id,
  ];
}

export function quaternionToMatrix(q) {
  const [x, y, z, w] = q;
  const m = identity();
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y + z * w);
  m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w);
  m[5] = 1 - 2 * (x * x + z * z);
  m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w);
  m[9] = 2 * (y * z - x * w);
  m[10] = 1 - 2 * (x * x + y * y);
  return m;
}

/**
 * Euler angles, in degrees, for a rotation quaternion, under an explicit
 * composition order. `order` names the sequence in which the per-axis matrices
 * are MULTIPLIED (left to right), so 'ZYX' means R = Rz . Ry . Rx and therefore
 * the X rotation is applied to the geometry first.
 *
 * After Effects' own convention is confirmed empirically by tools/ae-probe.jsx
 * rather than assumed here; the emitter passes whatever the probe reports.
 */
/**
 * Euler angles, in degrees, for a rotation quaternion, under an explicit
 * composition order. The order names the sequence in which the per-axis
 * matrices are MULTIPLIED left to right, so 'ZYX' means R = Rz . Ry . Rx and
 * therefore the X rotation is applied to the geometry first.
 *
 * All six Tait-Bryan orders are supported because After Effects' own convention
 * for its Orientation triple is not documented, and the only honest way to find
 * it is to try each one against the running application. Every order is checked
 * for self-consistency against eulerToMatrix in the test suite.
 */
export function quaternionToEuler(q, order = 'ZYX') {
  const m = quaternionToMatrix(q);
  // Column-major accessor: e(row, col), both 0-indexed.
  const e = (row, col) => m[col * 4 + row];
  const NEAR_ONE = 1 - 1e-9;
  let x; let y; let z;
  switch (order) {
    case 'XYZ':
      y = Math.asin(clamp(e(0, 2), -1, 1));
      if (Math.abs(e(0, 2)) < NEAR_ONE) { x = Math.atan2(-e(1, 2), e(2, 2)); z = Math.atan2(-e(0, 1), e(0, 0)); }
      else { x = Math.atan2(e(2, 1), e(1, 1)); z = 0; }
      break;
    case 'YXZ':
      x = Math.asin(-clamp(e(1, 2), -1, 1));
      if (Math.abs(e(1, 2)) < NEAR_ONE) { y = Math.atan2(e(0, 2), e(2, 2)); z = Math.atan2(e(1, 0), e(1, 1)); }
      else { y = Math.atan2(-e(2, 0), e(0, 0)); z = 0; }
      break;
    case 'ZXY':
      x = Math.asin(clamp(e(2, 1), -1, 1));
      if (Math.abs(e(2, 1)) < NEAR_ONE) { y = Math.atan2(-e(2, 0), e(2, 2)); z = Math.atan2(-e(0, 1), e(1, 1)); }
      else { y = 0; z = Math.atan2(e(1, 0), e(0, 0)); }
      break;
    case 'ZYX':
      y = Math.asin(-clamp(e(2, 0), -1, 1));
      if (Math.abs(e(2, 0)) < NEAR_ONE) { x = Math.atan2(e(2, 1), e(2, 2)); z = Math.atan2(e(1, 0), e(0, 0)); }
      else { x = Math.atan2(-e(1, 2), e(1, 1)); z = 0; }
      break;
    case 'YZX':
      z = Math.asin(clamp(e(1, 0), -1, 1));
      if (Math.abs(e(1, 0)) < NEAR_ONE) { x = Math.atan2(-e(1, 2), e(1, 1)); y = Math.atan2(-e(2, 0), e(0, 0)); }
      else { x = 0; y = Math.atan2(e(0, 2), e(2, 2)); }
      break;
    case 'XZY':
      z = Math.asin(-clamp(e(0, 1), -1, 1));
      if (Math.abs(e(0, 1)) < NEAR_ONE) { x = Math.atan2(e(2, 1), e(1, 1)); y = Math.atan2(e(0, 2), e(0, 0)); }
      else { x = Math.atan2(-e(1, 2), e(2, 2)); y = 0; }
      break;
    default:
      throw new Error(`unsupported euler order: ${order}`);
  }
  return [x * DEG, y * DEG, z * DEG];
}

export const EULER_ORDERS = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];

export function eulerToMatrix([xDeg, yDeg, zDeg], order = 'ZYX') {
  const R = { X: rotationX(xDeg * RAD), Y: rotationY(yDeg * RAD), Z: rotationZ(zDeg * RAD) };
  const [a, b, c] = order.split('');
  // multiply(b, a) is "apply a then b", so this builds Ra . Rb . Rc.
  return multiply(R[a], multiply(R[b], R[c]));
}

/**
 * Conjugate a transform by a z-axis flip: F . M . F with F = diag(1,1,-1,1).
 * CSS z points TOWARD the viewer and After Effects' z points away, so a 3D
 * transform crossing between them needs this. It negates the z translation and
 * reverses rotations about x and y, leaving rotation about z alone.
 */
export function flipZ(m) {
  const F = identity();
  F[10] = -1;
  return multiply(F, multiply(m, F));
}

function rotationX(r) {
  const c = Math.cos(r); const s = Math.sin(r);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}
function rotationY(r) {
  const c = Math.cos(r); const s = Math.sin(r);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}
function rotationZ(r) {
  const c = Math.cos(r); const s = Math.sin(r);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** Recompose a 3D decomposition back into a matrix; the inverse of decompose3d. */
export function recompose3d({ perspective, translate, scale, skew, quaternion }) {
  let m = identity();
  if (perspective) {
    m[3] = perspective[0]; m[7] = perspective[1];
    m[11] = perspective[2]; m[15] = perspective[3];
  }
  const t = identity();
  t[12] = translate[0]; t[13] = translate[1]; t[14] = translate[2];
  m = multiply(m, t);
  m = multiply(m, quaternionToMatrix(quaternion));

  if (Math.abs(skew[2]) > EPS) { const s = identity(); s[9] = skew[2]; m = multiply(m, s); }
  if (Math.abs(skew[1]) > EPS) { const s = identity(); s[8] = skew[1]; m = multiply(m, s); }
  if (Math.abs(skew[0]) > EPS) { const s = identity(); s[4] = skew[0]; m = multiply(m, s); }

  const sc = identity();
  sc[0] = scale[0]; sc[5] = scale[1]; sc[10] = scale[2];
  return multiply(m, sc);
}

/** Largest absolute element-wise difference; our universal fidelity metric. */
export function matrixError(a, b) {
  let worst = 0;
  for (let i = 0; i < 16; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}
