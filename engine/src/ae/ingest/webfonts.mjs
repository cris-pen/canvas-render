// Fetch installable font files for the webfonts a design uses.
//
// The browser downloads WOFF2, which is what the web wants and what macOS Font
// Book refuses to install. Google Fonts content-negotiates on User-Agent and
// serves the SAME faces as TrueType to clients it does not recognise -- so
// re-requesting the stylesheet with NO User-Agent yields .ttf URLs for exactly
// the families and weights the design used. No conversion library, no changes
// to the machine's Python or Node environment.
//
// Measured: a modern UA gives woff2, an old Safari UA gives woff, an ancient
// MSIE UA gives nothing usable, and no UA gives ttf.
const NO_UA = {};

/** Pull family names out of a fonts.googleapis.com stylesheet URL. */
export function familiesFromCssUrl(url) {
  const out = [];
  try {
    const parsed = new URL(url);
    for (const [key, value] of parsed.searchParams) {
      if (key !== 'family') continue;
      // "Instrument Serif:ital@0;1" -> "Instrument Serif"
      out.push(value.split(':')[0].replace(/\+/g, ' '));
    }
  } catch { /* not a URL we understand */ }
  return out;
}

/**
 * Returns [{ family, style, weight, url, bytes }] of TrueType faces.
 * Failures are returned as an empty list rather than thrown: missing installable
 * fonts degrade the import, they do not invalidate it.
 */
export async function fetchInstallableFonts(stylesheetUrls, log = () => {}) {
  const faces = [];
  const seen = new Set();
  for (const url of stylesheetUrls) {
    let css;
    try {
      const res = await fetch(url, { headers: NO_UA });
      if (!res.ok) continue;
      css = await res.text();
    } catch (err) {
      log(`could not re-request ${url}: ${err.message}`);
      continue;
    }

    // Each @font-face block carries the family, style and weight it belongs to.
    const blocks = css.split('@font-face').slice(1);
    for (const block of blocks) {
      const family = (block.match(/font-family:\s*'([^']+)'/) || [])[1];
      const style = (block.match(/font-style:\s*([a-z]+)/) || [])[1] || 'normal';
      const weight = (block.match(/font-weight:\s*(\d+)/) || [])[1] || '400';
      const src = (block.match(/url\((https:\/\/[^)]+\.ttf)\)/) || [])[1];
      if (!family || !src || seen.has(src)) continue;
      seen.add(src);
      try {
        const res = await fetch(src, { headers: NO_UA });
        if (!res.ok) continue;
        const bytes = Buffer.from(await res.arrayBuffer());
        faces.push({ family, style, weight, url: src, bytes });
      } catch (err) {
        log(`could not download ${src}: ${err.message}`);
      }
    }
  }
  return faces;
}

/** A filename a person can recognise in Font Book. */
export function faceFileName(face) {
  const family = face.family.replace(/[^A-Za-z0-9]+/g, '');
  const weight = face.weight === '400' ? '' : `-${face.weight}`;
  const italic = face.style === 'italic' ? '-Italic' : '';
  return `${family}${weight}${italic}.ttf`;
}
