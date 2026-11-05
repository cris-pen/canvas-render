// Turning what an editor was sent into a list of scenes.
//
//   .zip           A Claude Design project export: one scene per board (.dc.html)
//                  at the top level, plus standalone HTML exports. Other HTML in
//                  the archive is listed separately, unticked.
//   .html / .htm   One scene. Also covers Claude Design "standalone HTML".
//   folder         Same as an unzipped project.
//   http(s) URL    One scene, loaded straight from the web.

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { cacheRoot, PROJECT_ORIGIN } from './browser.mjs';

const HTML = /\.(html?)$/i;

function slug(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

/** Extract a zip once per version of the file. */
async function extractZip(file) {
  const st = statSync(file);
  const dir = path.join(cacheRoot(), 'projects', slug(`${path.resolve(file)}:${st.size}:${st.mtimeMs}`));
  const marker = path.join(dir, '.extracted');
  if (existsSync(marker)) return dir;
  mkdirSync(dir, { recursive: true });
  const zip = await openZip(file);
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (entry) => {
      const name = entry.fileName.replace(/\\/g, '/');
      if (name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name)) { zip.readEntry(); return; }
      const dest = path.resolve(dir, name);
      if (!dest.startsWith(path.resolve(dir) + path.sep)) { zip.readEntry(); return; } // zip-slip
      if (name.endsWith('/')) { mkdirSync(dest, { recursive: true }); zip.readEntry(); return; }
      mkdirSync(path.dirname(dest), { recursive: true });
      zip.openReadStream(entry, (err, stream) => {
        if (err) { reject(err); return; }
        pipeline(stream, createWriteStream(dest)).then(() => zip.readEntry(), reject);
      });
    });
    zip.readEntry();
  });
  writeFileSync(marker, new Date().toISOString());
  return dir;
}

// Claude Design exports sometimes nest everything inside one top-level folder.
function unwrap(dir) {
  const entries = readdirSync(dir).filter((n) => !n.startsWith('.') && n !== '__MACOSX');
  if (entries.length === 1 && statSync(path.join(dir, entries[0])).isDirectory()) return path.join(dir, entries[0]);
  return dir;
}

function sceneName(file) {
  return path.basename(file).replace(/\.dc\.html$/i, '').replace(HTML, '');
}

function classify(dir, rel) {
  const name = path.basename(rel);
  const isDc = /\.dc\.html$/i.test(name);
  const top = !rel.includes('/');
  let kind = 'html';
  let note = '';
  let selected = top;
  let empty = false;
  if (isDc) {
    kind = 'board';
    if (!existsSync(path.join(dir, path.dirname(rel), 'support.js'))) {
      note = 'support.js is missing from this export, so the board may not load. Try the standalone HTML export.';
    }
    // A board with nothing in it but a canvas of other boards is a layout page.
    try {
      const src = readFileSync(path.join(dir, rel), 'utf8');
      const body = (src.match(/<x-dc>([\s\S]*?)<\/x-dc>/i) || [])[1];
      if (body !== undefined && !body.trim()) { selected = false; empty = true; note = 'Empty board, nothing to render.'; }
    } catch { /* ignore */ }
  } else if (/standalone/i.test(name)) {
    kind = 'standalone';
  } else if (/^(preview|index)\.html?$/i.test(name) && !top) {
    selected = false;
  }
  return { kind, note, selected, empty };
}

function walk(dir, base = '', depth = 0, out = []) {
  for (const name of readdirSync(path.join(dir, base))) {
    if (name.startsWith('.') || name === 'node_modules' || name === '__MACOSX' || name === '_ds') continue;
    const rel = base ? `${base}/${name}` : name;
    const st = statSync(path.join(dir, rel));
    if (st.isDirectory()) { if (depth < 2) walk(dir, rel, depth + 1, out); } else if (HTML.test(name)) out.push(rel);
  }
  return out;
}

export async function openProject(input) {
  if (/^https?:\/\//i.test(input)) {
    if (/^https:\/\/(claude\.ai|[a-z0-9-]+\.claude\.ai)\//i.test(input)) {
      const err = new Error('Claude share links need you to be signed in. Open the artifact, choose Export > Download as .zip, and drop the zip here.');
      err.code = 'CLAUDE_LINK';
      throw err;
    }
    const id = slug(input);
    return {
      id, name: new URL(input).hostname, source: input, root: null, url: input,
      scenes: [{ id: 's1', name: new URL(input).pathname.split('/').filter(Boolean).pop() || new URL(input).hostname, kind: 'url', url: input, rel: null, selected: true, note: '' }],
    };
  }

  const abs = path.resolve(input);
  if (!existsSync(abs)) throw new Error(`Not found: ${abs}`);
  const st = statSync(abs);
  let root; let only = null; let name;
  if (st.isDirectory()) { root = abs; name = path.basename(abs); } else if (/\.zip$/i.test(abs)) {
    root = unwrap(await extractZip(abs)); name = path.basename(abs).replace(/\.zip$/i, '');
  } else if (HTML.test(abs)) {
    root = path.dirname(abs); only = path.basename(abs); name = sceneName(abs);
  } else {
    throw new Error('Drop a Claude Design .zip export, an .html file, or a folder.');
  }

  const id = slug(`${abs}:${st.mtimeMs}`);
  const files = only ? [only] : walk(root);
  const scenes = files.map((rel, i) => {
    const c = classify(root, rel);
    return {
      id: `s${i + 1}`, name: sceneName(rel), rel, kind: c.kind, note: c.note, selected: only ? true : c.selected, empty: c.empty,
      url: `${PROJECT_ORIGIN}/${id}/${rel.split('/').map(encodeURIComponent).join('/')}`,
    };
  });
  // Boards first, then standalone exports, then everything else.
  const order = { board: 0, standalone: 1, html: 2, url: 3 };
  scenes.sort((a, b) => (!!a.empty - !!b.empty) || (order[a.kind] - order[b.kind]) || (a.rel.includes('/') - b.rel.includes('/')) || a.name.localeCompare(b.name));
  // When both a board and its standalone export are present, the board wins.
  const boards = new Set(scenes.filter((s) => s.kind === 'board').map((s) => s.name.toLowerCase()));
  for (const s of scenes) {
    if (s.kind === 'standalone') {
      const base = s.name.replace(/\s*-?\s*standalone$/i, '').toLowerCase();
      if (boards.has(base)) { s.selected = false; s.note = s.note || 'Same board as the .dc.html above.'; } else {
        // The kind label already says it is a standalone export.
        s.name = s.name.replace(/\s*-?\s*standalone$/i, '') || s.name;
      }
    }
  }
  if (!scenes.length) throw new Error('No HTML pages found in that file.');
  return { id, name, source: abs, mtime: st.mtimeMs, root, scenes };
}
