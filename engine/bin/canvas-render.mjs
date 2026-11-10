#!/usr/bin/env node
// canvas-render: command line for the render engine.
//
//   canvas-render info   <zip|html|folder|url>
//   canvas-render render <zip|html|folder|url> [options]
//   canvas-render serve  [--port 47800] [--open]

import path from 'node:path';
import { PLATE_PRESETS } from '../src/plate.mjs';
import { Engine } from '../src/engine.mjs';
import { FORMATS } from '../src/settings.mjs';
import { RATES } from '../src/rates.mjs';

const HELP = `canvas-render: render Claude Design exports and HTML animations to video.

  canvas-render info   <input>              list scenes with size, length and sections
  canvas-render render <input> [options]    render scenes
  canvas-render serve  [--port N] [--open]  start the app server and UI

<input> is a Claude Design .zip export, an .html file, a folder, or a URL.

render options:
  --scene NAME         only scenes whose name contains NAME (repeatable)
  --all                include scenes that are unticked by default
  --format F           ${Object.keys(FORMATS).join(' | ')}   (default prores4444)
                       ae writes an After Effects script that builds editable layers
  --ae-fallback K      with --format ae: trade an editable layer for an exact one (gradients | all)
  --rate R             ${Object.keys(RATES).join(' | ')}   (default 23.976)
  --size S             native | half | hd | uhd   (default native)
  --width N            output width in pixels (keeps aspect)
  --blur [ANGLE:N]     motion blur, shutter angle and samples (default 180:8)
  --transparent        drop the page background
  --bg B               put a plate behind the render: #rrggbb | linear:ANGLE:#from:#to |
                       radial:#from:#to | image:PATH | a preset (ink, studio, dusk, sea,
                       paper, black, white, green, blue)
  --bg-replace         with --bg: also clear the design's own background fill
  --in F --out F       frame range (inclusive)
  --review             also write an H.264 review copy
  --full               render every frame even if a previous render can be reused
  --no-xml             skip the Premiere/Resolve timeline XML
  --page WxH           frame size for plain HTML pages (default: detect, 1920x1080)
  --workers N          capture tabs for Claude Design boards (default: automatic)
  --out-dir DIR        where files go (default ~/Movies/Canvas Render/<project>)
`;

/** --bg value to a plate (see engine/src/plate.mjs). */
function parseBackground(v) {
  const preset = PLATE_PRESETS.find((p) => p.id === String(v).toLowerCase());
  if (preset) return { ...preset.plate };
  if (/^#[0-9a-f]{6}$/i.test(v)) return { mode: 'color', color: v };
  const [kind, ...rest] = String(v).split(':');
  if (kind === 'linear') return { mode: 'gradient', gradient: { kind, angle: Number(rest[0]), from: rest[1], to: rest[2] } };
  if (kind === 'radial') return { mode: 'gradient', gradient: { kind, from: rest[0], to: rest[1] } };
  if (kind === 'image') return { mode: 'image', image: rest.join(':') };
  throw new Error(`--bg ${v}: use #rrggbb, linear:ANGLE:#from:#to, radial:#from:#to, image:PATH or a preset name.`);
}

function parse(argv) {
  const args = { _: [], scene: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`${a} needs a value`); return argv[i]; };
    switch (a) {
      case '--scene': args.scene.push(next()); break;
      case '--all': args.all = true; break;
      case '--format': args.format = next(); break;
      case '--ae-fallback': (args.aeFallbacks = args.aeFallbacks || []).push(next()); break;
      case '--rate': args.rate = next(); break;
      case '--size': args.size = next(); break;
      case '--width': args.width = Number(next()); break;
      case '--blur': {
        args.blur = { enabled: true, shutter: 180, samples: 8 };
        if (argv[i + 1] && /^\d+(:\d+)?$/.test(argv[i + 1])) {
          const [s, n] = next().split(':').map(Number);
          args.blur.shutter = s; if (n) args.blur.samples = n;
        }
        break;
      }
      case '--transparent': args.transparent = true; break;
      case '--bg': args.bg = parseBackground(next()); break;
      case '--bg-replace': args.bgReplace = true; break;
      case '--in': args.in = Number(next()); break;
      case '--out': args.out = Number(next()); break;
      case '--review': args.review = true; break;
      case '--full': args.full = true; break;
      case '--no-xml': args.xml = false; break;
      case '--page': args.page = next().split(/x/i).map(Number); break;
      case '--workers': args.workers = Number(next()); break;
      case '--out-dir': args.outDir = path.resolve(next()); break;
      case '--port': args.port = Number(next()); break;
      case '--open': args.open = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
        args._.push(a);
    }
  }
  return args;
}

function fmtTime(s) { return `${s.toFixed(2)}s`; }

