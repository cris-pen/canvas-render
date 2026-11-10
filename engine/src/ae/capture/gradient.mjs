// Rendering a CSS gradient to a bitmap, for when a person chooses fidelity over
// an editable ramp.
//
// After Effects' Gradient Ramp effect holds TWO stops and no per-stop alpha, so
// a four-stop gradient -- or one that fades out -- cannot be written as a ramp
// without losing something visible. The exact answer is a picture of the
// gradient, and the only thing that can draw a CSS gradient exactly is the
// browser that defines it, so it is asked to draw one.
//
// This is never done on its own initiative: `src/ir/decisions.mjs` puts the
// choice in front of a person first, because the bitmap that arrives is no
// longer a ramp anybody can re-colour.
import { launchBrowser } from '../../browser.mjs';

/**
 * Draw each gradient at its element's own size and return the PNG bytes.
 *
 * `specs` are `{ id, css, width, height }`. The scale factor matters: a ramp
 * resized up in After Effects should not go soft, so the bitmap is rendered at
 * the same device scale as the rest of the capture.
 */
export async function renderGradients(specs, options = {}) {
  const out = new Map();
  if (!specs.length) return out;
  const scale = options.deviceScaleFactor || 2;
  const browser = options.browser || await launchBrowser();
  const page = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: 64, height: 64 } });
  try {
    for (const spec of specs) {
      const w = Math.max(1, Math.round(spec.width));
      const h = Math.max(1, Math.round(spec.height));
      await page.setViewportSize({ width: w, height: h });
      // A bare div of exactly the element's box, painted with exactly the
      // computed background the element had. No borders, no radius: the layer
      // that receives this already carries those.
      await page.setContent(
        '<html><body style="margin:0;padding:0;background:transparent">'
        + `<div id="g" style="width:${w}px;height:${h}px;background-image:${spec.css}"></div>`
        + '</body></html>',
        { waitUntil: 'load' },
      );
      const el = await page.$('#g');
      const png = await el.screenshot({ omitBackground: true, type: 'png' });
      out.set(spec.id, { bytes: png, width: w * scale, height: h * scale, scale });
    }
  } finally {
    await page.close();
    if (!options.browser) await browser.close();
  }
  return out;
}
