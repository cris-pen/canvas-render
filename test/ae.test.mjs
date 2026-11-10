// After Effects output: the pieces that are pure maths, then whole conversions
// of the example export, a raster fallback, background plates, and the After
// Effects panel talking to a real engine through the real mailbox.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import sharp from 'sharp';
import { radialShape, rampGeometry, pathToShape } from '../engine/src/ae/emit/jsx.mjs';
import { keyPathMorph } from '../engine/src/ae/ir/morph.mjs';
import { aeTransformAt, layerFrame } from '../engine/src/ae/analyze/layers.mjs';
import { normalizePlate, plateCss, plateKey } from '../engine/src/plate.mjs';
import { FIXTURES, canRender, tmp } from './helpers.mjs';

process.env.CANVAS_RENDER_CACHE = process.env.CANVAS_RENDER_CACHE || tmp('cr-cache-');
const DATA = tmp('cr-ae-data-');
process.env.CANVAS_RENDER_DATA = path.join(DATA, 'Canvas Render');
const EXAMPLE = path.resolve(FIXTURES, '../examples/tidewater-export');
const skip = canRender();

// --- pure ---------------------------------------------------------------------

test('a radial ramp lands where the CSS gradient is centred and sized', () => {
  const r = radialShape('radial-gradient(120% 90% at 30% 20%, rgb(31, 75, 85) 0%, rgb(11, 28, 34) 100%)', 1920, 1080);
  assert.deepEqual([r.cx, r.cy, r.rx, r.ry], [576, 216, 2304, 972]);
  assert.ok(Math.abs(r.radius - Math.sqrt(2304 * 972)) < 1e-9, 'an ellipse becomes the circle of the same area');
  const plain = radialShape('radial-gradient(rgb(1, 2, 3), rgb(4, 5, 6))', 200, 100);
  assert.deepEqual([plain.cx, plain.cy], [100, 50], 'no prelude: centred, and the first colour is not mistaken for one');
  const circle = radialShape('radial-gradient(circle 40px at left top, red, blue)', 200, 100);
  assert.deepEqual([circle.cx, circle.cy, circle.radius], [0, 0, 40]);
  const g = rampGeometry({ kind: 'radial' }, [200, 100], 'radial-gradient(circle 40px at 25% 75%, red, blue)');
  assert.deepEqual(g.start, [50, 75]);
  assert.deepEqual(g.end, [90, 75]);
});

test('an SVG shape is laid out in its own user space, viewBox scale folded into Scale', () => {
  // A path drawn in a viewBox of 0 0 200 100 shown at 400x200 from (50, 40): the
  // page box is the geometry's bbox (20,30 100x50 in user units) scaled by 2.
  const entry = {
    present: true, box: [90, 100, 200, 100], origin: [0, 0, 0], m: null,
    bbox: [20, 30, 100, 50], user: { origin: [50, 40], scale: [2, 2] }, style: { opacity: 1, transformBox: 'view-box' },
  };
  const svg = { present: true, box: [50, 40, 400, 200], origin: [200, 100, 0], m: null, style: { opacity: 1 } };
  const t = aeTransformAt(entry, svg, {}, { self: 'svgShape', parent: 'svgRoot' });
  assert.deepEqual(t.anchorPoint.slice(0, 2), [0, 0]);
  assert.deepEqual(t.position.slice(0, 2), [0, 0], 'user-space origin sits on the svg box corner');
  assert.deepEqual(t.scale.slice(0, 2), [200, 200]);
  // A vertex at user (120, 80) must land on page (50 + 240, 40 + 160).
  const p = [svg.box[0] + t.position[0] + (t.scale[0] / 100) * (120 - t.anchorPoint[0]), svg.box[1] + t.position[1] + (t.scale[1] / 100) * (80 - t.anchorPoint[1])];
  assert.deepEqual(p, [290, 200]);
  assert.deepEqual(t.boxQuad[0], [90, 100], 'box corners are still the page box');
  // fill-box origin is measured from the bbox, not the user origin.
  const fill = aeTransformAt({ ...entry, origin: [50, 25, 0], style: { ...entry.style, transformBox: 'fill-box' } }, svg, {}, { self: 'svgShape', parent: 'svgRoot' });
  assert.deepEqual(fill.anchorPoint.slice(0, 2), [70, 55]);
  // A child of an SVG group shares its user space: no second viewBox scale.
  const f = layerFrame(entry, { ...entry }, { self: 'svgShape', parent: 'svgShape' });
  assert.deepEqual(f.unit, [2, 2]);
  assert.deepEqual(f.parentUnit, [2, 2]);
});

