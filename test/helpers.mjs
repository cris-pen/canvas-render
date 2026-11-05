// Test helpers: a tiny zip writer, temp folders and tool checks.

import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tools } from '../engine/src/ffmpeg.mjs';
import { findChrome } from '../engine/src/browser.mjs';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

export function tmp(prefix = 'cr-test-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A copy of a fixture folder that a test may edit. */
export function copyFixture(name) {
  const dir = path.join(tmp(), name);
  cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Write a zip from [{ name, data }] entries. */
export function writeZip(file, entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const data = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(file, Buffer.concat([...locals, cd, end]));
  return file;
}

/** Zip a folder, optionally inside one top-level folder like some exports. */
export function zipFolder(dir, file, { wrap = null } = {}) {
  const entries = [];
  (function walk(d, rel) {
    for (const n of readdirSync(d).sort()) {
      const p = path.join(d, n); const r = rel ? `${rel}/${n}` : n;
      if (statSync(p).isDirectory()) walk(p, r); else entries.push({ name: wrap ? `${wrap}/${r}` : r, data: readFileSync(p) });
    }
  })(dir, '');
  return writeZip(file, entries);
}

export function canRender() {
  const t = tools();
  if (!t.ffmpeg || !t.has('prores_ks')) return 'ffmpeg with prores_ks is not installed';
  if (!findChrome()) return 'no Chrome or Chromium found';
  return false;
}
