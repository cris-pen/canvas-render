// ffmpeg: finding it, encoding frames piped from the renderer, and splicing.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CANDIDATES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin'];

function findTool(name) {
  const env = process.env[`CANVAS_RENDER_${name.toUpperCase()}`];
  if (env && existsSync(env)) return env;
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...CANDIDATES];
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

let cached = null;
export function tools() {
  if (cached) return cached;
  const ffmpeg = findTool('ffmpeg');
  const ffprobe = findTool('ffprobe');
  let encoders = '';
  let version = '';
  if (ffmpeg) {
    try { encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* ignore */ }
    try { version = execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0]; } catch { /* ignore */ }
  }
  cached = {
    ffmpeg, ffprobe, version,
    has: (enc) => new RegExp(`\\s${enc}\\s`).test(encoders),
  };
  return cached;
}

export function requireTools() {
  const t = tools();
  if (!t.ffmpeg || !t.ffprobe) {
    const err = new Error('ffmpeg was not found. Install it with Homebrew:  brew install ffmpeg');
    err.code = 'NO_FFMPEG';
    throw err;
  }
  return t;
}

const BT709 = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
// ffmpeg 7.1 and later take an encoder's colour tags from the frames it is
// given, so the options above alone leave the file untagged. Tag the frames too.
const TAG709 = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';

/** ffmpeg output arguments for a format. `flatten` composites alpha over black for formats without alpha. */
export function outputArgs(format, { rate, width, height, alphaInput }) {
  const t = tools();
  const scale = `scale=${width}:${height}:flags=lanczos:out_color_matrix=bt709:out_range=tv`;
  switch (format) {
    case 'prores4444':
    case 'prores4444xq':
      return ['-vf', `${scale},format=yuva444p10le,${TAG709}`, '-c:v', 'prores_ks', '-profile:v', format === 'prores4444xq' ? '5' : '4',
        '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0', ...BT709, '-timecode', '00:00:00:00'];
    case 'prores422hq':
      return ['-vf', `${flatten(alphaInput)}${scale},format=yuv422p10le,${TAG709}`, '-c:v', 'prores_ks', '-profile:v', '3',
        '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0', ...BT709, '-timecode', '00:00:00:00'];
    case 'h264': {
      const enc = t.has('libx264')
        ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-tune', 'animation']
        : ['-c:v', 'h264_videotoolbox', '-b:v', '24M'];
      return ['-vf', `${flatten(alphaInput)}${scale},format=yuv420p,${TAG709}`, ...enc, '-pix_fmt', 'yuv420p', ...BT709, '-movflags', '+faststart'];
    }
    default:
      throw new Error(`no encoder for ${format} (rate ${rate.label})`);
  }
}

// Formats without alpha get the frame composited over black, the way an NLE
// would show it on an empty track.
function flatten(alphaInput) {
  return alphaInput ? 'format=gbrap,premultiply=inplace=1,' : '';
}

/**
 * A running ffmpeg that takes frames on stdin.
 * input: 'png' (PNG buffers) or 'raw' (RGBA buffers of width×height).
 */
export class FrameWriter {
  constructor({ file, format, rate, width, height, srcWidth, srcHeight, input, alphaInput }) {
    const t = requireTools();
    const inArgs = input === 'raw'
      ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${srcWidth}x${srcHeight}`, '-framerate', rate.ffmpeg, '-i', 'pipe:0']
      : ['-f', 'image2pipe', '-c:v', 'png', '-framerate', rate.ffmpeg, '-i', 'pipe:0'];
    const args = ['-hide_banner', '-loglevel', 'error', '-y', ...inArgs,
      ...outputArgs(format, { rate, width, height, alphaInput }), '-r', rate.ffmpeg, file];
    this.args = args;
    this.proc = spawn(t.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.stderr = '';
    this.proc.stderr.on('data', (d) => { this.stderr += d; if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000); });
    this.done = new Promise((resolve, reject) => {
      this.proc.on('error', reject);
      this.proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${this.stderr.trim().slice(-800)}`))));
    });
    this.proc.stdin.on('error', () => { /* surfaced through `done` */ });
  }

  write(buf) {
    if (this.proc.stdin.write(buf)) return Promise.resolve();
    return new Promise((resolve) => this.proc.stdin.once('drain', resolve));
  }

  async close() {
    this.proc.stdin.end();
    await this.done;
  }

  abort() {
    try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

export function run(args, { tool = 'ffmpeg' } = {}) {
  const t = requireTools();
  return new Promise((resolve, reject) => {
    const proc = spawn(t[tool], args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${tool} exited ${code}: ${err.trim().slice(-800)}`))));
  });
}

export async function probe(file) {
  const out = await run(['-v', 'error', '-count_packets', '-show_entries',
    'stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,nb_read_packets,color_primaries,color_transfer,color_space:format=duration',
    '-of', 'json', file], { tool: 'ffprobe' });
  const j = JSON.parse(out);
  const s = (j.streams || [])[0] || {};
  return {
    codec: s.codec_name, profile: s.profile, width: s.width, height: s.height, pixFmt: s.pix_fmt,
    rate: s.r_frame_rate, frames: Number(s.nb_read_packets), duration: Number((j.format || {}).duration),
    color: [s.color_primaries, s.color_transfer, s.color_space],
  };
}

/** Transcode a master to an H.264 review copy. */
export async function makeReview(master, file, { alpha }) {
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', master,
    '-vf', `${alpha ? 'format=gbrap,premultiply=inplace=1,' : ''}format=yuv420p,${TAG709}`,
    ...(tools().has('libx264') ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'] : ['-c:v', 'h264_videotoolbox', '-b:v', '16M']),
    '-pix_fmt', 'yuv420p', ...BT709, '-movflags', '+faststart', file]);
}

/**
 * Join pieces of all-intra movies without re-encoding.
 * parts: [{ file, inFrame?, outFrame? }] with frame ranges inclusive, in the
 * file's own frame numbers.
 */
export async function splice(parts, file, rate, listFile) {
  const { writeFileSync } = await import('node:fs');
  const lines = ['ffconcat version 1.0'];
  for (const p of parts) {
    lines.push(`file '${p.file.replace(/'/g, "'\\''")}'`);
    if (p.inFrame != null) {
      // Half-frame offsets keep the cut points off frame boundaries, so
      // rounding can never pull in a neighbour.
      // Seeking lands on the last frame at or before the inpoint, so aim just past the frame start.
        if (p.inFrame > 0) lines.push(`inpoint ${(((p.inFrame + 0.01) * rate.den) / rate.num).toFixed(6)}`);
      lines.push(`outpoint ${(((p.outFrame + 0.5) * rate.den) / rate.num).toFixed(6)}`);
    }
  }
  writeFileSync(listFile, `${lines.join('\n')}\n`);
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-map', '0:v:0', '-c', 'copy', '-timecode', '00:00:00:00', file]);
}
