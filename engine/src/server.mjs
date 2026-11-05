// The app server: a small HTTP API plus the UI, bound to 127.0.0.1 only.
// The Mac app window loads this; `canvas-render serve --open` opens it in a
// browser. The Premiere panel uses the mailbox instead (see mailbox.mjs).
//
//   GET    /api/status                 tools, presets, defaults, prefs
//   GET    /api/events                 server-sent events from the engine
//   GET    /api/projects               open projects
//   POST   /api/open      {path}       open a zip, html file, folder or URL
//   POST   /api/upload?name=x.zip      raw body; for browsers without file paths
//   DELETE /api/projects/:id
//   GET    /api/preview?project&scene&t&w&alpha   JPEG frame, or PNG with alpha=1
//   POST   /api/render    {items, settings, outDir, name}
//   GET    /api/jobs
//   POST   /api/jobs/:id/cancel
//   POST   /api/reveal    {path, open?}       show an output in Finder
//   GET    /api/prefs  PUT /api/prefs
//   POST   /api/setup/chrome          download the render browser

import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Engine } from './engine.mjs';
import { Mailbox } from './mailbox.mjs';
import { cacheRoot, mimeFor } from './browser.mjs';
import { readPrefs, writePrefs, rememberProject } from './prefs.mjs';
import { VERSION } from './paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const UI_DIR = path.resolve(here, '../../ui');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

async function readJson(req, limit = 1 << 20) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'Request too large.'); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Bad JSON.'); }
}

function revealCommand(file, open) {
  if (process.platform === 'darwin') return ['open', open ? [file] : ['-R', file]];
  if (process.platform === 'win32') return ['explorer', open ? [file] : [`/select,${file}`]];
  return ['xdg-open', [open ? file : path.dirname(file)]];
}

/**
 * Start the server. Resolves with { url, server, engine, close }.
 * If another Canvas Render already owns the port, resolves with { url, existing: true }.
 */
