// Rendering one scene to a file.
//
// 1. Probe pass (when re-rendering is on): every frame is captured small and
//    hashed. Comparing against the hashes from the last render says which
//    frames changed.
// 2. Main pass: frames are captured at output size by one or more tabs, with
//    motion blur if asked for, and piped to ffmpeg in order.
// 3. For a re-render of an all-intra master (ProRes, PNG), only the changed
//    frames are rendered; the rest are copied from the previous master without
//    re-encoding.

import { plateCss } from './plate.mjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ScenePage } from './scene-page.mjs';
import { FrameWriter, makeReview, probe, splice } from './ffmpeg.mjs';
import { FORMATS, normalizeSettings, outputSize, pixelKey } from './settings.mjs';
import { frameCount, frameTime } from './rates.mjs';

const SIDECAR_DIR = '.canvas-render';
const PROBE_WIDTH = 480;

export function safeName(s) {
  return String(s).replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'scene';
}

export function outputPaths(outDir, scene, settings) {
  const fmt = FORMATS[settings.format];
  const base = `${safeName(scene.name)}_${fmt.suffix}`;
  const file = settings.format === 'png' ? path.join(outDir, base) : path.join(outDir, base + fmt.ext);
  return {
    file,
    review: path.join(outDir, `${safeName(scene.name)}_review.mp4`),
    sidecar: path.join(outDir, SIDECAR_DIR, `${base}.json`),
    tmp: path.join(outDir, SIDECAR_DIR, `${base}.tmp`),
  };
}

/** Sample times for one frame: just the frame, or spread across the shutter. */
export function sampleTimes(frame, rate, blur, duration) {
  const t = frameTime(frame, rate);
  if (!blur || !blur.enabled) return [t];
  const open = (blur.shutter / 360) / rate.fps;
  const out = [];
  for (let k = 0; k < blur.samples; k += 1) {
    const ts = t + ((k + 0.5) / blur.samples - 0.5) * open;
    out.push(Math.min(Math.max(0, ts), duration));
  }
  return out;
}

/**
 * Average RGBA frames in premultiplied space, so edges against transparency
 * blur the way they do in a compositor instead of picking up a dark fringe.
 */
export function accumulate(frames) {
  const n = frames.length;
  if (n === 1) return frames[0];
  const len = frames[0].length;
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 4) {
    let r = 0; let g = 0; let b = 0; let a = 0;
    for (let k = 0; k < n; k += 1) {
      const f = frames[k];
      const fa = f[i + 3];
      r += f[i] * fa; g += f[i + 1] * fa; b += f[i + 2] * fa; a += fa;
    }
    if (a === 0) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0; continue; }
    out[i] = Math.min(255, Math.round(r / a));
    out[i + 1] = Math.min(255, Math.round(g / a));
    out[i + 2] = Math.min(255, Math.round(b / a));
    out[i + 3] = Math.round(a / n);
  }
  return out;
}

async function decode(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function ranges(frames) {
  const sorted = [...frames].sort((a, b) => a - b);
  const out = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && f === last[1] + 1) last[1] = f; else out.push([f, f]);
  }
  return out;
}

function defaultWorkers(info, settings) {
  if (info.mode !== 'stage') return 1;
  if (settings.workers) return Math.max(1, Math.min(8, settings.workers));
  return Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
}

/**
 * Render a list of frames with `workers` tabs and hand them to `sink` in order.
 * sink(frameIndex, { png } | { raw, width, height })
 */
async function renderFrames(env, frames, { info, settings, scale, sink, onFrame, signal }) {
  const blur = settings.motionBlur;
  const blurOn = blur.enabled;
  const workers = Math.min(defaultWorkers(info, settings), frames.length);
  const pages = [];
  const viewport = info.mode === 'stage' ? [info.width, info.height] : [info.width, info.height];
  const plate = plateCss(settings.background);
  for (let i = 0; i < workers; i += 1) {
    const p = new ScenePage(env.browser, env.roots, env.scene, { width: viewport[0], height: viewport[1], scale, transparent: settings.transparent, plate });
    pages.push(p);
  }
  try {
    await Promise.all(pages.map((p) => p.open()));
    const results = new Map();
    let next = 0;
    let written = 0;
    let wake = null;
    const limit = workers * 3;

    const worker = async (page) => {
      for (;;) {
        if (signal && signal.aborted) return;
        const idx = next; next += 1;
        if (idx >= frames.length) return;
        while (results.size >= limit && idx > written + limit) {
          await new Promise((r) => setTimeout(r, 10)); // eslint-disable-line no-await-in-loop
        }
        const f = frames[idx];
        const times = sampleTimes(f, settings.rateInfo, blur, info.duration);
        let result;
        if (!blurOn) {
          await page.seek(times[0]);
          result = { png: await page.capture() };
        } else {
          const raws = [];
          let dims = null;
          for (const t of times) {
            await page.seek(t);
            const d = await decode(await page.capture());
            dims = d; raws.push(d.data);
          }
          result = { raw: accumulate(raws), width: dims.width, height: dims.height };
        }
        results.set(idx, result);
        if (wake) { const w = wake; wake = null; w(); }
      }
    };

    const writer = (async () => {
      while (written < frames.length) {
        if (signal && signal.aborted) return;
        if (!results.has(written)) {
          await new Promise((r) => { wake = r; setTimeout(r, 50); }); // eslint-disable-line no-await-in-loop
          continue;
        }
        const r = results.get(written);
        results.delete(written);
        await sink(frames[written], r);
        written += 1;
        if (onFrame) onFrame(written, frames.length);
      }
    })();

    await Promise.all([...pages.map(worker), writer]);
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
  } finally {
    await Promise.all(pages.map((p) => p.close()));
  }
}

