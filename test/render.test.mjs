// End-to-end renders of the clean-room fixtures. Needs ffmpeg and Chrome;
// skipped when either is missing.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';
import { Engine } from '../engine/src/engine.mjs';
import { probe, tools } from '../engine/src/ffmpeg.mjs';
import { FIXTURES, canRender, copyFixture, tmp } from './helpers.mjs';

process.env.CANVAS_RENDER_CACHE = process.env.CANVAS_RENDER_CACHE || tmp('cr-cache-');
const skip = canRender();
const engine = new Engine();
after(() => engine.close());

function render(items, settings, outDir) {
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

async function pixel(file, x, y) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3], width: info.width, height: info.height };
}

async function rowAlpha(file, y) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = [];
  for (let x = 0; x < info.width; x += 1) out.push(data[(y * info.width + x) * 4 + 3]);
  return out;
}

function frameHashes(file) {
  const out = execFileSync(tools().ffmpeg, ['-v', 'error', '-i', file, '-f', 'framemd5', '-c:v', 'rawvideo', '-'], { maxBuffer: 1 << 26 }).toString();
  return out.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

let board; let boardScene;

test('a board export is detected as a stage with sections', { skip }, async () => {
  board = await engine.open(copyFixture('claude-export'));
  boardScene = board.scenes.find((s) => s.name === 'Lower Third');
  const info = boardScene.info;
  assert.equal(info.mode, 'stage');
  assert.equal(info.width, 640);
  assert.equal(info.height, 360);
  assert.equal(info.duration, 2);
  assert.deepEqual(info.scenes.map((s) => [s.name, s.start]), [['Bar in', 0], ['Name', 1]]);
});

test('PNG sequence with alpha lands every frame where it should', { skip }, async () => {
  const out = tmp();
  const batch = await render([{ projectId: board.id, sceneId: boardScene.id }], { format: 'png', rate: '24', transparent: true }, out);
  const dir = batch.jobs[0].result.file;
  const frames = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  assert.equal(frames.length, 48);
  const first = await pixel(path.join(dir, frames[0]), 60, 266);
  assert.equal(first.width, 640);
  assert.ok(first.a === 255 && first.r > 200 && first.b < 140, `bar at the start: ${JSON.stringify(first)}`);
  const corner = await pixel(path.join(dir, frames[0]), 600, 20);
  assert.equal(corner.a, 0, 'empty stage is transparent');
  const last = await pixel(path.join(dir, frames[47]), 460, 266);
  assert.ok(last.a === 255 && last.r > 200, 'bar has travelled 400px by the end');
  const moved = await pixel(path.join(dir, frames[47]), 60, 266);
  assert.equal(moved.a, 0);
});

test('ProRes 4444 master is tagged, timed and reused when nothing changed', { skip }, async () => {
  const out = tmp();
  const settings = { format: 'prores4444', rate: '23.976' };
  const item = [{ projectId: board.id, sceneId: boardScene.id }];
  const first = await render(item, settings, out);
  const r = first.jobs[0].result;
  const p = await probe(r.file);
  assert.equal(p.codec, 'prores');
  assert.match(p.pixFmt, /^yuva444p/);
  assert.equal(p.frames, 48);
  assert.equal(p.rate, '24000/1001');
  assert.deepEqual(p.color, ['bt709', 'bt709', 'bt709']);
  assert.ok(first.xml && readFileSync(first.xml, 'utf8').includes('<name>Bar in</name>'));

  const again = await render(item, settings, out);
  assert.equal(again.jobs[0].result.upToDate, true);
});

test('a board with a long hold renders the same pixels every time', { skip }, async () => {
  // Static frames used to pick up a level or two of raster noise from earlier
  // frames, so an untouched board looked changed on the second render.
  const examples = path.resolve(FIXTURES, '../examples/tidewater-export');
  const p = await engine.open(examples);
  const s = p.scenes.find((x) => x.name === 'Lower Third');
  const out = tmp();
  const settings = { format: 'prores422hq', rate: '24', size: 'half' };
  await render([{ projectId: p.id, sceneId: s.id, inFrame: 12, outFrame: 60 }], settings, out);
  const again = (await render([{ projectId: p.id, sceneId: s.id, inFrame: 12, outFrame: 60 }], settings, out)).jobs[0].result;
  assert.equal(again.upToDate, true, `${again.changed} frames looked changed`);
});

test('an edited board re-renders only the frames that changed', { skip }, async () => {
  const src = copyFixture('claude-export');
  const out = tmp();
  const settings = { format: 'prores4444', rate: '24' };
  let project = await engine.open(src);
  let scene = project.scenes.find((s) => s.name === 'Lower Third');
  await render([{ projectId: project.id, sceneId: scene.id }], settings, out);

  // The name only shows in the second half, so only those frames change.
  const file = path.join(src, 'Lower Third standalone.html');
  writeFileSync(file, readFileSync(file, 'utf8').replace('Jordan Avery', 'Jordan Avery-Ruiz'));
  project = await engine.open(src);
  scene = project.scenes.find((s) => s.name === 'Lower Third');
  const partial = (await render([{ projectId: project.id, sceneId: scene.id }], settings, out)).jobs[0].result;
  assert.ok(partial.reused > 0 && partial.rendered < 48, `rendered ${partial.rendered}, reused ${partial.reused}`);
  assert.ok(partial.changed <= 24);
  assert.equal((await probe(partial.file)).frames, 48);

  const fullOut = tmp();
  const full = (await render([{ projectId: project.id, sceneId: scene.id }], { ...settings, partial: false }, fullOut)).jobs[0].result;
  assert.deepEqual(frameHashes(partial.file), frameHashes(full.file), 'spliced master matches a clean render');
});

test('motion blur smears a moving edge across the shutter', { skip }, async () => {
  const run = async (blur) => {
    const out = tmp();
    const b = await render([{ projectId: board.id, sceneId: boardScene.id, inFrame: 6, outFrame: 6 }],
      { format: 'png', rate: '24', transparent: true, motionBlur: { enabled: blur, shutter: 180, samples: 8 } }, out);
    const dir = b.jobs[0].result.file;
    return rowAlpha(path.join(dir, readdirSync(dir).find((f) => f.endsWith('.png'))), 266);
  };
  const soft = (row) => row.filter((a) => a > 8 && a < 247).length;
  const sharpRow = await run(false);
  const blurred = await run(true);
  assert.ok(soft(sharpRow) <= 4, `no blur: ${soft(sharpRow)} soft pixels`);
  assert.ok(soft(blurred) >= 10, `blur: ${soft(blurred)} soft pixels`);
});

test('plain CSS animation renders on a transparent page', { skip }, async () => {
  const p = await engine.open(path.join(FIXTURES, 'css-keyframes.html'));
  const s = p.scenes[0];
  assert.equal(s.info.mode, 'page');
  const out = tmp();
  const b = await render([{ projectId: p.id, sceneId: s.id, inFrame: 0, outFrame: 11 }], { format: 'png', rate: '24', transparent: true, size: 'half' }, out);
  const dir = b.jobs[0].result.file;
  const frames = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  assert.equal(frames.length, 12);
  const dot = await pixel(path.join(dir, frames[0]), 40, 80);
  assert.ok(dot.a === 255 && dot.g > 150, `dot: ${JSON.stringify(dot)}`);
  assert.equal((await pixel(path.join(dir, frames[0]), dot.width - 5, dot.height - 5)).a, 0);
});

test('requestAnimationFrame canvas follows the virtual clock', { skip }, async () => {
  const p = await engine.open(path.join(FIXTURES, 'canvas-raf.html'));
  const s = p.scenes[0];
  const out = tmp();
  const b = await render([{ projectId: p.id, sceneId: s.id, inFrame: 0, outFrame: 12 }], { format: 'png', rate: '24' }, out);
  const dir = b.jobs[0].result.file;
  const frames = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  // At t = 0.5 s the square has moved 125px.
  const atHalf = await pixel(path.join(dir, frames[12]), 185, 180);
  assert.ok(atHalf.r > 200 && atHalf.g > 150 && atHalf.b < 60, `square at 0.5s: ${JSON.stringify(atHalf)}`);
  const before = await pixel(path.join(dir, frames[12]), 40, 180);
  assert.ok(before.r < 30, 'square has left its start');
});
