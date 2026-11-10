// The engine: projects, scene analysis, previews and the render queue.
// The CLI, the app window and the Premiere panel all drive this one object.

import { normalizePlate, plateCss, PLATE_PRESETS } from './plate.mjs';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, findChrome } from './browser.mjs';
import { openProject } from './ingest.mjs';
import { ScenePage, analyzeScene } from './scene-page.mjs';
import { convertScene } from './ae/convert.mjs';
import { renderScene, safeName } from './render.mjs';
import { buildXml } from './xml.mjs';
import { normalizeSettings, outputSize, FORMATS, SIZES, PRESETS, DEFAULTS } from './settings.mjs';
import { RATES } from './rates.mjs';
import { frameCount } from './rates.mjs';
import { tools } from './ffmpeg.mjs';

export function defaultOutRoot() {
  return process.platform === 'darwin' ? path.join(os.homedir(), 'Movies', 'Canvas Render') : path.join(os.homedir(), 'Canvas Render');
}

class Mutex {
  constructor() { this.p = Promise.resolve(); }
  run(fn) { const r = this.p.then(fn, fn); this.p = r.then(() => {}, () => {}); return r; }
}

export class Engine extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.roots = new Map();
    this.projects = new Map();
    this.previews = new Map();
    this.jobs = [];
    this.batches = new Map();
    this.seq = 0;
    this.running = false;
    this.launching = null;
  }

  async getBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = launchBrowser().then((b) => { this.browser = b; this.launching = null; b.on('disconnected', () => { this.browser = null; }); return b; },
        (err) => { this.launching = null; throw err; });
    }
    return this.launching;
  }

  status() {
    const t = tools();
    return {
      app: 'canvas-render', ffmpeg: t.ffmpeg, ffmpegVersion: t.version, prores: t.has('prores_ks'), x264: t.has('libx264'),
      chrome: findChrome(), outRoot: defaultOutRoot(), home: os.homedir(), formats: FORMATS, sizes: SIZES, rates: Object.keys(RATES), presets: PRESETS, defaults: DEFAULTS,
      platform: process.platform, plates: PLATE_PRESETS,
    };
  }

  /** Open a zip, html file, folder or URL and analyse every scene in it. */
  async open(input, { pageSize } = {}) {
    const project = await openProject(input);
    if (project.root) this.roots.set(project.id, project.root);
    this.projects.set(project.id, project);
    for (const scene of project.scenes) scene.pending = true;
    this.emit('event', { type: 'project', project: publicProject(project) });
    const browser = await this.getBrowser();
    for (const scene of project.scenes) {
      if (scene.empty) {
        scene.pending = false;
        this.emit('event', { type: 'scene-analyzed', projectId: project.id, scene: publicScene(scene) });
        continue;
      }
      try {
        scene.info = await analyzeScene(browser, this.roots, scene, { pageSize });
        const dcFailure = (scene.info.errors || []).find((e) => /x-import: FAILED|dc-runtime.*(error|failed)/i.test(e));
        if (scene.info.mode === 'page' && (dcFailure || scene.info.expectedStage || scene.kind === 'board')) {
          // A Claude Design board that never produced its stage either failed
          // to load or has no timeline.
          const failure = dcFailure || (scene.info.errors || []).find((e) => /FAILED|Error/.test(e));
          if (failure || scene.info.expectedStage) {
            scene.error = failure ? `The board failed to load: ${failure.split('\n')[0].slice(0, 300)}` : 'The board never showed its stage.';
            scene.selected = false;
          } else {
            scene.note = scene.note || 'This board has no timeline, so it renders as a still.';
          }
        }
      } catch (err) {
        scene.info = null;
        scene.error = String(err.message || err);
        scene.selected = false;
      }
      scene.pending = false;
      this.emit('event', { type: 'scene-analyzed', projectId: project.id, scene: publicScene(scene) });
    }
    return publicProject(project);
  }

  project(id) {
    const p = this.projects.get(id);
    if (!p) throw new Error('Unknown project. Open it again.');
    return p;
  }

  scene(projectId, sceneId) {
    const p = this.project(projectId);
    const s = p.scenes.find((x) => x.id === sceneId);
    if (!s) throw new Error('Unknown scene.');
    return { project: p, scene: s };
  }

  /** A JPEG of one frame, for the scrubber. */
  async preview(projectId, sceneId, seconds, width = 960, transparent = false, background = null) {
    const { scene } = this.scene(projectId, sceneId);
    const plate = background ? plateCss(normalizePlate(background)) : null;
    if (plate) transparent = false;
    if (!scene.info) throw new Error(scene.error || 'Scene did not load.');
    const key = `${projectId}/${sceneId}/${width}/${transparent ? 'a' : 'o'}`;
    let entry = this.previews.get(key);
    if (!entry) {
      // Keep a handful of tabs warm; close the oldest beyond that.
      if (this.previews.size >= 4) {
        const [oldKey, old] = this.previews.entries().next().value;
        this.previews.delete(oldKey);
        old.mutex.run(() => old.page.close());
      }
      const scale = Math.min(1, width / scene.info.width);
      const page = new ScenePage(await this.getBrowser(), this.roots, scene, { width: scene.info.width, height: scene.info.height, scale, transparent });
      entry = { page, mutex: new Mutex(), opened: page.open(), want: null };
      this.previews.set(key, entry);
    }
    await entry.opened;
    entry.want = seconds;
    return entry.mutex.run(async () => {
      // Only the latest request matters while scrubbing.
      const t = Math.max(0, Math.min(entry.want, scene.info.duration));
      await entry.page.setPlate(plate);
      await entry.page.seek(t);
      // JPEG has no alpha, so a transparent preview is a PNG.
      return transparent ? entry.page.capture({ type: 'png' }) : entry.page.capture({ type: 'jpeg', quality: 80 });
    });
  }

  /**
   * Queue a batch. items: [{ projectId, sceneId, inFrame?, outFrame? }]
   * settings: see settings.mjs. outDir defaults to ~/Movies/Canvas Render/<project>.
   */
  enqueue({ items, settings: rawSettings, outDir, name }) {
    const settings = normalizeSettings(rawSettings);
    const batchId = `b${++this.seq}`;
    const jobs = items.map((it) => {
      const { project, scene } = this.scene(it.projectId, it.sceneId);
      if (!scene.info) throw new Error(`${scene.name} did not load: ${scene.error || 'unknown error'}`);
      const total = frameCount(scene.info.duration, settings.rateInfo);
      const job = {
        id: `j${++this.seq}`, batchId, projectId: project.id, sceneId: scene.id, sceneName: scene.name,
        projectName: project.name, settings, inFrame: it.inFrame ?? 0, outFrame: it.outFrame ?? total - 1,
        outDir: outDir || path.join(defaultOutRoot(), safeName(project.name)),
        status: 'queued', progress: { phase: 'queued', done: 0, total: 0 }, result: null, error: null,
        controller: new AbortController(), size: outputSize(scene.info.width, scene.info.height, settings),
      };
      this.jobs.push(job);
      return job;
    });
    this.batches.set(batchId, { id: batchId, name: name || (jobs[0] && jobs[0].projectName) || 'Canvas Render', jobs: jobs.map((j) => j.id), settings, xml: null, status: 'queued' });
    this.emit('event', { type: 'queued', batchId, jobs: jobs.map(publicJob) });
    this.pump();
    return { batchId, jobs: jobs.map(publicJob) };
  }

  cancel(jobId) {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return false;
    if (job.status === 'queued') { job.status = 'cancelled'; this.emit('event', { type: 'job', job: publicJob(job) }); }
    job.controller.abort();
    return true;
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.jobs.find((j) => j.status === 'queued');
        if (!job) break;
        await this.runJob(job);
        this.finishBatchIfDone(job.batchId);
      }
    } finally {
      this.running = false;
    }
  }

  async runJob(job) {
    const { project, scene } = this.scene(job.projectId, job.sceneId);
    job.status = 'rendering';
    this.emit('event', { type: 'job', job: publicJob(job) });
    let last = 0;
    try {
      const browser = await this.getBrowser();
      const onProgress = (p) => {
        job.progress = p;
        const now = Date.now();
        if (now - last > 200 || p.phase === 'done') { last = now; this.emit('event', { type: 'progress', jobId: job.id, progress: p }); }
      };
      const env = { browser, roots: this.roots, project, scene };
      job.result = job.settings.format === 'ae'
        ? await convertScene(env, { info: scene.info, settings: job.settings, outDir: job.outDir, signal: job.controller.signal, onProgress })
        : await renderScene(env, {
          info: scene.info, settings: job.settings, outDir: job.outDir, inFrame: job.inFrame, outFrame: job.outFrame,
          signal: job.controller.signal, onProgress,
        });
      job.status = 'done';
    } catch (err) {
      job.status = err.code === 'CANCELLED' ? 'cancelled' : 'error';
      job.error = String(err.message || err);
    }
    this.emit('event', { type: 'job', job: publicJob(job) });
  }

  finishBatchIfDone(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch || batch.status === 'done') return;
    const jobs = batch.jobs.map((id) => this.jobs.find((j) => j.id === id));
    if (jobs.some((j) => j.status === 'queued' || j.status === 'rendering')) return;
    batch.status = 'done';
    const done = jobs.filter((j) => j.status === 'done' && j.result);
    if (batch.settings.xml && done.length && batch.settings.format !== 'png' && batch.settings.format !== 'ae') {
      try {
        const xml = buildXml({
          name: `${batch.name} ${batch.settings.rate}`,
          clips: done.map((j) => ({ name: j.sceneName, file: j.result.file, frames: j.result.frames, width: j.result.width, height: j.result.height, rate: j.result.rate, alpha: j.result.alpha, markers: j.result.markers })),
        });
        const file = path.join(done[0].outDir, `${safeName(batch.name)}_timeline.xml`);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, xml);
        batch.xml = file;
      } catch (err) {
        batch.xmlError = String(err.message || err);
      }
    }
    this.emit('event', { type: 'batch', batch: { id: batch.id, name: batch.name, xml: batch.xml, xmlError: batch.xmlError || null, jobs: jobs.map(publicJob) } });
  }

  listJobs() { return this.jobs.map(publicJob); }

  listProjects() { return [...this.projects.values()].map(publicProject); }

  /** Forget a project and close its preview tabs. */
  async closeProject(id) {
    for (const [key, e] of this.previews) {
      if (key.startsWith(`${id}/`)) { this.previews.delete(key); e.mutex.run(() => e.page.close()).catch(() => {}); }
    }
    this.projects.delete(id);
    this.roots.delete(id);
    this.emit('event', { type: 'project-closed', projectId: id });
  }

  /** Every file this engine has written, so the server only reveals those. */
  outputs() {
    const set = new Set();
    for (const j of this.jobs) {
      if (j.outDir) set.add(j.outDir);
      if (j.result) { set.add(j.result.file); if (j.result.review) set.add(j.result.review); if (j.result.folder) set.add(j.result.folder); }
    }
    for (const b of this.batches.values()) if (b.xml) set.add(b.xml);
    return set;
  }

  async close() {
    for (const e of this.previews.values()) { try { await e.page.close(); } catch { /* ignore */ } }
    this.previews.clear();
    if (this.browser) await this.browser.close();
    this.browser = null;
  }
}

export function publicScene(s) {
  return { id: s.id, name: s.name, kind: s.kind, rel: s.rel, selected: s.selected, note: s.note, error: s.error || null, info: s.info || null, pending: !!s.pending, empty: !!s.empty };
}

export function publicProject(p) {
  return { id: p.id, name: p.name, source: p.source, scenes: p.scenes.map(publicScene) };
}

export function publicJob(j) {
  return {
    id: j.id, batchId: j.batchId, projectId: j.projectId, sceneId: j.sceneId, sceneName: j.sceneName, status: j.status,
    progress: j.progress, result: j.result, error: j.error, outDir: j.outDir, inFrame: j.inFrame, outFrame: j.outFrame,
    format: j.settings.format, rate: j.settings.rate, size: j.size,
  };
}
