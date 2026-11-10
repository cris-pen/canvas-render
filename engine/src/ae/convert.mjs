// Turn one scene into an After Effects import: a self-contained .jsx that
// builds the comp with native shape, text and null layers, real keyframes and
// real eases, plus the assets and fonts it needs.
//
// The converter is design-to-ae (the IR builder, curve fitting, verification
// and ExtendScript emitter in this folder). This file is the glue: capture
// through Canvas Render, build, verify, write.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { captureScene } from './capture.mjs';
import { buildIR } from './ir/build.mjs';
import { verifyIR } from './ir/verify.mjs';
import { emitJsx, buildPayload } from './emit/jsx.mjs';
import { renderGradients } from './capture/gradient.mjs';
import { isolateNodes, rasterTargets, applyIsolation } from './isolate.mjs';
import { fetchInstallableFonts, faceFileName } from './ingest/webfonts.mjs';
import { safeName } from '../render.mjs';

/** Where a scene's After Effects import goes. */
export function aePaths(outDir, scene) {
  const base = safeName(scene.name);
  const dir = path.join(outDir, `${base} AE`);
  return { dir, jsx: path.join(dir, `${base}.jsx`), payload: path.join(dir, `${base}.payload.json`), ir: path.join(dir, `${base}.d2ae.json`), report: path.join(dir, 'report.json') };
}

function countTiers(ir) {
  const t = { A: 0, B: 0, C: 0 };
  for (const c of ir.comps) for (const l of c.layers) if (t[l.tier] !== undefined) t[l.tier] += 1;
  return t;
}

function countKeys(ir) {
  let n = 0;
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v.keys)) { n += v.keys.length; return; }
    for (const k of Object.keys(v)) walk(v[k]);
  };
  for (const c of ir.comps) for (const l of c.layers) walk(l);
  return n;
}

/**
 * Font files the design used, written where a person can install them.
 * Google Fonts are re-requested as TrueType (design-to-ae's trick); fonts the
 * project ships itself are copied when they are already TrueType or OpenType.
 */
async function writeFonts(capture, dir) {
  const out = [];
  const fontsDir = path.join(dir, 'fonts');
  if (capture.fontStylesheets.length) {
    let faces = [];
    try { faces = await fetchInstallableFonts(capture.fontStylesheets); } catch { faces = []; }
    for (const face of faces) {
      mkdirSync(fontsDir, { recursive: true });
      const file = path.join(fontsDir, faceFileName(face));
      writeFileSync(file, face.bytes);
      out.push({ family: face.family, weight: face.weight, style: face.style, file, source: 'Google Fonts' });
    }
  }
  const seen = new Set();
  for (const f of capture.fontFiles) {
    if (/fonts\.gstatic\.com/.test(f.url)) continue;
    const name = decodeURIComponent(new URL(f.url).pathname.split('/').pop() || 'font');
    if (seen.has(name)) continue;
    seen.add(name);
    if (/\.(ttf|otf)$/i.test(name)) {
      mkdirSync(fontsDir, { recursive: true });
      const file = path.join(fontsDir, name);
      writeFileSync(file, f.bytes);
      out.push({ family: null, file, source: 'project' });
    } else {
      out.push({ family: null, file: null, name, source: 'project', note: 'web-only format (WOFF); install the desktop version of this font' });
    }
  }
  return out;
}

/**
 * Convert a scene. Resolves with a summary the queue shows.
 *   env:  { browser, roots, project, scene }
 *   job:  { info, settings, outDir, onProgress, signal }
 */
