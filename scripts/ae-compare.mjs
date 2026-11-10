// Convert a project's scenes for After Effects, then draw each import the way
// AE composites it and compare against the original page, frame by frame.
//
//   node scripts/ae-compare.mjs <export> [outDir] [times]
//
// Writes <outDir>/<scene>/compare-<t>.png (original | AE import | difference)
// and prints how far apart they are.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Engine } from '../engine/src/engine.mjs';
import { wireContext } from '../engine/src/browser.mjs';
import { INIT } from '../engine/src/ae/capture.mjs';
import { previewFrames } from '../engine/src/ae/preview.mjs';

const [input, outArg, timesArg, only] = process.argv.slice(2);
if (!input) { console.error('usage: node scripts/ae-compare.mjs <export> [outDir] [t1,t2,...] [scene]'); process.exit(2); }
const outDir = path.resolve(outArg || 'ae-compare');
const engine = new Engine();
const project = await engine.open(input);
const items = project.scenes.filter((s) => s.selected && s.info && !s.error && (!only || s.name.includes(only))).map((s) => ({ projectId: project.id, sceneId: s.id }));
const batch = await new Promise((resolve) => {
  const { batchId } = engine.enqueue({ items, settings: { format: 'ae', rate: '24' }, outDir });
  engine.on('event', (e) => { if (e.type === 'batch' && e.batch.id === batchId) resolve(e.batch); });
});

async function diff(a, b, w, h) {
  const A = await sharp(a).ensureAlpha().raw().toBuffer();
  const B = await sharp(b).ensureAlpha().raw().toBuffer();
  const D = Buffer.alloc(A.length);
  let sum = 0; let bad = 0;
  for (let i = 0; i < A.length; i += 4) {
    // Compare premultiplied, so differences in invisible colour do not count.
    let d = 0;
    for (let c = 0; c < 3; c += 1) d = Math.max(d, Math.abs((A[i + c] * A[i + 3]) / 255 - (B[i + c] * B[i + 3]) / 255));
    d = Math.max(d, Math.abs(A[i + 3] - B[i + 3]));
    sum += d; if (d > 48) bad += 1;
    D[i] = 255; D[i + 1] = 255 - d; D[i + 2] = 255 - d; D[i + 3] = 255;
  }
  return { mean: sum / (A.length / 4), bad: bad / (A.length / 4), image: await sharp(D, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer() };
}

for (const job of batch.jobs) {
  if (job.status !== 'done') { console.log(`${job.sceneName}: ${job.status} ${job.error || ''}`); continue; }
  const r = job.result;
  const ir = JSON.parse(readFileSync(r.file.replace(/\.jsx$/, '.d2ae.json'), 'utf8'));
  const { scene } = engine.scene(job.projectId, job.sceneId);
  const dur = scene.info.duration;
  const times = timesArg ? timesArg.split(',').map(Number) : [0.15, 0.35, 0.6, 0.85].map((f) => Math.round(f * dur * 100) / 100);
  const frames = await previewFrames({
    browser: await engine.getBrowser(), roots: engine.roots, scene, info: scene.info, ir, times,
    assetDir: path.join(r.folder, 'assets'), wireContext, clockInit: INIT,
  });
  const dir = path.join(outDir, scene.name);
  mkdirSync(dir, { recursive: true });
  const { width: w, height: h } = scene.info;
  const scale = Math.min(1, 960 / w);
  const lines = [];
  for (const f of frames) {
    const d = await diff(f.original, f.preview, w, h);
    const tile = (buf) => sharp(buf).resize(Math.round(w * scale)).flatten({ background: '#3a3d44' }).png().toBuffer();
    const tw = Math.round(w * scale); const th = Math.round(h * scale);
    const sheet = await sharp({ create: { width: tw * 3 + 20, height: th, channels: 4, background: '#1b1c1f' } })
      .composite([{ input: await tile(f.original), left: 0, top: 0 }, { input: await tile(f.preview), left: tw + 10, top: 0 }, { input: await tile(d.image), left: tw * 2 + 20, top: 0 }])
      .png().toFile(path.join(dir, `compare-${f.t.toFixed(2)}.png`));
    lines.push(`t=${f.t.toFixed(2)}s mean ${d.mean.toFixed(2)} off ${(d.bad * 100).toFixed(2)}%`);
  }
  console.log(`${scene.name}: ${r.layers} layers ${JSON.stringify(r.tiers)}\n  ${lines.join('\n  ')}`);
}
await engine.close();