async function probeHashes(env, frames, info, settings, onFrame, signal) {
  const scale = Math.min(1, PROBE_WIDTH / info.width);
  const hashes = new Array(frames.length);
  let i = 0;
  await renderFrames(env, frames, {
    info, settings: { ...settings, motionBlur: { enabled: false } }, scale, signal,
    sink: async (f, r) => {
      hashes[i] = createHash('sha1').update(r.png).digest('hex').slice(0, 20); i += 1;
    },
    onFrame,
  });
  return hashes;
}

/**
 * Render one scene.
 * env: { browser, roots, project, scene }
 * job: { info, settings, outDir, inFrame?, outFrame?, onProgress?, signal? }
 */
export async function renderScene(env, job) {
  const started = Date.now();
  const settings = normalizeSettings(job.settings);
  const { info } = job;
  const fmt = FORMATS[settings.format];
  const rate = settings.rateInfo;
  const total = frameCount(info.duration, rate);
  const inFrame = Math.max(0, Math.min(total - 1, job.inFrame ?? 0));
  const outFrame = Math.max(inFrame, Math.min(total - 1, job.outFrame ?? total - 1));
  const frames = [];
  for (let f = inFrame; f <= outFrame; f += 1) frames.push(f);
  const out = outputSize(info.width, info.height, settings);
  const paths = outputPaths(job.outDir, env.scene, settings);
  mkdirSync(path.dirname(paths.sidecar), { recursive: true });
  const progress = (phase, done, of) => job.onProgress && job.onProgress({ phase, done, total: of, elapsed: (Date.now() - started) / 1000 });
  const key = pixelKey(settings, out, info);
  const wantsReview = settings.review && settings.format !== 'h264' && settings.format !== 'png';

  // ---- which frames need rendering
  let toRender = frames;
  let reuse = null;
  let hashes = null;
  let changedCount = null;
  if (settings.partial && fmt.intra) {
    progress('checking', 0, frames.length);
    hashes = await probeHashes(env, frames, info, settings, (d, n) => progress('checking', d, n), job.signal);
    let prev = null;
    try { prev = JSON.parse(readFileSync(paths.sidecar, 'utf8')); } catch { /* first render */ }
    const masterExists = existsSync(paths.file);
    if (prev && masterExists && prev.key === key && prev.inFrame === inFrame && prev.outFrame === outFrame && prev.hashes.length === hashes.length) {
      const changed = new Set();
      const spread = settings.motionBlur.enabled ? Math.ceil(settings.motionBlur.shutter / 360) : 0;
      hashes.forEach((h, i) => {
        if (h !== prev.hashes[i]) for (let d = -spread; d <= spread; d += 1) if (i + d >= 0 && i + d < hashes.length) changed.add(i + d);
      });
      changedCount = changed.size;
      if (changed.size === 0) {
        // Nothing to render, but the review copy may be missing or older than the master.
        let review = null;
        if (wantsReview) {
          if (!existsSync(paths.review) || statSync(paths.review).mtimeMs < statSync(paths.file).mtimeMs) {
            progress('review', 0, 1);
            await makeReview(paths.file, paths.review, { alpha: fmt.alpha });
          }
          review = paths.review;
        }
        progress('done', frames.length, frames.length);
        return finish({ reused: frames.length, rendered: 0, upToDate: true, review });
      }
      if (changed.size < frames.length * 0.7) {
        toRender = [...changed].sort((a, b) => a - b).map((i) => frames[i]);
        reuse = prev;
      }
    }
  }

  // ---- render
  rmSync(paths.tmp, { recursive: true, force: true });
  mkdirSync(paths.tmp, { recursive: true });
  const scale = out.width / info.width;
  const alphaInput = !!settings.transparent;
  const renderEnv = { ...env };

  if (settings.format === 'png') {
    mkdirSync(paths.file, { recursive: true });
    const name = (f) => path.join(paths.file, `${safeName(env.scene.name)}_${String(f).padStart(5, '0')}.png`);
    await renderFrames(renderEnv, toRender, {
      info, settings, scale, signal: job.signal,
      onFrame: (d, n) => progress('rendering', d, n),
      sink: async (f, r) => {
        const png = r.png
          ? (await sharp(r.png).resize(out.width, out.height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer())
          : await sharp(r.raw, { raw: { width: r.width, height: r.height, channels: 4 } }).resize(out.width, out.height, { fit: 'fill' }).png().toBuffer();
        writeFileSync(name(f), png);
      },
    });
  } else if (!reuse) {
    const tmpFile = path.join(paths.tmp, `full${fmt.ext}`);
    await encodeFrames(renderEnv, toRender, tmpFile, { info, settings, scale, out, alphaInput, job, progress });
    renameSync(tmpFile, paths.file);
  } else {
    // Render each changed run into its own segment, then splice.
    const runs = ranges(toRender.map((f) => f - inFrame));
    const segs = [];
    let doneCount = 0;
    for (let k = 0; k < runs.length; k += 1) {
      const [a, b] = runs[k];
      const seg = path.join(paths.tmp, `seg${k}${fmt.ext}`);
      const segFrames = []; for (let i = a; i <= b; i += 1) segFrames.push(frames[i]);
      await encodeFrames(renderEnv, segFrames, seg, {
        info, settings, scale, out, alphaInput, job,
        progress: (phase, d) => progress('rendering', doneCount + d, toRender.length),
      });
      doneCount += segFrames.length;
      segs.push({ a, b, file: seg });
    }
    progress('splicing', 0, 1);
    const parts = [];
    let cursor = 0;
    for (const s of segs) {
      if (s.a > cursor) parts.push({ file: paths.file, inFrame: cursor, outFrame: s.a - 1 });
      parts.push({ file: s.file });
      cursor = s.b + 1;
    }
    if (cursor < frames.length) parts.push({ file: paths.file, inFrame: cursor, outFrame: frames.length - 1 });
    const spliced = path.join(paths.tmp, `spliced${fmt.ext}`);
    await splice(parts, spliced, rate, path.join(paths.tmp, 'parts.ffconcat'));
    const check = await probe(spliced);
    if (check.frames !== frames.length) {
      // Something about the old master was off. Fall back to a full render.
      const tmpFile = path.join(paths.tmp, `full${fmt.ext}`);
      await encodeFrames(renderEnv, frames, tmpFile, { info, settings, scale, out, alphaInput, job, progress });
      renameSync(tmpFile, paths.file);
      toRender = frames;
    } else {
      renameSync(spliced, paths.file);
    }
  }
  rmSync(paths.tmp, { recursive: true, force: true });

  // ---- review copy
  let review = null;
  if (wantsReview) {
    progress('review', 0, 1);
    await makeReview(paths.file, paths.review, { alpha: fmt.alpha });
    review = paths.review;
  }

  if (hashes) {
    writeFileSync(paths.sidecar, JSON.stringify({ v: 1, key, inFrame, outFrame, hashes, rendered: new Date().toISOString() }));
  }
  progress('done', frames.length, frames.length);
  return finish({ reused: frames.length - toRender.length, rendered: toRender.length, upToDate: false, review });

  function finish(extra) {
    const markers = (info.scenes || []).map((s) => ({
      name: s.name, desc: s.desc,
      frame: Math.round((s.start * rate.num) / rate.den) - inFrame,
    })).filter((m) => m.frame >= 0 && m.frame <= outFrame - inFrame);
    return {
      scene: env.scene.name,
      changed: changedCount,
      file: paths.file,
      format: settings.format,
      alpha: fmt.alpha,
      width: out.width,
      height: out.height,
      rate: rate.label,
      frames: frames.length,
      inFrame,
      outFrame,
      markers,
      seconds: (Date.now() - started) / 1000,
      review: null,
      ...extra,
    };
  }
}

async function encodeFrames(env, frames, file, { info, settings, scale, out, alphaInput, job, progress }) {
  let writer = null;
  const makeWriter = (input, w, h) => new FrameWriter({
    file, format: settings.format, rate: settings.rateInfo, width: out.width, height: out.height,
    srcWidth: w, srcHeight: h, input, alphaInput,
  });
  try {
    await renderFrames(env, frames, {
      info, settings, scale, signal: job.signal,
      onFrame: (d, n) => progress('rendering', d, n),
      sink: async (f, r) => {
        if (!writer) writer = r.png ? makeWriter('png') : makeWriter('raw', r.width, r.height);
        await writer.write(r.png || r.raw);
      },
    });
    if (writer) await writer.close();
  } catch (err) {
    if (writer) writer.abort();
    throw err;
  }
}