async function main() {
  const args = parse(process.argv.slice(2));
  const [cmd, input] = args._;
  if (args.help || !cmd) { process.stdout.write(HELP); return; }

  if (cmd === 'serve') {
    const { startServer } = await import('../src/server.mjs');
    const srv = await startServer({ port: args.port || 47800 });
    const { url } = srv;
    process.stdout.write(srv.existing ? `Canvas Render is already running at ${url}\n` : `Canvas Render is running at ${url}\n`);
    if (!srv.existing) {
      const stop = () => { srv.close().finally(() => process.exit(0)); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      // The Mac app watches stdin; when the app quits, the pipe closes.
      if (process.env.CANVAS_RENDER_PARENT) process.stdin.on('end', stop).resume();
    }
    if (args.open) {
      const { spawn } = await import('node:child_process');
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
    return;
  }

  if (!input) throw new Error(`${cmd} needs an input. See canvas-render --help`);
  const engine = new Engine();
  try {
    const project = await engine.open(/^https?:/.test(input) ? input : path.resolve(input), { pageSize: args.page });
    if (cmd === 'info') {
      process.stdout.write(`${project.name}  (${project.scenes.length} scene${project.scenes.length === 1 ? '' : 's'})\n`);
      for (const s of project.scenes) {
        const i = s.info;
        const mark = s.selected ? '[x]' : '[ ]';
        if (s.empty) { process.stdout.write(`  ${mark} ${s.name}  ${s.note}\n`); continue; }
        if (!i || s.error) { process.stdout.write(`  ${mark} ${s.name}  FAILED: ${s.error}\n`); continue; }
        process.stdout.write(`  ${mark} ${s.name}  ${i.width}x${i.height}  ${fmtTime(i.duration)}  ${i.mode === 'stage' ? 'Claude Design stage' : `page (length from ${i.durationSource})`}${s.note ? `  - ${s.note}` : ''}\n`);
        for (const sec of i.scenes || []) process.stdout.write(`        ${fmtTime(sec.start).padStart(7)}  ${sec.name}\n`);
        for (const w of [...(i.warnings || []), ...(i.errors || []).map((e) => ({ code: 'error', detail: e }))].slice(0, 5)) process.stdout.write(`        ! ${w.code}: ${String(w.detail || '').split('\n')[0].slice(0, 160)}\n`);
      }
      return;
    }
    if (cmd !== 'render') throw new Error(`Unknown command ${cmd}`);
    const scenes = project.scenes.filter((s) => s.info && !s.error && (args.scene.length
      ? args.scene.some((q) => s.name.toLowerCase().includes(q.toLowerCase()))
      : (args.all || s.selected)));
    if (!scenes.length) throw new Error('No scenes matched.');
    const settings = {
      format: args.format, aeFallbacks: args.aeFallbacks, rate: args.rate, size: args.size, width: args.width, transparent: args.transparent,
      background: args.bg ? { ...args.bg, replace: !!args.bgReplace } : undefined,
      motionBlur: args.blur, review: args.review, partial: !args.full, xml: args.xml !== false, workers: args.workers, pageSize: args.page,
    };
    for (const k of Object.keys(settings)) if (settings[k] === undefined) delete settings[k];
    const { batchId } = engine.enqueue({
      items: scenes.map((s) => ({ projectId: project.id, sceneId: s.id, inFrame: args.in, outFrame: args.out })),
      settings, outDir: args.outDir, name: project.name,
    });
    await new Promise((resolve) => {
      let lastLine = '';
      engine.on('event', (e) => {
        if (e.type === 'progress') {
          const job = engine.jobs.find((j) => j.id === e.jobId);
          const line = `  ${job.sceneName}: ${e.progress.phase} ${e.progress.done}/${e.progress.total}`;
          if (line !== lastLine && process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(70)}`);
          lastLine = line;
        }
        if (e.type === 'job' && (e.job.status === 'done' || e.job.status === 'error' || e.job.status === 'cancelled')) {
          const j = e.job;
          if (process.stdout.isTTY) process.stdout.write('\n');
          if (j.status === 'done') {
            const r = j.result;
            if (r.format === 'ae') {
              const t = r.tiers;
              process.stdout.write(`done  ${j.sceneName}  ${r.width}x${r.height} ${r.rate}  ${r.layers} layers in ${r.comps} comp(s): ${t.A} native, ${t.B} fitted, ${t.C} rasterised  ${fmtTime(r.seconds)}\n      ${r.file}\n`);
              for (const a of r.approximations.slice(0, 6)) process.stdout.write(`      approx  ${a.name}: ${a.note}\n`);
              for (const a of r.rasterised.slice(0, 6)) process.stdout.write(`      raster  ${a.name}: ${a.reason}\n`);
              for (const d of r.decisions.filter((x) => !x.accepted)) process.stdout.write(`      choice  ${d.summary}: kept ${d.keeps}. Pass --ae-fallback ${d.kind} for ${d.gains}.\n`);
              for (const f of r.fonts.filter((x) => x.note)) process.stdout.write(`      font    ${f.name}: ${f.note}\n`);
              return;
            }
            const how = r.upToDate ? 'already up to date' : r.reused ? `${r.changed} changed, ${r.rendered} rendered, ${r.reused} reused` : `${r.rendered} frames`;
            process.stdout.write(`done  ${j.sceneName}  ${r.width}x${r.height} ${r.rate}  ${how}  ${fmtTime(r.seconds)}\n      ${r.file}\n`);
            if (r.review) process.stdout.write(`      ${r.review}\n`);
          } else {
            process.stdout.write(`${j.status}  ${j.sceneName}: ${j.error || ''}\n`);
            process.exitCode = 1;
          }
        }
        if (e.type === 'batch' && e.batch.id === batchId) {
          if (e.batch.xml) process.stdout.write(`timeline  ${e.batch.xml}\n`);
          if (e.batch.xmlError) process.stdout.write(`timeline failed: ${e.batch.xmlError}\n`);
          resolve();
        }
      });
    });
  } finally {
    await engine.close();
  }
}

main().catch((err) => {
  process.stderr.write(`canvas-render: ${err.message || err}\n`);
  process.exit(1);
});