export async function startServer({ port = 47800, host = '127.0.0.1', engine = new Engine(), uiDir = UI_DIR, mailbox = true } = {}) {
  const clients = new Set();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  let setup = null;

  const broadcast = (e) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of clients) res.write(line);
  };
  engine.on('event', broadcast);

  function guard(req) {
    // Only this machine, only this page. Blocks DNS rebinding and other sites
    // in the user's browser from driving the renderer.
    if (!allowedHosts.has(req.headers.host)) throw new HttpError(403, 'Wrong host.');
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) throw new HttpError(403, 'Cross-site requests are not allowed.');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-canvas-render'] !== '1') throw new HttpError(403, 'Missing X-Canvas-Render header.');
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.resolve(uiDir, rel);
    if (!file.startsWith(uiDir + path.sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': mimeFor(file), 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    createReadStream(file).pipe(res);
  }

  async function openAndRemember(input, opts) {
    const project = await engine.open(input, opts);
    rememberProject(engine.project(project.id).source, project.name);
    return engine.listProjects().find((p) => p.id === project.id) || project;
  }

  async function handle(req, res) {
    guard(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      return serveStatic(req, res, p);
    }
    const route = `${req.method} ${p}`;

    if (route === 'GET /api/status') {
      return send(res, 200, { ...engine.status(), version: VERSION, prefs: readPrefs(), setup: setup && { running: setup.running, log: setup.log.slice(-20), code: setup.code } });
    }
    if (route === 'GET /api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', projects: engine.listProjects(), jobs: engine.listJobs() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return undefined;
    }
    if (route === 'GET /api/projects') return send(res, 200, engine.listProjects());
    if (route === 'POST /api/open') {
      const body = await readJson(req);
      if (!body.path || typeof body.path !== 'string') throw new HttpError(400, 'No path given.');
      return send(res, 200, await openAndRemember(body.path, { pageSize: body.pageSize }));
    }
    if (route === 'POST /api/upload') {
      const name = path.basename(String(url.searchParams.get('name') || 'upload.zip')).replace(/[^\w .()-]/g, '_');
      if (!/\.(zip|html?)$/i.test(name)) throw new HttpError(400, 'Upload a .zip or .html file.');
      const dir = path.join(cacheRoot(), 'uploads', `${Date.now().toString(36)}`);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      await pipeline(req, createWriteStream(file));
      return send(res, 200, await openAndRemember(file, {}));
    }
    let m = p.match(/^\/api\/projects\/([\w-]+)$/);
    if (m && req.method === 'DELETE') { await engine.closeProject(m[1]); return send(res, 200, { ok: true }); }
    if (route === 'GET /api/preview') {
      const t = Number(url.searchParams.get('t') || 0);
      const w = Math.max(64, Math.min(1920, Number(url.searchParams.get('w') || 960)));
      const alpha = url.searchParams.get('alpha') === '1';
      const img = await engine.preview(url.searchParams.get('project'), url.searchParams.get('scene'), Number.isFinite(t) ? t : 0, Math.round(w), alpha);
      return send(res, 200, img, alpha ? 'image/png' : 'image/jpeg');
    }
    if (route === 'POST /api/render') {
      const body = await readJson(req);
      if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'Nothing to render.');
      const out = engine.enqueue({ items: body.items, settings: body.settings || {}, outDir: body.outDir || undefined, name: body.name });
      writePrefs({ settings: body.settings || {} });
      return send(res, 200, out);
    }
    if (route === 'GET /api/jobs') return send(res, 200, engine.listJobs());
    m = p.match(/^\/api\/jobs\/([\w-]+)\/cancel$/);
    if (m && req.method === 'POST') return send(res, 200, { ok: engine.cancel(m[1]) });
    if (route === 'POST /api/reveal') {
      const body = await readJson(req);
      const file = String(body.path || '');
      const known = engine.outputs();
      const ok = known.has(file) || [...known].some((d) => file.startsWith(d + path.sep));
      if (!ok || !existsSync(file)) throw new HttpError(404, 'That file is not one of this session\'s renders.');
      const [cmd, args] = revealCommand(file, !!body.open);
      spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
      return send(res, 200, { ok: true });
    }
    if (route === 'GET /api/prefs') return send(res, 200, readPrefs());
    if (route === 'PUT /api/prefs') {
      const body = await readJson(req);
      const patch = {};
      if (body.settings && typeof body.settings === 'object') patch.settings = body.settings;
      if ('outRoot' in body) patch.outRoot = body.outRoot ? String(body.outRoot) : null;
      return send(res, 200, writePrefs(patch));
    }
    if (route === 'POST /api/setup/chrome') {
      if (setup && setup.running) return send(res, 200, { running: true });
      const require = createRequire(import.meta.url);
      const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
      setup = { running: true, log: [], code: null };
      const child = spawn(process.execPath, [cli, 'install', 'chromium'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      const onData = (d) => {
        for (const line of d.toString().split(/\r|\n/).map((s) => s.trim()).filter(Boolean)) {
          setup.log.push(line); if (setup.log.length > 200) setup.log.shift();
          broadcast({ type: 'setup', line });
        }
      };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('close', (code) => { setup.running = false; setup.code = code; broadcast({ type: 'setup', done: true, code, status: engine.status() }); });
      return send(res, 200, { running: true });
    }
    throw new HttpError(404, 'Unknown endpoint.');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) { res.end(); return; }
      send(res, err.status || 500, { error: String(err.message || err), code: err.code || null });
    });
  });

  const listening = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(true); });
  }).catch(async (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    // Already running? Then reuse it.
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/status`);
      const s = await r.json();
      if (s.app === 'canvas-render') return false;
    } catch { /* not ours */ }
    const e = new Error(`Port ${port} is in use by another program. Start with --port to pick another.`);
    e.code = 'PORT_IN_USE';
    throw e;
  });

  const url = `http://127.0.0.1:${port}/`;
  if (!listening) {
    engine.off('event', broadcast);
    return { url, existing: true, close: async () => {} };
  }
  const box = mailbox ? new Mailbox(engine, { uiUrl: url }).start() : null;
  const close = async () => {
    if (box) box.stop();
    for (const res of clients) res.end();
    await new Promise((r) => server.close(r));
    await engine.close();
  };
  return { url, server, engine, mailbox: box, close };
}