test('a morphing path is keyed only as often as straight-line interpolation needs', () => {
  const frames = [];
  for (let f = 0; f <= 24; f += 1) {
    const t = f / 24;
    // Two points: one moves linearly (needs no inner keys), one jumps at 0.5 s.
    const y = t < 0.5 ? 0 : 40;
    frames.push({ time: t, entry: { present: true, d: `M${(t * 100).toFixed(3)} 0 L50 ${y}` } });
  }
  const m = keyPathMorph({ perFrame: frames }, 0.25);
  assert.ok(m && m.keys, 'it changes, so it is keyed');
  assert.ok(m.keys.length <= 5, `a linear move plus one jump needs a handful of keys, not ${m.keys.length}`);
  assert.equal(m.straight, true);
  const still = keyPathMorph({ perFrame: frames.map((x) => ({ ...x, entry: { present: true, d: 'M0 0 L1 1' } })) });
  assert.equal(still, null, 'a path that never changes is not keyed');
  const mismatch = keyPathMorph({ perFrame: [{ time: 0, entry: { present: true, d: 'M0 0 L1 1' } }, { time: 1, entry: { present: true, d: 'M0 0 L1 1 L2 2' } }] });
  assert.ok(mismatch.mismatch, 'a change in point count is reported, not keyed');
  assert.equal(pathToShape({ d: 'M0 0 L10 0 Z' }).closed, true);
});

