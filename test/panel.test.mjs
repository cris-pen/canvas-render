// The Premiere panel, run in Chromium against stand-ins for Premiere's UXP
// modules (fs, os, uxp, premierepro), talking to a real engine through the
// real mailbox. This covers everything except Premiere itself.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from '../engine/src/browser.mjs';
import { FIXTURES, canRender, tmp, copyFixture } from './helpers.mjs';

const skip = canRender();
const HOME = tmp('cr-home-');
process.env.CANVAS_RENDER_CACHE = process.env.CANVAS_RENDER_CACHE || tmp('cr-cache-');
process.env.CANVAS_RENDER_DATA = path.join(HOME, 'Library', 'Application Support', 'Canvas Render');
const PANEL = path.resolve(FIXTURES, '../panel');
const port = 49000 + Math.floor(Math.random() * 500);
let srv; let bridge; let browser; let page; let bridgePort;

// Lets the page's fake fs reach the disk, but only inside the fake home.
function startBridge() {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      if (req.method === 'GET') {
        const file = path.join(PANEL, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/panel\//, '')));
        if (!file.startsWith(PANEL) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript' });
        res.end(readFileSync(file));
        return;
      }
      let body = ''; for await (const c of req) body += c;
      const { op, p, to, data } = JSON.parse(body);
      const inside = (x) => path.resolve(x).startsWith(HOME) || path.resolve(x).startsWith(path.resolve(FIXTURES, '..')) || path.resolve(x).startsWith(path.resolve(process.env.TMPDIR || '/tmp'));
      try {
        if (![p, to].filter(Boolean).every(inside)) throw new Error('outside the sandbox');
        let out = null;
        if (op === 'read') out = readFileSync(p, 'utf8');
        else if (op === 'write') { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); }
        else if (op === 'rename') renameSync(p, to);
        else if (op === 'readdir') out = readdirSync(p);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ out }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message }));
      }
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

// Stand-ins for the UXP modules, installed before panel/main.js runs.
const STUBS = (home, bridgeUrl) => `
  const call = async (op, args) => {
    const r = await fetch('${bridgeUrl}/fs', { method: 'POST', body: JSON.stringify({ op, ...args }) });
    const j = await r.json(); if (j.error) throw new Error(j.error); return j.out;
  };
  const strip = (u) => String(u).replace(/^file:/, '');
  window.__log = { imports: [], external: [], bins: [] };
  function bin(name) {
    return { name, isBin: true, children: [], async getItems() { return this.children.slice(); },
      createBinAction(n) { const self = this; return { apply() { const b = bin(n); self.children.push(b); window.__log.bins.push(n); } }; } };
  }
  const root = bin('root');
  const project = {
    path: '${home}/Projects/Edit.prproj',
    async getRootItem() { return root; },
    lockedAccess(fn) { fn(); },
    executeTransaction(fn) { fn({ addAction(a) { a.apply(); return true; } }); return true; },
    async importFiles(paths, suppress, target, stills) {
      window.__log.imports.push({ paths, bin: target.name, stills });
      for (const p of paths) target.children.push({ name: p.split('/').pop(), clip: true, path: p, async getMediaFilePath() { return this.path; } });
      return true;
    },
  };
  const modules = {
    fs: {
      readFile: (u) => call('read', { p: strip(u) }),
      writeFile: (u, data) => call('write', { p: strip(u), data }),
      rename: (a, b) => call('rename', { p: strip(a), to: strip(b) }),
      readdir: (u) => call('readdir', { p: strip(u) }),
    },
    os: { homedir: () => '${home}', platform: () => 'darwin' },
    uxp: {
      storage: { localFileSystem: {
        getFileForOpening: async () => ({ nativePath: window.__pick }),
        getFolder: async () => ({ nativePath: window.__pick }),
      } },
      shell: { openExternal: async (u) => { window.__log.external.push(u); } },
    },
    premierepro: {
      Project: { getActiveProject: async () => project },
      FolderItem: { cast: (i) => (i && i.isBin ? i : null) },
      ClipProjectItem: { cast: (i) => (i && i.clip ? i : null) },
    },
  };
  window.require = (name) => { if (!modules[name]) throw new Error('no module ' + name); return modules[name]; };
`;

