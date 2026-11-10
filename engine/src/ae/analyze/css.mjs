// Parsers for the CSS values the probe captures as strings.
// Everything here returns numbers After Effects can key: colours as 0..255
// triples plus alpha, lengths as pixels, filters as named effect parameters.

const NUM = '[-+]?[0-9]*\\.?[0-9]+(?:e[-+]?[0-9]+)?';

/** rgb()/rgba()/color() -> { rgb: [r,g,b] 0..255, a: 0..1 } or null. */
export function parseColor(value) {
  if (!value || value === 'none' || value === 'transparent') return { rgb: [0, 0, 0], a: 0 };
  let m = new RegExp(`^rgba?\\(\\s*(${NUM})[,\\s]+(${NUM})[,\\s]+(${NUM})(?:\\s*[,/]\\s*(${NUM}%?))?\\s*\\)$`).exec(value.trim());
  if (m) {
    const a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4]));
    return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a };
  }
  // Hex never appears in a computed style -- Chromium always serialises rgb() --
  // but the parser is also handed authored values from gradient strings.
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (hex) {
    const h = hex[1];
    const expand = (c) => parseInt(c.length === 1 ? c + c : c, 16);
    if (h.length === 3 || h.length === 4) {
      return {
        rgb: [expand(h[0]), expand(h[1]), expand(h[2])],
        a: h.length === 4 ? expand(h[3]) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        rgb: [expand(h.slice(0, 2)), expand(h.slice(2, 4)), expand(h.slice(4, 6))],
        a: h.length === 8 ? expand(h.slice(6, 8)) / 255 : 1,
      };
    }
  }

  // Chromium serialises wide-gamut colours as color(srgb r g b / a) with 0..1 channels.
  m = new RegExp(`^color\\(\\s*srgb\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})(?:\\s*/\\s*(${NUM}))?\\s*\\)$`).exec(value.trim());
  if (m) {
    return {
      rgb: [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255],
      a: m[4] === undefined ? 1 : Number(m[4]),
    };
  }
  return null;
}

/**
 * Split a value into top-level `name(args)` calls, respecting nesting. A naive
 * /([a-z-]+)\(([^)]*)\)/ is wrong here: `drop-shadow(0px 10px 18px rgba(0,0,0,.5))`
 * terminates on the INNER rgba paren and silently loses the colour.
 */
export function splitFunctions(value) {
  const out = [];
  let i = 0;
  while (i < value.length) {
    const nameMatch = /^[a-zA-Z-]+/.exec(value.slice(i));
    if (!nameMatch) { i += 1; continue; }
    const name = nameMatch[0];
    let j = i + name.length;
    while (j < value.length && value[j] === ' ') j += 1;
    if (value[j] !== '(') { i += name.length; continue; }
    let depth = 0;
    let k = j;
    for (; k < value.length; k += 1) {
      if (value[k] === '(') depth += 1;
      else if (value[k] === ')') { depth -= 1; if (depth === 0) break; }
    }
    out.push({ name: name.toLowerCase(), args: value.slice(j + 1, k) });
    i = k + 1;
  }
  return out;
}

/** A computed `filter` string -> ordered list of { fn, args } with px/number args. */
export function parseFilter(value) {
  if (!value || value === 'none') return [];
  return splitFunctions(value).map(({ name: fn, args: raw }) => {
    const arg = raw.trim();
    if (fn === 'drop-shadow') {
      const color = parseColor((arg.match(/rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8}/) || [])[0] || 'rgb(0,0,0)');
      const lengths = (arg.match(/-?[\d.]+px/g) || []).map(parseFloat);
      return { fn, args: { dx: lengths[0] || 0, dy: lengths[1] || 0, blur: lengths[2] || 0, color } };
    }
    const n = parseFloat(arg);
    return {
      fn,
      args: {
        value: arg.endsWith('%') ? n / 100 : n,
        unit: arg.endsWith('px') ? 'px' : (arg.endsWith('deg') ? 'deg' : 'number'),
      },
    };
  });
}

/** `box-shadow` -> list of { inset, dx, dy, blur, spread, color }. */
export function parseBoxShadow(value) {
  if (!value || value === 'none') return [];
  // Split on commas that are not inside rgb()/rgba().
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '(') depth += 1;
    else if (value[i] === ')') depth -= 1;
    else if (value[i] === ',' && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start));
  return parts.map((part) => {
    const inset = /\binset\b/.test(part);
    const color = parseColor((part.match(/rgba?\([^)]*\)/) || [])[0] || '');
    const lengths = (part.match(/-?[\d.]+px/g) || []).map(parseFloat);
    return { inset, dx: lengths[0] || 0, dy: lengths[1] || 0, blur: lengths[2] || 0, spread: lengths[3] || 0, color };
  }).filter((s) => s.color);
}

/** A border-radius corner value ("18px" or "20px 10px") -> [rx, ry] in px. */
export function parseRadius(value, boxW, boxH) {
  if (!value) return [0, 0];
  const parts = String(value).trim().split(/\s+/);
  const toPx = (v, basis) => (String(v).endsWith('%') ? (parseFloat(v) / 100) * basis : parseFloat(v) || 0);
  const rx = toPx(parts[0], boxW);
  const ry = parts.length > 1 ? toPx(parts[1], boxH) : rx;
  return [rx, ry];
}

/** `stroke-dasharray` -> array of px lengths (Chromium serialises as "10px, 4px"). */
export function parseDashArray(value) {
  if (!value || value === 'none') return [];
  return value.split(/[,\s]+/).map(parseFloat).filter(Number.isFinite);
}

/** `line-height` computed value -> px, resolving "normal" against the font size. */
export function parseLineHeight(value, fontSize) {
  if (!value || value === 'normal') return fontSize * 1.2;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fontSize * 1.2;
}

/** CSS font-family list -> the first concrete family name. */
export function primaryFontFamily(value) {
  if (!value) return null;
  const first = value.split(',')[0].trim();
  return first.replace(/^["']|["']$/g, '') || null;
}

const CSS_BLEND_TO_AE = {
  normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY',
  darken: 'DARKEN', lighten: 'LIGHTEN', 'color-dodge': 'CLASSIC_COLOR_DODGE',
  'color-burn': 'CLASSIC_COLOR_BURN', 'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT',
  difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE', saturation: 'SATURATION',
  color: 'COLOR', luminosity: 'LUMINOSITY', 'plus-lighter': 'ADD',
};

export function blendModeToAe(value) {
  return CSS_BLEND_TO_AE[String(value || 'normal').toLowerCase()] || null;
}