test('background plates are checked and turned into CSS', () => {
  assert.throws(() => normalizePlate({ mode: 'color', color: 'red' }), /#rrggbb/);
  assert.throws(() => normalizePlate({ mode: 'image', image: '/tmp/x.txt' }), /PNG, JPEG/);
  assert.equal(plateCss(normalizePlate({ mode: 'page' })), null);
  assert.equal(plateCss(normalizePlate({ mode: 'color', color: '#00b140' })).css, '#00b140');
  const g = plateCss(normalizePlate({ mode: 'gradient', gradient: { kind: 'linear', angle: 450, from: '#000000', to: '#ffffff' } }));
  assert.equal(g.css, 'linear-gradient(90deg, #000000, #ffffff)');
  assert.notEqual(JSON.stringify(plateKey(normalizePlate({ mode: 'color', color: '#000000' }))), JSON.stringify(plateKey(normalizePlate({ mode: 'color', color: '#000001' }))));
});

// --- conversions -------------------------------------------------------------------

let engine;
async function getEngine() {
  if (!engine) {
    const { Engine } = await import('../engine/src/engine.mjs');
    engine = new Engine();
  }
  return engine;
}
after(() => engine && engine.close());

function run(items, settings, outDir) {
  return new Promise((resolve, reject) => {
    let batchId = null;
    const onEvent = (e) => {
      if (e.type === 'batch' && e.batch.id === batchId) {
        engine.off('event', onEvent);
        const failed = e.batch.jobs.find((j) => j.status !== 'done');
        if (failed) reject(new Error(`${failed.sceneName}: ${failed.status} ${failed.error}`)); else resolve(e.batch);
      }
    };
    engine.on('event', onEvent);
    try { ({ batchId } = engine.enqueue({ items, settings, outDir })); } catch (err) { engine.off('event', onEvent); reject(err); }
  });
}

function copyExample() {
  const dir = path.join(tmp(), 'tidewater-export');
  cpSync(EXAMPLE, dir, { recursive: true });
  return dir;
}

let converted = null;
test('the example export converts to native layers within half a pixel', { skip }, async () => {
  const e = await getEngine();
  const project = await e.open(copyExample());
  const out = tmp('cr-ae-out-');
  const batch = await run(project.scenes.map((s) => ({ projectId: project.id, sceneId: s.id })), { format: 'ae', rate: '24' }, out);
  converted = { project, batch };
  for (const j of batch.jobs) {
    const r = j.result;
    assert.equal(r.format, 'ae');
    assert.ok(existsSync(r.file) && r.file.endsWith('.jsx'), 'a script is written');
    assert.equal(r.tiers.C, 0, `${r.scene}: nothing rasterised`);
    assert.ok(r.withinTolerance, `${r.scene}: worst position error ${r.worstPositionError}`);
    const jsx = readFileSync(r.file, 'utf8');
    assert.match(jsx, /Generated by Canvas Render/);
    assert.match(jsx, /app\.beginUndoGroup\("Import from Canvas Render"\)/);
  }
  const title = batch.jobs.find((j) => j.sceneName === 'Title Card').result;
  const ir = JSON.parse(readFileSync(title.file.replace(/\.jsx$/, '.d2ae.json'), 'utf8'));
  const waves = ir.comps.flatMap((c) => c.layers).filter((l) => l.kind === 'path');
  assert.equal(waves.length, 3);
  for (const w of waves) {
    assert.ok(w.path.morph && w.path.morph.keys.length > 2, `${w.name}: the moving wave is keyed`);
    assert.deepEqual(w.transform.position.static, [0, 0], `${w.name}: placed at its user-space origin`);
  }
  const text = ir.comps.flatMap((c) => c.layers).find((l) => l.kind === 'text' && l.stagger);
  assert.ok(text, 'the letter-by-letter title becomes one text layer with an animator');
  assert.match(readFileSync(title.file, 'utf8'), /kern: "none"/, 'separate letter boxes are not kerned in AE either');
  const lower = batch.jobs.find((j) => j.sceneName === 'Lower Third').result;
  assert.match(readFileSync(lower.file, 'utf8'), /Clip Left|Clip Right|Clip Top/, 'the clip-path wipe becomes slider-driven masks');
});

test('the converted layers redraw like the browser', { skip }, async () => {
  assert.ok(converted, 'needs the conversion above');
  const { previewFrames } = await import('../engine/src/ae/preview.mjs');
  const { wireContext } = await import('../engine/src/browser.mjs');
  const { INIT } = await import('../engine/src/ae/capture.mjs');
  const e = await getEngine();
  const browser = await e.getBrowser();
  const p = e.projects.get(converted.project.id);
  for (const j of converted.batch.jobs) {
    const scene = p.scenes.find((s) => s.id === j.sceneId);
    const ir = JSON.parse(readFileSync(j.result.file.replace(/\.jsx$/, '.d2ae.json'), 'utf8'));
    const shots = await previewFrames({ browser, roots: e.roots, scene, info: scene.info, ir, times: [2.1], assetDir: j.result.folder, wireContext, clockInit: INIT });
    for (const s of shots) {
      const [a, b] = await Promise.all([s.original, s.preview].map((buf) => sharp(buf).removeAlpha().raw().toBuffer()));
      let off = 0;
      for (let i = 0; i < a.length; i += 3) {
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 96) off += 1;
      }
      const pct = (off / (a.length / 3)) * 100;
      assert.ok(pct < 0.5, `${j.sceneName} at ${s.t}s: ${pct.toFixed(2)}% of pixels differ`);
    }
  }
});

