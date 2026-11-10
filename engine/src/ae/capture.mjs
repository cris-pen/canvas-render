// Capture a scene for After Effects: every element's geometry, style and text
// at every frame, recorded by the design-to-ae probe.
//
// Loading goes through Canvas Render's own path, so anything that renders also
// converts: the real Claude Design runtime (support.js, x-import, React and
// Babel), the project origin, the CDN cache, and the exportable-video stage,
// which is seeked by its own event rather than left to play. Plain pages run on
// the virtual clock exactly as in design-to-ae.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wireContext } from '../browser.mjs';
import { frameTime, frameCount } from '../rates.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLOCK = readFileSync(path.join(here, '..', 'clock.js'), 'utf8');
const DRIVER = readFileSync(path.join(here, '..', 'driver.js'), 'utf8');
const PROBE = readFileSync(path.join(here, 'capture', 'probe.js'), 'utf8');
const CANVAS = readFileSync(path.join(here, 'capture', 'canvas.js'), 'utf8');

// One clock serves both: the probe looks for __d2aeClock, the driver for __crClock.
export const INIT = `${CLOCK}\nwindow.__crClock.install();\nwindow.__d2aeClock = window.__crClock;\n${CANVAS}\n${PROBE}\n${DRIVER}`;

// A Claude Design stage is <svg data-om-...><foreignObject><div>…; the layers
// are everything inside that div, measured in the stage's own pixels because
// the driver pins the stage at the origin with no scale.
export const STAGE_ROOT = '[data-om-exportable-video-with-duration-secs] > foreignObject > *';

function cancelled() {
  const e = new Error('Cancelled.');
  e.code = 'CANCELLED';
  return e;
}

/**
 * Returns the same capture object design-to-ae's captureAll() did, so the IR
 * builder and emitter take it unchanged.
 */