before(async () => {
  if (skip) return;
  const { startServer } = await import('../engine/src/server.mjs');
  srv = await startServer({ port });
  bridge = await startBridge();
  bridgePort = bridge.address().port;
  browser = await chromium.launch({ executablePath: findChrome() });
  page = await browser.newPage({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2 });
  await page.addInitScript({ content: STUBS(HOME, `http://127.0.0.1:${bridgePort}`) });
  await page.goto(`http://127.0.0.1:${bridgePort}/panel/index.html`);
});

after(async () => {
  if (browser) await browser.close();
  if (bridge) bridge.close();
  if (srv) await srv.close();
});

const text = (sel) => page.textContent(sel);

test('the panel sees the running app', { skip }, async () => {
  await page.waitForFunction(() => document.getElementById('engineState').textContent.includes('running'), null, { timeout: 10000 });
  const presets = await page.$$eval('#presetSelect option', (o) => o.map((x) => x.value));
  assert.ok(presets.includes('master-alpha'));
  assert.equal(await page.isHidden("#launchButton"), true);
});

let source;
test('choosing an export lists its scenes', { skip }, async () => {
  source = copyFixture('claude-export');
  await page.evaluate((p) => { window.__pick = p; }, source);
  await page.click('#chooseFile');
  await page.waitForSelector('#sceneList .scene', { timeout: 60000 });
  const scenes = await page.$$eval('#sceneList .scene', (rows) => rows.map((r) => [r.querySelector('.name').textContent, r.querySelector('input').checked, r.querySelector('input').disabled]));
  assert.deepEqual(scenes.find((s) => s[0] === 'Lower Third'), ['Lower Third', true, false]);
  assert.deepEqual(scenes.find((s) => s[0] === 'Unused Board'), ['Unused Board', false, true]);
});

test('render and import puts clips in a Canvas Render bin beside the project', { skip }, async () => {
  await page.selectOption('#rateSelect', '24');
  await page.click('#renderButton');
  await page.waitForFunction(() => /Imported/.test(document.getElementById('message').textContent), null, { timeout: 120000 });
  const log = await page.evaluate(() => window.__log);
  assert.deepEqual(log.bins, ['Canvas Render', 'claude-export']);
  assert.equal(log.imports.length, 1);
  const file = log.imports[0].paths[0];
  assert.equal(file, path.join(HOME, 'Projects', 'Canvas Render', 'claude-export', 'Lower Third_4444.mov'));
  assert.ok(existsSync(file));
  assert.equal(log.imports[0].bin, 'claude-export');
  assert.match(await text('#jobList'), /Done, 48 frames/);
  // Set CANVAS_RENDER_SHOTS to a folder to save this state for the README.
  if (process.env.CANVAS_RENDER_SHOTS) await page.screenshot({ path: path.join(process.env.CANVAS_RENDER_SHOTS, 'panel.png'), fullPage: true });
});

test('rendering again updates the clip in place', { skip }, async () => {
  await page.click('#renderButton');
  await page.waitForFunction(() => /updated in place/.test(document.getElementById('message').textContent), null, { timeout: 120000 });
  assert.match(await text('#jobList'), /Already up to date|re-rendered/);
  const log = await page.evaluate(() => window.__log);
  assert.equal(log.imports.length, 1, 'no duplicate import');
});

test('a sequence import brings in the timeline XML', { skip }, async () => {
  await page.check('#importSequence');
  await page.click('#renderButton');
  await page.waitForFunction(() => /Imported a sequence/.test(document.getElementById('message').textContent), null, { timeout: 120000 });
  const log = await page.evaluate(() => window.__log);
  const last = log.imports[log.imports.length - 1];
  assert.match(last.paths[0], /claude-export_timeline\.xml$/);
});