test('an element AE cannot express comes in as rendered footage', { skip }, async () => {
  const e = await getEngine();
  const project = await e.open(path.join(FIXTURES, 'ae-raster.html'), { pageSize: [640, 360] });
  const out = tmp('cr-ae-raster-');
  const batch = await run([{ projectId: project.id, sceneId: project.scenes[0].id }], { format: 'ae', rate: '24' }, out);
  const r = batch.jobs[0].result;
  assert.equal(r.tiers.C, 1);
  const ir = JSON.parse(readFileSync(r.file.replace(/\.jsx$/, '.d2ae.json'), 'utf8'));
  assert.equal(ir.comps.length, 1, 'the perspective comp built around it is gone');
  const footage = ir.comps[0].layers.find((l) => l.rasterised);
  assert.ok(footage && footage.kind === 'image', 'the skewed card is an image layer');
  assert.ok(!ir.comps[0].layers.some((l) => l.name === 'baked as footage'), 'its children are in the footage, not separate layers');
  const asset = ir.assets.find((a) => a.id === footage.image.assetId);
  const first = path.join(r.folder, asset.relative);
  const meta = await sharp(first).metadata();
  assert.equal(meta.hasAlpha, true);
  assert.ok(meta.width < 400 && meta.height < 400, `cropped to what it painted, not the whole frame (${meta.width}x${meta.height})`);
  const { data } = await sharp(first).extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data.some((v) => v === 255) && data.some((v) => v === 0), 'opaque card on a transparent surround');
});

test('a background plate fills behind the design, and can replace its own fill', { skip }, async () => {
  const e = await getEngine();
  const project = await e.open(copyExample());
  const scene = project.scenes.find((s) => s.name === 'Title Card');
  const shoot = async (background) => {
    const out = tmp('cr-plate-');
    const batch = await run([{ projectId: project.id, sceneId: scene.id, inFrame: 10, outFrame: 10 }], { format: 'png', size: 'half', xml: false, partial: false, background }, out);
    const dir = batch.jobs[0].result.file;
    const file = statSync(dir).isDirectory() ? path.join(dir, (await import('node:fs')).readdirSync(dir).find((f) => f.endsWith('.png'))) : dir;
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
    return { corner: at(info.width - 4, info.height - 4) };
  };
  const behind = await shoot({ mode: 'color', color: '#00b140' });
  assert.ok(behind.corner[1] < 100, `the board is opaque, so a plate behind it does not show (${behind.corner})`);
  const replaced = await shoot({ mode: 'color', color: '#00b140', replace: true });
  assert.deepEqual(replaced.corner, [0, 177, 64, 255], 'with replace the plate shows through');
});

// --- the After Effects panel ----------------------------------------------------------

