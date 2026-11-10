/* eslint-disable no-underscore-dangle */
// In-page driver. Installed at document start, right after clock.js.
//
// Two ways a page can be driven:
//
//   stage  A Claude Design board with an exportable stage: one element carrying
//          data-om-exportable-video-with-duration-secs. The stage owns its own
//          time and accepts a 'data-om-seek-to-time-frame' event, which is how
//          Claude's own video export drives it. When the stage advertises
//          data-om-sync-seek, the DOM reflects the new time as soon as
//          dispatchEvent returns.
//
//   page   Any other animated HTML. Time comes from the virtual clock, and every
//          Web Animation (CSS keyframes, transitions, element.animate) is paused
//          and set to its local time directly.
//
// Pages driven by the clock can only move forward. seek() reports needsReload
// when asked to go back, and the engine reloads and steps forward instead.
(() => {
  if (window.__cr) return;
  const clock = window.__crClock;
  const native = clock ? clock.native : { setTimeout: window.setTimeout.bind(window), perfNow: performance.now.bind(performance) };
  const STAGE = '[data-om-exportable-video-with-duration-secs]';
  const PIN_ID = '__cr-pin';

  const births = new WeakMap();
  const state = { mode: null, lastMs: 0, warnings: [], options: {}, sawImport: false };

  // A Claude Design board's runtime replaces its <x-import> elements, and on
  // failure may remove them, so note whether the page started with one.
  // This listener is registered before any page script, so it runs first.
  document.addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('x-import')) state.sawImport = true;
  }, { capture: true, once: true });

  const realNow = () => native.perfNow();
  const sleepReal = (ms) => new Promise((resolve) => native.setTimeout(resolve, ms));
  // A real macrotask that the frozen clock cannot hold back. React's scheduler
  // uses MessageChannel too, so this lets an async commit land.
  const macrotask = () => new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
  const withTimeout = (promise, ms) => Promise.race([promise, sleepReal(ms)]);
  const warn = (code, detail) => { if (state.warnings.length < 50) state.warnings.push({ code, detail: detail === undefined ? null : String(detail) }); };

  function stage() { return document.querySelector(STAGE); }

  // Every Web Animation gets a birth time the first time it is seen; its local
  // time is then (now - birth). Delays, fill modes, iterations and transitions
  // started by script all land correctly this way.
  function scrub(ms) {
    let animations = [];
    try { animations = document.getAnimations(); } catch { return 0; }
    for (const anim of animations) {
      let birth = births.get(anim);
      if (birth === undefined) { birth = ms; births.set(anim, birth); }
      try {
        if (anim.playState !== 'paused') anim.pause();
        anim.currentTime = Math.max(0, ms - birth);
      } catch { /* a cancelled animation rejects currentTime */ }
    }
    return animations.length;
  }

  async function seekVideos(ms) {
    const videos = Array.from(document.querySelectorAll('video'));
    await Promise.all(videos.map((v) => {
      try {
        v.pause();
        const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
        let t = ms / 1000;
        if (dur && v.loop) t %= dur;
        else if (dur) t = Math.min(t, Math.max(0, dur - 0.001));
        if (Math.abs(v.currentTime - t) < 0.0005) return null;
        return withTimeout(new Promise((resolve) => {
          v.addEventListener('seeked', resolve, { once: true });
          v.currentTime = t;
        }), 2000);
      } catch { return null; }
    }));
  }

  function expectsStage() {
    if (state.sawImport || document.querySelector('x-import')) return true;
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    return html.indexOf('data-om-exportable-video') !== -1 || html.indexOf('exportable-video-with-duration') !== -1;
  }

  function parseJSONish(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(String(value)); } catch { return null; }
  }

  function readScenes() {
    const list = parseJSONish(window.OM_SCENES);
    if (!Array.isArray(list)) return [];
    let start = 0;
    const out = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const dur = Number(entry.dur) || 0;
      out.push({ name: String(entry.name || `Section ${out.length + 1}`), start, dur, desc: entry.desc ? String(entry.desc) : '' });
      start += dur;
    }
    return out;
  }

  function readAudio() {
    return Array.from(document.querySelectorAll('[data-om-exportable-video-play-start]')).map((el) => ({
      src: el.currentSrc || el.getAttribute('src') || '',
      start: Number(el.getAttribute('data-om-exportable-video-play-start')) || 0,
      end: Number(el.getAttribute('data-om-exportable-video-play-end')) || null,
      speed: Number(el.getAttribute('data-om-exportable-video-play-speed')) || 1,
    }));
  }

  function stageSize(el) {
    let w = Number(el.getAttribute('width'));
    let h = Number(el.getAttribute('height'));
    if (!(w > 0 && h > 0) && el.viewBox && el.viewBox.baseVal && el.viewBox.baseVal.width) {
      w = el.viewBox.baseVal.width; h = el.viewBox.baseVal.height;
    }
    if (!(w > 0 && h > 0)) {
      // Fall back to the layout box, which ignores the fit-to-window transform.
      w = el.offsetWidth || el.clientWidth; h = el.offsetHeight || el.clientHeight;
    }
    return [Math.round(w), Math.round(h)];
  }

  // Pin the stage to the top-left at 1:1. The board normally scales it to fit
  // the window and leaves room for a playback bar; the renderer sizes the
  // window to the stage instead, so nothing needs to scale.
  function pinStage() {
    if (document.getElementById(PIN_ID)) return;
    const style = document.createElement('style');
    style.id = PIN_ID;
    style.textContent = `${STAGE}{position:fixed!important;left:0!important;top:0!important;right:auto!important;bottom:auto!important;`
      + 'transform:none!important;box-shadow:none!important;margin:0!important;max-width:none!important;max-height:none!important;'
      + 'z-index:2147483647!important}';
    (document.head || document.documentElement).appendChild(style);
  }

  // will-change makes Chromium raster a layer once and reuse it, at a scale
  // and moment that depend on timing. That makes two renders of the same frame
  // differ by a few pixels, which defeats change detection, and can leave text
  // soft. Painting those layers normally gives the same pixels every time.
  function steadyRaster() {
    const style = document.createElement('style');
    style.textContent = '*,*::before,*::after{will-change:auto!important;caret-color:transparent!important}';
    (document.head || document.documentElement).appendChild(style);
  }

  function makeTransparent() {
    const style = document.createElement('style');
    style.textContent = 'html,body{background:transparent!important;background-color:transparent!important}';
    (document.head || document.documentElement).appendChild(style);
  }

  // A background plate (see plate.mjs). On a board the page around the stage
  // is only letterboxing, so the plate always replaces it; "replace" also
  // clears the board's own top-level fill. On a plain page the plate only goes
  // where the page paints nothing, unless "replace" clears the page's own.
  function setPlate(plate) {
    let style = document.getElementById('cr-plate');
    if (style) style.remove();
    const board = stage() && stage().querySelector(':scope > foreignObject > *');
    if (board) board.removeAttribute('data-cr-board');
    if (!plate || !plate.css) return false;
    const bg = `html{background:${plate.css}!important}body{background:transparent!important}`;
    let css = '';
    if (board) {
      css = bg;
      if (plate.replace) {
        board.setAttribute('data-cr-board', '');
        css += '[data-cr-board]{background:transparent!important}';
      }
    } else if (plate.replace) {
      css = bg;
    } else {
      const clear = (el) => {
        if (!el) return true;
        const cs = getComputedStyle(el);
        return cs.backgroundImage === 'none' && /rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor);
      };
      if (clear(document.documentElement) && clear(document.body)) css = bg;
    }
    if (!css) return false;
    style = document.createElement('style');
    style.id = 'cr-plate';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    return true;
  }

  function animationDuration() {
    let end = 0; let longestLoop = 0; let count = 0;
    let animations = [];
    try { animations = document.getAnimations(); } catch { /* ignore */ }
    for (const anim of animations) {
      count += 1;
      const timing = anim.effect ? anim.effect.getComputedTiming() : null;
      if (!timing) continue;
      if (!Number.isFinite(timing.iterations)) {
        const dur = Number(timing.duration) || 0;
        const alternates = /alternate/i.test(String(timing.direction || ''));
        longestLoop = Math.max(longestLoop, (Number(timing.delay) || 0) + (alternates ? dur * 2 : dur));
        continue;
      }
      const endTime = Number(timing.endTime);
      if (Number.isFinite(endTime)) end = Math.max(end, endTime);
    }
    return { endMs: end, longestLoopMs: longestLoop, count };
  }

  async function waitForImages() {
    const images = Array.from(document.images).filter((img) => !img.complete);
    await withTimeout(Promise.all(images.map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }))), 8000);
  }

  window.__cr = {
    async ready(options = {}) {
      state.options = options;
      const waitMs = expectsStage() ? (options.stageWaitMs || 15000) : 250;
      const deadline = realNow() + waitMs;
      let el = stage();
      let nudged = false;
      while (!el && realNow() < deadline && !state.stop) {
        await sleepReal(40);
        // If a board is still not up halfway through, let virtual time creep
        // forward in case its loader waits on a timer.
        if (clock && waitMs > 1000 && realNow() > deadline - waitMs / 2) {
          if (!nudged) { warn('stage-slow', 'advanced the clock while waiting for the stage'); nudged = true; }
          clock.step(clock.now + 16);
        }
        el = stage();
      }
      steadyRaster();
      if (options.transparent && !options.plate) makeTransparent();
      if (document.fonts && document.fonts.ready) await withTimeout(document.fonts.ready, 8000);
      await waitForImages();

      if (el) {
        state.mode = 'stage';
        if (!el.hasAttribute('data-om-fonts-inlined')) {
          const until = realNow() + 3000;
          while (!el.hasAttribute('data-om-fonts-inlined') && realNow() < until) await sleepReal(40);
        }
        if (options.pin !== false) pinStage();
        const [width, height] = stageSize(el);
        const duration = Number(el.getAttribute('data-om-exportable-video-with-duration-secs')) || 0;
        await this.seek(0);
        return {
          mode: 'stage',
          width,
          height,
          duration,
          durationSource: 'stage',
          syncSeek: el.getAttribute('data-om-sync-seek') === 'true',
          scenes: readScenes(),
          playback: parseJSONish(window.OM_PLAYBACK),
          audio: readAudio(),
          title: document.title || '',
          warnings: state.warnings.slice(),
          errors: (window.__crErrors || []).slice(0, 20),
        };
      }

      state.mode = 'page';
      const expectedStage = expectsStage();
      await this.seek(0);
      const anim = animationDuration();
      const d = document.documentElement;
      const b = document.body;
      const docW = Math.max(d.scrollWidth, b ? b.scrollWidth : 0);
      const docH = Math.max(d.scrollHeight, b ? b.scrollHeight : 0);
      let duration = Math.max(anim.endMs, anim.longestLoopMs) / 1000;
      let durationSource = anim.count ? 'animations' : 'default';
      if (!(duration > 0)) { duration = 5; durationSource = 'default'; }
      return {
        mode: 'page',
        width: Math.round(Math.max(window.innerWidth, docW)),
        height: Math.round(Math.max(window.innerHeight, docH)),
        viewport: [window.innerWidth, window.innerHeight],
        duration,
        durationSource,
        loops: anim.longestLoopMs > 0,
        expectedStage,
        syncSeek: true,
        scenes: [],
        audio: readAudio(),
        title: document.title || '',
        warnings: state.warnings.slice(),
        errors: (window.__crErrors || []).slice(0, 20),
      };
    },

    /** Move the page to `ms` and leave the DOM showing that frame. */
    async seek(ms) {
      const el = stage();
      if (!el && clock && ms < state.lastMs - 0.5) return { needsReload: true };
      if (el) {
        if (clock && ms > clock.now) clock.step(ms);
        el.dispatchEvent(new CustomEvent('data-om-seek-to-time-frame', { detail: { time: ms / 1000, sync: true, playing: false } }));
        if (el.getAttribute('data-om-sync-seek') !== 'true') { await macrotask(); await macrotask(); }
        // Flush anything the commit queued for the next animation frame, such
        // as a canvas redraw, without moving time.
        if (clock) clock.step(Math.max(clock.now, ms));
        scrub(ms);
      } else {
        scrub(ms);
        if (clock) clock.step(ms);
        scrub(ms);
      }
      await seekVideos(ms);
      void document.documentElement.offsetWidth; // eslint-disable-line no-void
      state.lastMs = ms;
      return { ok: true };
    },

    /** Give the stage (or the page) its own layer for one capture, then take it away. */
    freshLayer(on) {
      const el = stage() || document.documentElement;
      if (on) el.style.setProperty('will-change', 'transform', 'important');
      else el.style.removeProperty('will-change');
    },

    warnings: () => state.warnings.slice(),
    /** Called when the page reports that its board failed to load, to stop waiting for a stage. */
    stopWaiting: () => { state.stop = true; },
    setPlate,
  };
})();
