import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseRate, frameCount, frameTime, timecode } from '../engine/src/rates.mjs';
import { normalizeSettings, outputSize, PRESETS, FORMATS } from '../engine/src/settings.mjs';
import { buildXml } from '../engine/src/xml.mjs';
import { openProject } from '../engine/src/ingest.mjs';
import { sampleTimes, accumulate, outputPaths } from '../engine/src/render.mjs';
import { FIXTURES, tmp, writeZip, zipFolder } from './helpers.mjs';

process.env.CANVAS_RENDER_CACHE = tmp('cr-cache-');

test('frame rates are exact rationals', () => {
  const r = parseRate('23.976');
  assert.equal(r.ffmpeg, '24000/1001');
  assert.equal(r.timebase, 24);
  assert.equal(r.ntsc, true);
  assert.equal(parseRate(29.97).ffmpeg, '30000/1001');
  assert.equal(parseRate('25').ntsc, false);
  assert.equal(parseRate('60000/1001').label, '59.94');
  assert.throws(() => parseRate('fast'));
  // Ten seconds at 23.976 is 240 frames, not 239.76.
  assert.equal(frameCount(10.01, r), 240);
  assert.ok(Math.abs(frameTime(24, r) - 1.001) < 1e-9);
  assert.equal(timecode(24 * 61 + 5, r), '00:01:01:05');
});

test('output sizes stay even and keep aspect', () => {
  const s = normalizeSettings({ size: 'hd' });
  assert.deepEqual(outputSize(3840, 2160, s), { width: 1920, height: 1080, scale: 0.5 });
  const odd = outputSize(1001, 563, normalizeSettings({ size: 'half' }));
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);
  assert.equal(outputSize(640, 360, normalizeSettings({ width: 1280 })).height, 720);
  assert.throws(() => normalizeSettings({ format: 'gif' }), /Unknown format/);
  for (const p of PRESETS) assert.ok(FORMATS[p.settings.format], p.id);
});

test('motion blur samples sit inside the shutter and centre on the frame', () => {
  const rate = parseRate('24');
  const times = sampleTimes(10, rate, { enabled: true, shutter: 180, samples: 4 }, 100);
  assert.equal(times.length, 4);
  const mid = times.reduce((a, b) => a + b, 0) / times.length;
  assert.ok(Math.abs(mid - 10 / 24) < 1e-9);
  assert.ok(Math.max(...times) - Math.min(...times) < 0.5 / 24);
  assert.deepEqual(sampleTimes(3, rate, { enabled: false }, 100), [3 / 24]);
});

test('frames are averaged in premultiplied space', () => {
  // A white opaque pixel and a fully transparent one average to white at half alpha,
  // not grey at half alpha.
  const a = Buffer.from([255, 255, 255, 255]);
  const b = Buffer.from([0, 0, 0, 0]);
  const out = accumulate([a, b]);
  assert.deepEqual([...out], [255, 255, 255, 128]);
});

test('output names follow the scene and format', () => {
  const p = outputPaths('/out', { name: 'Lower Third' }, normalizeSettings({ format: 'prores422hq' }));
  assert.equal(p.file, path.join('/out', 'Lower Third_422HQ.mov'));
  assert.equal(path.dirname(p.sidecar), path.join('/out', '.canvas-render'));
});

test('timeline XML lays clips end to end with markers', () => {
  const xml = buildXml({
    name: 'Batch & Co',
    clips: [
      { name: 'One', file: '/tmp/a b/One_4444.mov', frames: 48, width: 1920, height: 1080, rate: '23.976', alpha: true, markers: [{ name: 'Hold', desc: 'x < y', frame: 24 }] },
      { name: 'Two', file: '/tmp/Two_4444.mov', frames: 24, width: 1920, height: 1080, rate: '23.976', alpha: true, markers: [] },
    ],
  });
  assert.match(xml, /<xmeml version="4">/);
  assert.match(xml, /Batch &amp; Co/);
  assert.match(xml, /<start>48<\/start>\s*<end>72<\/end>/);
  assert.match(xml, /<alphatype>straight<\/alphatype>/);
  assert.match(xml, /file:\/\/localhost\/tmp\/a%20b\/One_4444\.mov/);
  assert.match(xml, /<comment>x &lt; y<\/comment><in>24<\/in>/);
  assert.match(xml, /<ntsc>TRUE<\/ntsc>/);
});

test('a Claude Design zip export becomes a scene list', async () => {
  const zip = zipFolder(path.join(FIXTURES, 'claude-export'), path.join(tmp(), 'Lower Third.zip'));
  const p = await openProject(zip);
  assert.equal(p.name, 'Lower Third');
  const names = p.scenes.map((s) => s.name);
  assert.ok(names.includes('Lower Third'));
  assert.ok(!names.some((n) => /preview/.test(n)), 'design system pages are skipped');
  const empty = p.scenes.find((s) => s.name === 'Unused Board');
  assert.equal(empty.kind, 'board');
  assert.equal(empty.selected, false);
  assert.match(empty.note, /Empty/);
  assert.equal(empty.empty, true);
  const lower = p.scenes.find((s) => s.name === 'Lower Third');
  assert.equal(lower.selected, true);
  assert.match(lower.url, /^https:\/\/project\.canvas-render\.local\//);
});

test('an export wrapped in one top-level folder is unwrapped', async () => {
  const zip = zipFolder(path.join(FIXTURES, 'claude-export'), path.join(tmp(), 'Wrapped.zip'), { wrap: 'Wrapped' });
  const p = await openProject(zip);
  assert.ok(p.scenes.some((s) => s.rel === 'Lower Third standalone.html'));
});

test('zip entries cannot escape the extraction folder', async () => {
  const dir = tmp();
  const zip = writeZip(path.join(dir, 'evil.zip'), [
    { name: 'index.html', data: '<p>ok</p>' },
    { name: '../escaped.txt', data: 'nope' },
  ]);
  await openProject(zip).catch(() => {});
  assert.equal(existsSync(path.join(process.env.CANVAS_RENDER_CACHE, 'projects', 'escaped.txt')), false);
  assert.equal(existsSync(path.join(process.env.CANVAS_RENDER_CACHE, 'escaped.txt')), false);
});

test('a single html file is one scene; other inputs explain themselves', async () => {
  const p = await openProject(path.join(FIXTURES, 'css-keyframes.html'));
  assert.equal(p.scenes.length, 1);
  assert.equal(p.scenes[0].selected, true);
  await assert.rejects(openProject('https://claude.ai/share/abc'), /Download as \.zip/);
  const bad = path.join(tmp(), 'notes.txt'); writeFileSync(bad, 'x');
  await assert.rejects(openProject(bad), /\.zip export/);
  const emptyDir = path.join(tmp(), 'empty'); mkdirSync(emptyDir);
  await assert.rejects(openProject(emptyDir), /No HTML/);
});
