// The app server and the Premiere mailbox.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES, canRender, tmp } from './helpers.mjs';

process.env.CANVAS_RENDER_CACHE = process.env.CANVAS_RENDER_CACHE || tmp('cr-cache-');
process.env.CANVAS_RENDER_DATA = tmp('cr-data-');
const skip = canRender();
const port = 48000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let srv;

before(async () => {
  const { startServer } = await import('../engine/src/server.mjs');
  srv = await startServer({ port });
});
after(() => srv && srv.close());

const api = (p, opts = {}) => fetch(base + p, { ...opts, headers: { 'X-Canvas-Render': '1', 'Content-Type': 'application/json', ...(opts.headers || {}) } });

test('status, UI and the request guards', async () => {
  const s = await (await fetch(`${base}/api/status`)).json();
  assert.equal(s.app, 'canvas-render');
  assert.ok(Array.isArray(s.presets) && s.presets.length);
  const ui = await fetch(`${base}/`);
  assert.equal(ui.status, 200);
  assert.match(ui.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/open`, { method: 'POST', body: '{}' })).status, 403, 'needs the header');
  assert.equal((await api('/api/open', { method: 'POST', body: '{}', headers: { Origin: 'https://example.com' } })).status, 403, 'other sites are refused');
  assert.equal((await api('/api/reveal', { method: 'POST', body: JSON.stringify({ path: '/etc/hosts' }) })).status, 404, 'only reveals renders');
});

test('another copy reuses a running server', async () => {
  const { startServer } = await import('../engine/src/server.mjs');
  const second = await startServer({ port, mailbox: false });
  assert.equal(second.existing, true);
});

test('open a file and scrub a preview frame', { skip }, async () => {
  const r = await api('/api/open', { method: 'POST', body: JSON.stringify({ path: path.join(FIXTURES, 'claude-export') }) });
  assert.equal(r.status, 200);
  const project = await r.json();
  const scene = project.scenes.find((s) => s.name === 'Lower Third');
  assert.equal(scene.info.mode, 'stage');
  const img = await fetch(`${base}/api/preview?project=${project.id}&scene=${scene.id}&t=1.5&w=320`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  const buf = Buffer.from(await img.arrayBuffer());
  assert.equal(buf[0], 0xff);
  const png = await fetch(`${base}/api/preview?project=${project.id}&scene=${scene.id}&t=0.5&w=320&alpha=1`);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const prefs = await (await fetch(`${base}/api/prefs`)).json();
  assert.ok(prefs.recent.some((p) => p.name === 'claude-export'));
});

test('the Premiere mailbox renders and reports back', { skip }, async () => {
  const box = path.join(process.env.CANVAS_RENDER_DATA, 'mailbox');
  const beat = JSON.parse(readFileSync(path.join(box, 'engine.json'), 'utf8'));
  assert.equal(beat.app, 'canvas-render');
  assert.ok(Date.now() - beat.updatedAt < 5000);

  const out = tmp();
  const req = { id: 'test-1', action: 'render', input: path.join(FIXTURES, 'css-keyframes.html'), preset: 'client-review', settings: { rate: '24' }, outDir: out };
  const part = path.join(box, 'inbox', 'test-1.json.part');
  writeFileSync(part, JSON.stringify(req));
  renameSync(part, path.join(box, 'inbox', 'test-1.json'));

  const statusFile = path.join(box, 'outbox', 'test-1.json');
  let status = null;
  for (let i = 0; i < 300; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    if (!existsSync(statusFile)) continue;
    status = JSON.parse(readFileSync(statusFile, 'utf8'));
    if (status.state !== 'working') break;
  }
  assert.equal(status.state, 'done', status && status.message);
  const job = status.jobs[0];
  assert.equal(job.format, 'h264');
  assert.ok(existsSync(job.result.file));
  assert.ok(status.xml && existsSync(status.xml));
});
