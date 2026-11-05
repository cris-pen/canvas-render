/* eslint-disable no-underscore-dangle */
// Deterministic virtual clock, installed into the page before any of its own
// script runs. Adapted from the capture clock in design-to-ae.
//
// Wall time never advances on its own, requestAnimationFrame never fires on its
// own, and timers never come due on their own. The renderer advances time in
// exact frame steps, so a rAF-driven animation (GSAP, a canvas loop, a spring)
// steps in lockstep with CSS animations and two renders of the same input are
// identical.
(() => {
  if (window.__crClock) return;

  const EPOCH = 1735689600000; // 2025-01-01T00:00:00Z, fixed so Date.now() is reproducible.

  const state = {
    now: 0,
    seq: 1,
    rafQueue: new Map(),
    timers: new Map(),
    installed: false,
    // Anything the page schedules while we are flushing must run on the NEXT
    // step, not this one, or a self-rescheduling rAF loop would spin forever.
    pendingRaf: new Map(),
  };

  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativePerfNow = performance.now.bind(performance);
  const NativeDate = Date;

  function install() {
    if (state.installed) return;
    state.installed = true;

    performance.now = () => state.now;

    window.requestAnimationFrame = (cb) => {
      const id = state.seq += 1;
      state.pendingRaf.set(id, cb);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      state.pendingRaf.delete(id);
      state.rafQueue.delete(id);
    };

    window.setTimeout = (fn, delay, ...args) => {
      const id = state.seq += 1;
      state.timers.set(id, {
        fn, args, due: state.now + Math.max(0, Number(delay) || 0), interval: null,
      });
      return id;
    };
    window.setInterval = (fn, delay, ...args) => {
      const id = state.seq += 1;
      const period = Math.max(1, Number(delay) || 1);
      state.timers.set(id, { fn, args, due: state.now + period, interval: period });
      return id;
    };
    window.clearTimeout = (id) => state.timers.delete(id);
    window.clearInterval = (id) => state.timers.delete(id);

    // Date: fixed epoch plus virtual elapsed time, so `new Date()` and
    // `Date.now()` are as reproducible as performance.now().
    const ShimDate = new Proxy(NativeDate, {
      construct(target, args) {
        if (args.length === 0) return new target(EPOCH + state.now);
        return new target(...args);
      },
      get(target, prop, receiver) {
        if (prop === 'now') return () => EPOCH + state.now;
        return Reflect.get(target, prop, receiver);
      },
    });
    window.Date = ShimDate;
  }

  // Run every timer that has come due at or before `upTo`, in time order, so a
  // chain of short setTimeouts inside one frame resolves the way it would live.
  function runDueTimers(upTo) {
    for (let guard = 0; guard < 10000; guard += 1) {
      let nextId = null;
      let next = null;
      for (const [id, timer] of state.timers) {
        if (timer.due <= upTo && (!next || timer.due < next.due)) { nextId = id; next = timer; }
      }
      if (!next) return;
      state.now = Math.max(state.now, next.due);
      if (next.interval === null) state.timers.delete(nextId);
      else next.due += next.interval;
      try {
        if (typeof next.fn === 'function') next.fn(...next.args);
        else if (typeof next.fn === 'string') (0, eval)(next.fn); // eslint-disable-line no-eval
      } catch (err) {
        (window.__crErrors || (window.__crErrors = [])).push(String(err));
      }
    }
  }

  function flushRaf(timestamp) {
    state.rafQueue = state.pendingRaf;
    state.pendingRaf = new Map();
    const queue = [...state.rafQueue.entries()];
    state.rafQueue = new Map();
    for (const [, cb] of queue) {
      try { cb(timestamp); } catch (err) {
        (window.__crErrors || (window.__crErrors = [])).push(String(err));
      }
    }
  }

  window.__crClock = {
    install,
    get now() { return state.now; },
    /** Advance virtual time to `target` ms, firing timers and one rAF turn. */
    step(target) {
      const to = Math.max(state.now, target);
      runDueTimers(to);
      state.now = to;
      flushRaf(to);
      return state.now;
    },
    /** Let the page's own real timers settle before we take the clock away. */
    pendingCounts() {
      return { timers: state.timers.size, raf: state.pendingRaf.size + state.rafQueue.size };
    },
    native: { setTimeout: nativeSetTimeout, clearTimeout: nativeClearTimeout, perfNow: nativePerfNow },
  };
})();
