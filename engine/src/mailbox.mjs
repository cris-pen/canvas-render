// The Premiere panel's way in.
//
// Premiere blocks plain http:// requests from panels on macOS, so the panel
// does not talk to the server. It writes a request file into
//   <data>/mailbox/inbox/<id>.json
// and reads progress back from
//   <data>/mailbox/outbox/<id>.json
// The engine writes <data>/mailbox/engine.json every two seconds so the panel
// can tell whether the app is running.
//
// Requests:
//   { id, action: 'analyze', input }
//   { id, action: 'render', input, scenes?: [names], preset?, settings?, outDir? }
//   { id, action: 'cancel', target: <request id> }

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mailboxRoot, VERSION } from './paths.mjs';
import { readPrefs, rememberProject } from './prefs.mjs';
import { PRESETS } from './settings.mjs';
import { defaultOutRoot } from './engine.mjs';
import { safeName } from './render.mjs';

const ID = /^[A-Za-z0-9._-]{1,80}$/;

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.part`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export class Mailbox {
  constructor(engine, { root = mailboxRoot(), uiUrl = null, poll = 300 } = {}) {
    this.engine = engine;
    this.root = root;
    this.uiUrl = uiUrl;
    this.poll = poll;
    this.inbox = path.join(root, 'inbox');
    this.outbox = path.join(root, 'outbox');
    this.requests = new Map(); // request id -> state
    this.byBatch = new Map(); // batch id -> request id
    this.busy = false;
    this.timers = [];
    this.onEvent = (e) => this.handleEvent(e);
  }

  start() {
    mkdirSync(this.inbox, { recursive: true });
    mkdirSync(this.outbox, { recursive: true });
    this.cleanup();
    this.heartbeat();
    this.engine.on('event', this.onEvent);
    this.timers.push(setInterval(() => this.heartbeat(), 2000));
    this.timers.push(setInterval(() => this.scan(), this.poll));
    return this;
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.engine.off('event', this.onEvent);
    try { rmSync(path.join(this.root, 'engine.json'), { force: true }); } catch { /* ignore */ }
  }

  cleanup() {
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    for (const dir of [this.inbox, this.outbox]) {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        try { if (f.endsWith('.part') || statSync(p).mtimeMs < dayAgo) rmSync(p, { force: true }); } catch { /* ignore */ }
      }
    }
  }

  heartbeat() {
    const s = this.engine.status();
    writeJson(path.join(this.root, 'engine.json'), {
      app: 'canvas-render', version: VERSION, pid: process.pid, ui: this.uiUrl, updatedAt: Date.now(),
      ready: { ffmpeg: !!s.ffmpeg, prores: s.prores, chrome: !!s.chrome },
      presets: PRESETS.map((p) => ({ id: p.id, label: p.label, detail: p.detail })),
      rates: s.rates,
    });
  }

  async scan() {
    if (this.busy) return;
    this.busy = true;
    try {
      let files = [];
      try { files = readdirSync(this.inbox).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
      for (const f of files) {
        const p = path.join(this.inbox, f);
        let req;
        try { req = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; } // still being written
        rmSync(p, { force: true });
        if (!req || !ID.test(String(req.id || ''))) continue;
        await this.handle(req);
      }
    } finally {
      this.busy = false;
    }
  }

  status(id) { return path.join(this.outbox, `${id}.json`); }

  publish(state) {
    state.updatedAt = Date.now();
    writeJson(this.status(state.id), state);
  }

  async handle(req) {
    const state = { id: req.id, action: req.action, state: 'working', message: '', project: null, jobs: [], xml: null };
    this.requests.set(req.id, state);
    try {
      if (req.action === 'cancel') {
        const target = this.requests.get(req.target);
        for (const j of target ? target.jobs : []) this.engine.cancel(j.id);
        state.state = 'done';
        this.publish(state);
        return;
      }
      if (req.action !== 'analyze' && req.action !== 'render') throw new Error(`Unknown action "${req.action}".`);
      if (!req.input || typeof req.input !== 'string') throw new Error('No file given.');

      state.message = 'Opening';
      this.publish(state);
      const project = await this.openOrReuse(req.input);
      state.project = project;
      rememberProject(project.source, project.name);
      if (req.action === 'analyze') {
        state.state = 'done';
        state.message = '';
        this.publish(state);
        return;
      }

      const wanted = Array.isArray(req.scenes) && req.scenes.length ? req.scenes.map((n) => String(n).toLowerCase()) : null;
      const scenes = project.scenes.filter((s) => s.info && !s.error && (wanted ? wanted.includes(s.name.toLowerCase()) || wanted.includes(s.id) : s.selected));
      if (!scenes.length) throw new Error(wanted ? 'None of those boards loaded.' : 'Nothing to render in that file.');

      const prefs = readPrefs();
      const preset = PRESETS.find((p) => p.id === req.preset);
      const settings = { ...prefs.settings, ...(preset ? preset.settings : {}), ...(req.settings || {}) };
      const outDir = req.outDir || path.join(prefs.outRoot || defaultOutRoot(), safeName(project.name));
      const { batchId, jobs } = this.engine.enqueue({ items: scenes.map((s) => ({ projectId: project.id, sceneId: s.id })), settings, outDir, name: project.name });
      this.byBatch.set(batchId, req.id);
      state.jobs = jobs;
      state.message = 'Queued';
      this.publish(state);
    } catch (err) {
      state.state = 'error';
      state.message = String(err.message || err);
      this.publish(state);
    }
  }

  /** Reuse an open project when the same file has not changed since. */
  async openOrReuse(input) {
    const abs = path.resolve(input);
    const mtime = existsSync(abs) ? statSync(abs).mtimeMs : null;
    for (const p of this.engine.projects.values()) {
      if (p.source === abs && p.mtime === mtime && p.scenes.every((s) => !s.pending)) return this.engine.listProjects().find((x) => x.id === p.id);
    }
    return this.engine.open(abs);
  }

  handleEvent(e) {
    if (e.type === 'progress' || e.type === 'job') {
      const jobId = e.jobId || (e.job && e.job.id);
      for (const state of this.requests.values()) {
        const i = state.jobs.findIndex((j) => j.id === jobId);
        if (i < 0) continue;
        if (e.type === 'job') state.jobs[i] = e.job; else state.jobs[i] = { ...state.jobs[i], progress: e.progress };
        const running = state.jobs.find((j) => j.status === 'rendering');
        state.message = running ? `Rendering ${running.sceneName}` : state.message;
        this.publish(state);
      }
    } else if (e.type === 'batch') {
      const id = this.byBatch.get(e.batch.id);
      const state = id && this.requests.get(id);
      if (!state) return;
      state.jobs = e.batch.jobs;
      state.xml = e.batch.xml;
      const failed = state.jobs.filter((j) => j.status === 'error');
      const cancelled = state.jobs.every((j) => j.status === 'cancelled');
      state.state = cancelled ? 'cancelled' : failed.length === state.jobs.length ? 'error' : 'done';
      state.message = failed.length ? failed.map((j) => `${j.sceneName}: ${j.error}`).join('\n') : '';
      this.publish(state);
    }
  }
}