export async function captureScene({ browser, roots, scene, info, rate, rasterDir, maxSeconds = 120, onFrame, signal }) {
  const stage = info.mode === 'stage';
  const { width, height } = info;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    reducedMotion: 'no-preference',
    colorScheme: 'light',
  });
  await wireContext(context, roots);
  await context.addInitScript({ content: INIT });
  const page = await context.newPage();

  const consoleErrors = [];
  const graphicsWarnings = [];
  const fontFiles = [];
  const fontStylesheets = [];
  const assetFiles = new Map();
  page.on('response', async (response) => {
    try {
      const url = response.url();
      const type = response.headers()['content-type'] || '';
      const isFont = /^https:\/\/fonts\.gstatic\.com\//.test(url) || /font\/(woff2?|ttf|otf)/.test(type) || /\.(woff2?|ttf|otf)(\?|$)/i.test(url);
      if (/^https:\/\/fonts\.googleapis\.com\/css/.test(url) && response.ok() && !fontStylesheets.includes(url)) fontStylesheets.push(url);
      if (!response.ok()) return;
      if (isFont) { fontFiles.push({ url, contentType: type, bytes: await response.body() }); return; }
      if (!/^image\//.test(type) && !/\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|$)/i.test(url)) return;
      if (!assetFiles.has(url)) assetFiles.set(url, { url, contentType: type, bytes: await response.body() });
    } catch { /* a redirect or aborted request has no body */ }
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error') { consoleErrors.push(text); return; }
    if ((/^WebGL: (INVALID|CONTEXT_LOST)/.test(text) || /shader|program not/i.test(text)) && !graphicsWarnings.includes(text)) graphicsWarnings.push(text);
  });

  try {
    await page.goto(scene.url, { waitUntil: 'load', timeout: 90000 });
    const ready = await page.evaluate((o) => window.__cr.ready(o), { transparent: false });
    if (ready.mode !== info.mode) throw new Error(`The scene loaded as a ${ready.mode} this time, not a ${info.mode}. Try again.`);
    const root = stage ? STAGE_ROOT : null;
    await page.evaluate(async ({ r, st }) => {
      if (st) await window.__cr.seek(0); else window.__d2ae.seek(0);
      window.__d2ae.index(r);
    }, { r: root, st: stage });

    const seconds = Math.min(info.duration, maxSeconds);
    const total = frameCount(seconds, rate);
    const frames = [];
    let nodes = await page.evaluate(() => window.__d2ae.nodes());
    const sequences = new Map();
    for (let f = 0; f < total; f += 1) {
      if (signal && signal.aborted) throw cancelled();
      const ms = frameTime(f, rate) * 1000;
      const r = await page.evaluate(async ({ t, n, st, wantCanvas }) => {
        window.__d2ae.setGeneration(n);
        // A stage is moved by its own seek event; a page by the clock, with
        // design-to-ae's handling of transitions started from script.
        if (st) await window.__cr.seek(t); else window.__d2ae.seek(t);
        const canvases = wantCanvas ? window.__d2ae.canvasFrames() : [];
        window.__d2ae.index();
        const changed = window.__d2ae.lastChanged();
        return { changed, canvases, nodes: changed ? window.__d2ae.nodes() : null, snapshot: window.__d2ae.snapshot() };
      }, { t: ms, n: f, st: stage, wantCanvas: !!rasterDir });
      if (r.changed && r.nodes) nodes = r.nodes;
      for (const shot of r.canvases || []) {
        let seq = sequences.get(shot.id);
        if (!seq) {
          seq = { id: shot.id, dir: path.join(rasterDir, `canvas-${shot.id}`), width: shot.width, height: shot.height, files: [], distinct: new Set() };
          mkdirSync(seq.dir, { recursive: true });
          sequences.set(shot.id, seq);
        }
        const bytes = Buffer.from(shot.url.split(',')[1], 'base64');
        const file = path.join(seq.dir, `${String(f).padStart(5, '0')}.png`);
        writeFileSync(file, bytes);
        seq.files.push(file);
        seq.distinct.add(bytes.length);
      }
      frames.push({ frame: f, time: ms / 1000, changed: r.changed, nodes, elements: r.snapshot });
      if (onFrame) onFrame(f + 1, total);
    }

    const urls = new Set();
    for (const fr of frames) {
      for (const e of fr.elements) {
        if (!e.present) continue;
        if (e.src) urls.add(e.src);
        const bg = e.style && e.style.backgroundImage;
        if (bg && bg !== 'none') for (const m of bg.matchAll(/url\((['"]?)(.*?)\1\)/g)) urls.add(m[2]);
      }
    }
    const imageSizes = await page.evaluate(async (list) => {
      const out = {};
      await Promise.all(list.map((u) => new Promise((res) => {
        const img = new Image();
        img.onload = () => { out[u] = [img.naturalWidth, img.naturalHeight]; res(); };
        img.onerror = res;
        img.src = u;
      })));
      return out;
    }, [...urls]);

    const detected = await page.evaluate(() => {
      let end = 0; let infinite = false; let longest = 0; let count = 0;
      for (const anim of document.getAnimations()) {
        count += 1;
        const timing = anim.effect ? anim.effect.getComputedTiming() : null;
        if (!timing) continue;
        if (!Number.isFinite(timing.iterations)) {
          infinite = true;
          const dur = Number(timing.duration) || 0;
          longest = Math.max(longest, (Number(timing.delay) || 0) + (/alternate/i.test(String(timing.direction || '')) ? dur * 2 : dur));
          continue;
        }
        if (Number.isFinite(Number(timing.endTime))) end = Math.max(end, Number(timing.endTime));
      }
      return { endMs: end, infinite, longestLoopMs: longest, count };
    });

    return {
      nodes,
      frames,
      fps: rate.num / rate.den,
      duration: seconds,
      detected: { seconds: info.duration, infinite: detected.infinite, longestLoop: detected.longestLoopMs / 1000, animationCount: detected.count },
      truncated: seconds < info.duration,
      documentSize: await page.evaluate(() => window.__d2ae.documentSize()),
      animationTimings: await page.evaluate(() => window.__d2ae.animationTimings()),
      canvasSequences: sequences,
      fontFiles,
      fontStylesheets,
      assetFiles,
      imageSizes,
      warnings: await page.evaluate(() => ({ probe: window.__d2ae.warnings(), script: window.__crErrors || [] })),
      consoleErrors,
      graphicsWarnings,
    };
  } finally {
    await context.close().catch(() => {});
  }
}
