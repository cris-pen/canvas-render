// Chromium: finding one, launching it, and serving projects and CDN files to it.

import { chromium } from 'playwright-core';
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const PROJECT_ORIGIN = 'https://project.canvas-render.local';

export function cacheRoot() {
  const base = process.env.CANVAS_RENDER_CACHE
    || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'Canvas Render') : path.join(os.homedir(), '.cache', 'canvas-render'));
  mkdirSync(base, { recursive: true });
  return base;
}

const MAC_CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

/** Where Chromium lives. Order: explicit setting, Playwright's own download, any Chrome on the machine. */
export function findChrome() {
  if (process.env.CANVAS_RENDER_CHROME && existsSync(process.env.CANVAS_RENDER_CHROME)) return process.env.CANVAS_RENDER_CHROME;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* not downloaded */ }
  // A Playwright download of a different revision is fine too.
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright') : path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(root, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  if (process.platform === 'darwin') {
    for (const p of MAC_CHROMES) if (existsSync(p)) return p;
  }
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) if (existsSync(p)) return p;
  return null;
}

// Flags that keep renders consistent: one colour profile, no LCD text (which
// cannot be composited over alpha), no font hinting (which snaps text to whole
// pixels and makes slow moves judder).
const ARGS = [
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--font-render-hinting=none',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

export async function launchBrowser() {
  const executablePath = findChrome();
  if (!executablePath) {
    const err = new Error('No Chrome or Chromium found. Install Google Chrome, or run:  npx playwright-core install chromium');
    err.code = 'NO_CHROME';
    throw err;
  }
  return chromium.launch({ executablePath, headless: true, args: ARGS });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.jsx': 'text/javascript; charset=utf-8', '.ts': 'text/javascript; charset=utf-8',
  '.tsx': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// Hosts whose files are worth keeping. Claude Design boards load React and
// Babel from unpkg each time they open; keeping a copy makes renders work
// offline and saves a round trip per board.
const CACHEABLE = /^https:\/\/(unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|esm\.sh)\//;

/**
 * Give a browser context access to project folders and the CDN cache.
 * roots: Map of projectId -> folder on disk, served at PROJECT_ORIGIN/<id>/.
 */
export async function wireContext(context, roots) {
  await context.route(`${PROJECT_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const [, id, ...rest] = decodeURIComponent(url.pathname).split('/');
    const root = roots.get(id);
    if (!root) return route.fulfill({ status: 404, body: 'unknown project' });
    const file = path.resolve(root, rest.join('/'));
    if (!file.startsWith(path.resolve(root) + path.sep) && file !== path.resolve(root)) return route.fulfill({ status: 403, body: 'outside project' });
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      const body = await readFile(file);
      return route.fulfill({ status: 200, body, headers: { 'content-type': mimeFor(file), 'access-control-allow-origin': '*' } });
    } catch {
      return route.fulfill({ status: 404, body: 'not found' });
    }
  });

  const cdnDir = path.join(cacheRoot(), 'cdn');
  mkdirSync(cdnDir, { recursive: true });
  await context.route(CACHEABLE, async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') return route.continue();
    const key = createHash('sha1').update(req.url()).digest('hex');
    const bodyFile = path.join(cdnDir, key);
    const metaFile = `${bodyFile}.json`;
    if (existsSync(bodyFile) && existsSync(metaFile)) {
      try {
        const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
        return route.fulfill({ status: 200, body: readFileSync(bodyFile), headers: { 'content-type': meta.type, 'access-control-allow-origin': '*' } });
      } catch { /* fall through to the network */ }
    }
    try {
      const response = await route.fetch();
      if (response.ok()) {
        const body = await response.body();
        const type = response.headers()['content-type'] || 'application/octet-stream';
        writeFileSync(bodyFile, body);
        writeFileSync(metaFile, JSON.stringify({ url: req.url(), type }));
        return route.fulfill({ status: 200, body, headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
      }
      return route.fulfill({ response });
    } catch (err) {
      return route.abort('internetdisconnected');
    }
  });
}

export { createReadStream };