/** Just enough ExtendScript and ScriptUI to run the panel in Node. */
function extendScript(log) {
  class Folder {
    constructor(p) { this.fsName = String(p); this.name = path.basename(this.fsName); }
    get exists() { return existsSync(this.fsName) && statSync(this.fsName).isDirectory(); }
    create() { mkdirSync(this.fsName, { recursive: true }); return true; }
  }
  Folder.userData = new Folder(DATA);
  class File {
    constructor(p) { this.fsName = String(p); this.name = path.basename(this.fsName); this.displayName = this.name; this.encoding = 'UTF-8'; }
    get exists() { return existsSync(this.fsName) && statSync(this.fsName).isFile(); }
    open(mode) {
      this.mode = mode;
      if (mode === 'r') { if (!this.exists) return false; this.buf = readFileSync(this.fsName, 'utf8'); } else this.buf = '';
      return true;
    }
    read() { return this.buf; }
    write(s) { this.buf += s; }
    close() { if (this.mode === 'w') { mkdirSync(path.dirname(this.fsName), { recursive: true }); writeFileSync(this.fsName, this.buf); } }
    remove() { rmSync(this.fsName, { force: true }); return true; }
    rename(n) { renameSync(this.fsName, path.join(path.dirname(this.fsName), n)); return true; }
  }
  const control = (type, text) => {
    const c = { type, text: text || '', enabled: true, value: false, selection: null, items: [], children: [], layout: { layout() {}, resize() {} } };
    c.add = (t, _b, label, props) => {
      if (t === 'item') {
        const item = { text: _b, index: c.items.length, subItems: [{ text: '' }] };
        Object.defineProperty(item, 'selected', {
          set(v) { if (v) c.selection = c.properties && c.properties.multiselect ? [...(c.selection || []), item] : item; },
        });
        c.items.push(item);
        return item;
      }
      const child = control(t, typeof label === 'string' ? label : '');
      if (Array.isArray(label)) child.items = label.map((x, i) => ({ text: x, index: i }));
      child.properties = props || {};
      child.parent = c;
      Object.defineProperty(child, 'selection', {
        get() { return this._sel ?? null; },
        set(v) { this._sel = typeof v === 'number' ? this.items[v] : v; },
      });
      c.children.push(child);
      return child;
    };
    c.removeAll = () => { c.items = []; c.selection = null; };
    c.center = () => {}; c.show = () => {};
    return c;
  };
  function Window() { return control('window'); }
  function Panel() {}
  const sandbox = {
    Folder, File, Window, Panel,
    alert: (m) => log.alerts.push(m),
    app: {
      scheduleTask: () => 1, cancelTask: () => {},
      beginUndoGroup: () => { log.undo += 1; }, endUndoGroup: () => {},
    },
  };
  sandbox.$ = {
    global: sandbox,
    os: 'Macintosh OS 14.0',
    evalFile: (f) => { log.evaluated.push(f.fsName); sandbox.D2AE_LAST = `Imported ${path.basename(f.fsName, '.jsx')}.`; },
  };
  return sandbox;
}

test('the After Effects panel converts through the app and imports the result', { skip }, async () => {
  const e = await getEngine();
  const { Mailbox } = await import('../engine/src/mailbox.mjs');
  const { mailboxRoot } = await import('../engine/src/paths.mjs');
  const box = new Mailbox(e, { root: mailboxRoot(), poll: 100 }).start();
  try {
    const log = { alerts: [], evaluated: [], undo: 0 };
    const sandbox = extendScript(log);
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(path.resolve(FIXTURES, '../panel/after-effects/Canvas Render.jsx'), 'utf8'), sandbox, { filename: 'Canvas Render.jsx' });
    const CR = sandbox.CanvasRenderPanel;
    assert.match(CR.ui.status.text, /Canvas Render is running/);
    // Built inside the panel's own realm, as it would be in After Effects.
    assert.equal(vm.runInContext(`CanvasRenderPanel.stringify({ a: 'x"\\n', b: [1, true, null] })`, sandbox), '{"a":"x\\"\\n","b":[1,true,null]}');

    const until = async (ms) => {
      const end = Date.now() + ms;
      while (CR.waiting && Date.now() < end) { await new Promise((r) => setTimeout(r, 150)); CR.poll(); }
      assert.equal(CR.waiting, null, `still waiting: ${CR.ui.status.text}`);
    };

    CR.input = copyExample();
    CR.watch(CR.send({ action: 'analyze', input: CR.input }), 'analyze');
    await until(60000);
    assert.deepEqual(CR.ui.list.items.map((i) => i.text).sort(), ['Lower Third', 'Title Card']);

    CR.ui.list.selection = [CR.ui.list.items.find((i) => i.text === 'Lower Third')];
    CR.convert();
    await until(120000);
    assert.equal(log.evaluated.length, 1, CR.ui.status.text);
    assert.match(log.evaluated[0], /Lower Third\.jsx$/);
    assert.ok(existsSync(log.evaluated[0]));
    assert.match(CR.ui.status.text, /Imported 1 scene/);
    assert.ok(log.undo >= 1, 'imports are one undo step');
    assert.equal(CR.ui.recent.items[0].text, 'Lower Third', 'the Recent list shows it');
    assert.equal(log.alerts.length, 0, 'the panel reports in place, not with alerts');
  } finally {
    box.stop();
  }
});
