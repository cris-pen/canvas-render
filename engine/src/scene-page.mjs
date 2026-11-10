// One scene loaded in a browser tab, ready to be moved to any time and captured.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { wireContext } from './browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLOCK = readFileSync(path.join(here, 'clock.js'), 'utf8');
const DRIVER = readFileSync(path.join(here, 'driver.js'), 'utf8');
const INIT = `${CLOCK}\nwindow.__crClock.install();\n${DRIVER}`;

export class ScenePage {
  /**
   * @param browser   Playwright Browser
   * @param roots     Map projectId -> folder, for serving project files
   * @param scene     { url, ... } from ingest
   * @param opts      { width, height, scale, transparent, plate }
   *                  plate: { css, replace } from plateCss(), or null
   *                  width/height: viewport in CSS px (the stage or page size)
   *                  scale: output pixels per CSS px
   */
  constructor(browser, roots, scene, opts) {
    this.browser = browser;
    this.roots = roots;
    this.scene = scene;
    this.opts = { width: 1280, height: 720, scale: 1, transparent: false, plate: null, ...opts };
    this.plateApplied = null;
    this.info = null;
    this.errors = [];
    this.timeMs = 0;
  }

  async open() {
    const o = this.opts;
    this.context = await this.browser.newContext({
      viewport: { width: Math.max(16, Math.round(o.width)), height: Math.max(16, Math.round(o.height)) },
      deviceScaleFactor: o.scale,
      colorScheme: 'light',
      reducedMotion: 'no-preference',
      serviceWorkers: 'block',
    });
    await wireContext(this.context, this.roots);
    await this.context.addInitScript({ content: INIT });
    this.page = await this.context.newPage();
    this.page.on('pageerror', (err) => { if (this.errors.length < 30) this.errors.push(String(err).slice(0, 400)); });
    this.page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error' && this.errors.length < 30 && !/favicon|Failed to load resource/.test(text)) this.errors.push(text.slice(0, 400));
      // A board whose code failed to load will never show a stage; stop waiting for one.
      if (/x-import: FAILED|dc-runtime.*(error|failed)/i.test(text)) this.page.evaluate(() => window.__cr && window.__cr.stopWaiting()).catch(() => {});
    });
    await this.load();
    return this.info;
  }

  async load() {
    await this.page.goto(this.scene.url, { waitUntil: 'load', timeout: 90000 });
    const ok = await this.page.evaluate(() => typeof window.__cr === 'object' && typeof window.__crClock === 'object');
    if (!ok) throw new Error('The render driver did not install in this page.');
    this.info = await this.page.evaluate((options) => window.__cr.ready(options), { transparent: this.opts.transparent, plate: !!this.opts.plate });
    this.info.errors = [...(this.info.errors || []), ...this.errors];
    this.timeMs = 0;
    this.plateApplied = null;
    if (this.opts.plate) await this.setPlate(this.opts.plate);
  }

  /** Paint a background plate under the scene, or take it away (null). */
  async setPlate(plate) {
    const key = plate ? JSON.stringify(plate) : null;
    if (key === this.plateApplied) return;
    await this.page.evaluate((p) => window.__cr.setPlate(p), plate || null);
    this.plateApplied = key;
  }

  /** Move to `seconds`. Pages without a stage can only go forward, so going back reloads. */
  async seek(seconds) {
    const ms = seconds * 1000;
    // A long jump forward on a clock-driven page is taken in small steps, so
    // motion that integrates per animation frame lands where it would live.
    if (this.info && this.info.mode === 'page' && ms - this.timeMs > 1000 / 30) {
      const step = 1000 / 60;
      for (let t = this.timeMs + step; t < ms - 0.5; t += step) await this.page.evaluate((x) => window.__cr.seek(x), t);
    }
    let res = await this.page.evaluate((t) => window.__cr.seek(t), ms);
    if (res && res.needsReload) {
      await this.load();
      // Step forward at 60 steps a second so rAF-driven motion integrates the
      // way it would have live.
      const step = 1000 / 60;
      for (let t = step; t < ms; t += step) await this.page.evaluate((x) => window.__cr.seek(x), t);
      res = await this.page.evaluate((t) => window.__cr.seek(t), ms);
    }
    this.timeMs = ms;
  }

  /**
   * PNG (or JPEG) of the current frame at output resolution.
   *
   * The frame is captured on a freshly made compositing layer. Otherwise
   * Chromium repaints only what changed since the last frame, and the pixels
   * then depend on paint history: the same frame can differ by a level or two
   * between runs, which makes change detection re-render frames that did not
   * change.
   */
  async capture({ type = 'png', quality } = {}) {
    const w = this.info.mode === 'stage' ? this.info.width : this.opts.width;
    const h = this.info.mode === 'stage' ? this.info.height : this.opts.height;
    await this.page.evaluate(() => window.__cr.freshLayer(true));
    try {
      return await this.page.screenshot({
        type,
        quality: type === 'jpeg' ? (quality || 82) : undefined,
        clip: { x: 0, y: 0, width: w, height: h },
        omitBackground: !!this.opts.transparent && type === 'png',
        animations: 'allow',
        caret: 'hide',
        scale: 'device',
        timeout: 60000,
      });
    } finally {
      await this.page.evaluate(() => window.__cr.freshLayer(false)).catch(() => {});
    }
  }

  async close() {
    try { await this.context.close(); } catch { /* already gone */ }
  }
}

/** Open a scene just long enough to learn its size, length and sections. */
export async function analyzeScene(browser, roots, scene, { pageSize } = {}) {
  const [w, h] = pageSize || [1920, 1080];
  const page = new ScenePage(browser, roots, scene, { width: w, height: h, scale: 1 });
  try {
    const info = await page.open();
    if (info.mode === 'page') {
      if (pageSize) [info.width, info.height] = pageSize;
      // A page a little bigger than the window is probably a fixed artboard, so
      // use its size. One much taller than the window is a scrolling page; keep
      // the window.
      else if (info.width > w * 2 || info.height > h * 2) [info.width, info.height] = [w, h];
    }
    return info;
  } finally {
    await page.close();
  }
}
