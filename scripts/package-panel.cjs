// Packages panel/ into a .ccx installer for Premiere Pro, the same way UXP
// Developer Tool's Package command does: a zip of manifest.json and the
// files the panel loads at runtime. Run with: npm run panel
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const panel = path.join(root, 'panel');
const release = path.join(root, 'release');

function fail(msg) { console.error(`package-panel: ${msg}`); process.exit(1); }

const manifest = JSON.parse(fs.readFileSync(path.join(panel, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.manifestVersion !== 5) fail('manifestVersion must be 5.');
if (manifest.host.app !== 'premierepro') fail('the panel must target premierepro.');
if (manifest.version !== pkg.version) fail(`panel version ${manifest.version} does not match package.json ${pkg.version}.`);

// manifest, its main HTML, every local file that HTML links, and the icons.
const html = fs.readFileSync(path.join(panel, manifest.main), 'utf8');
const files = new Set(['manifest.json', manifest.main]);
for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
  const ref = m[1].split(/[?#]/)[0];
  if (ref && !/^[a-z]+:/i.test(ref)) files.add(path.posix.normalize(ref));
}
for (const icon of manifest.icons || []) {
  const dir = path.posix.dirname(icon.path);
  const base = path.posix.basename(icon.path, path.posix.extname(icon.path));
  for (const n of fs.readdirSync(path.join(panel, dir))) if (n === path.posix.basename(icon.path) || n.startsWith(`${base}@`)) files.add(path.posix.join(dir, n));
}
for (const f of files) if (!fs.existsSync(path.join(panel, f))) fail(`missing ${f}`);
for (const f of files) if (f.endsWith('.js')) { const r = spawnSync(process.execPath, ['--check', path.join(panel, f)], { stdio: 'inherit' }); if (r.status) fail(`${f} has a syntax error`); }

fs.mkdirSync(release, { recursive: true });
const out = path.join(release, `${manifest.id}_${manifest.host.app}.ccx`);
fs.rmSync(out, { force: true });
const r = spawnSync('zip', ['-X', '-D', '-9', '-q', out, ...[...files].sort()], { cwd: panel, stdio: 'inherit' });
if (r.error) fail(`could not run zip: ${r.error.message}`);
if (r.status) fail(`zip exited with ${r.status}`);
console.log(`Packaged ${manifest.name} ${manifest.version}: ${path.relative(root, out)}`);
console.log([...files].sort().map((f) => `  ${f}`).join('\n'));