export async function convertScene(env, job) {
  const { browser, roots, project, scene } = env;
  const { info, settings, outDir, onProgress = () => {}, signal } = job;
  const started = Date.now();
  const paths = aePaths(outDir, scene);
  rmSync(paths.dir, { recursive: true, force: true });
  mkdirSync(paths.dir, { recursive: true });
  const assetDir = path.join(paths.dir, 'assets');
  const rate = settings.rateInfo;

  onProgress({ phase: 'capturing', done: 0, total: 1 });
  const capture = await captureScene({
    browser, roots, scene, info, rate, rasterDir: assetDir, signal,
    onFrame: (done, total) => onProgress({ phase: 'capturing', done, total }),
  });

  onProgress({ phase: 'building', done: 0, total: 1 });
  const accepted = new Set(settings.aeFallbacks || []);
  const buildOptions = {
    baseDir: project.root,
    name: scene.name,
    width: info.width,
    height: info.height,
    tolerance: settings.aeTolerance || 0.5,
    capturedAt: new Date().toISOString(),
    accepted,
  };
  let ir = buildIR(capture, buildOptions);
  const gradientTargets = (accepted.has('gradients') || accepted.has('all'))
    ? ((ir.decisions || []).find((d) => d.kind === 'gradients') || { render: [] }).render
    : [];
  if (gradientTargets.length) {
    const gradientBitmaps = await renderGradients(gradientTargets, { browser, deviceScaleFactor: 1 });
    ir = buildIR(capture, { ...buildOptions, gradientBitmaps });
  }
  const verification = verifyIR(ir, capture);
  ir.report.verification = verification;

  // Layers AE cannot rebuild are rendered on their own, with alpha, and placed
  // in the root comp as footage. Done after verification: the footage carries
  // its motion in its pixels, so there is no track left to check.
  const targets = rasterTargets(ir);
  if (targets.length) {
    onProgress({ phase: 'isolating', done: 0, total: capture.frames.length });
    const isolated = await isolateNodes({
      browser, roots, scene, info, rate, ids: targets, outDir: assetDir, frames: capture.frames.length, signal,
      onFrame: (done, total) => onProgress({ phase: 'isolating', done, total }),
    });
    const { dropped } = applyIsolation(ir, isolated, rate);
    for (const r of ir.report.rasterised) {
      const shot = isolated.get(r.id);
      if (shot && !shot.empty) { r.frames = shot.frames; r.reason += ` (rendered as ${shot.width}x${shot.height} footage)`; }
      else if (shot && shot.empty) r.reason += ' (never painted, dropped)';
    }
    if (dropped.length) {
      ir.report.approximations.push({ name: 'raster fallback', note: `${dropped.length} layer(s) baked into rasterised footage` });
    }
  }

  // Assets sit next to the .jsx, which finds them relative to itself.
  for (const asset of ir.assets || []) {
    if (asset.files) {
      asset.file = asset.files[0];
      asset.relative = path.relative(paths.dir, asset.files[0]).split(path.sep).join('/');
      delete asset.files;
      continue;
    }
    mkdirSync(assetDir, { recursive: true });
    const name = `${asset.id}${asset.ext}`;
    writeFileSync(path.join(assetDir, name), asset.bytes);
    asset.file = path.join(assetDir, name);
    asset.relative = `assets/${name}`;
    delete asset.bytes;
  }

  onProgress({ phase: 'writing', done: 0, total: 1 });
  const emitOptions = { separatePosition: settings.aeUnifiedPosition !== true };
  writeFileSync(paths.jsx, emitJsx(ir, emitOptions));
  writeFileSync(paths.payload, JSON.stringify(buildPayload(ir, emitOptions)));
  writeFileSync(paths.ir, JSON.stringify(ir, null, 1));
  const fonts = await writeFonts(capture, paths.dir);

  const tiers = countTiers(ir);
  const layers = ir.comps.reduce((n, c) => n + c.layers.length, 0);
  const summary = {
    scene: scene.name,
    format: 'ae',
    file: paths.jsx,
    folder: paths.dir,
    payload: paths.payload,
    width: info.width,
    height: info.height,
    rate: rate.label,
    frames: capture.frames.length,
    seconds: (Date.now() - started) / 1000,
    comps: ir.comps.length,
    layers,
    tiers,
    keyframes: countKeys(ir),
    worstPositionError: verification.worstPositionError,
    withinTolerance: verification.withinTolerance,
    approximations: ir.report.approximations.map((a) => ({ name: a.name, note: a.note })),
    rasterised: ir.report.rasterised.map((r) => ({ name: r.name, reason: r.reason, frames: r.frames || 0 })),
    decisions: (ir.decisions || []).map((d) => ({ kind: d.kind, summary: d.summary, accepted: d.accepted, keeps: d.keeps, gains: d.gains, layers: d.layers })),
    staggers: (ir.report.staggers || []).length,
    fonts,
    pageErrors: capture.consoleErrors.slice(0, 5),
    truncated: capture.truncated,
  };
  writeFileSync(paths.report, JSON.stringify(summary, null, 2));
  onProgress({ phase: 'done', done: 1, total: 1 });
  return summary;
}
