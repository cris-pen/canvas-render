/* eslint-disable no-underscore-dangle */
// In-page measurement probe. Injected before the document's own scripts.
//
// Per frame it answers one question for every element: "where is your
// untransformed layout box, and what transform is applied to it?" -- because
// that pair is exactly what an After Effects layer stores (source rectangle +
// anchor/position/scale/rotation), while getBoundingClientRect() alone gives
// only the axis-aligned bounding box of the already-transformed result, which
// throws away the rotation we need.
//
// The measurement trick: CSS transforms do not participate in layout. So we can
// switch every transform off, take one layout pass, read exact fractional
// border boxes, and switch them back on with the page provably unchanged (the
// restore is verified byte-for-byte in test/capture.test.mjs).
//
// The one exception the CSS cascade forces on us: a RUNNING TRANSITION outranks
// an `!important` author rule, so a mid-flight transform transition survives the
// flat pass. We detect that empirically -- if `transform` is still not `none`
// while the flat sheet is applied, that element has a residual -- and undo it
// analytically rather than pretending it is not there.
(() => {
  if (window.__d2ae) return;

  const NS_SVG = 'http://www.w3.org/2000/svg';
  const state = {
    nodes: [],
    nodesById: new Map(),
    byEl: new Map(),
    rootSelector: null,
    lastChanged: false,
    nextId: 1,
    animBirth: new WeakMap(),
    animTimings: [],
    hoisted: new WeakSet(),
    flatSheet: null,
    warnings: [],
    generation: 0,
  };

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'BR']);

  function warn(code, detail) {
    state.warnings.push({ code, detail, generation: state.generation });
  }

  // --- geometry helpers (mirrors src/math/matrix.mjs, kept standalone because
  // --- this file is evaluated inside the page with no module loader) ---------
  function parseMatrix(value) {
    if (!value || value === 'none') return null;
    const m3 = /^matrix3d\(([^)]+)\)$/.exec(value);
    if (m3) {
      const p = m3[1].split(',').map(Number);
      return p.length === 16 && p.every(Number.isFinite) ? p : null;
    }
    const m2 = /^matrix\(([^)]+)\)$/.exec(value);
    if (m2) {
      const p = m2[1].split(',').map(Number);
      if (p.length !== 6 || !p.every(Number.isFinite)) return null;
      return [p[0], p[1], 0, 0, p[2], p[3], 0, 0, 0, 0, 1, 0, p[4], p[5], 0, 1];
    }
    return null;
  }

  function is2d(m) {
    return Math.abs(m[2]) < 1e-9 && Math.abs(m[3]) < 1e-9 && Math.abs(m[6]) < 1e-9
      && Math.abs(m[7]) < 1e-9 && Math.abs(m[8]) < 1e-9 && Math.abs(m[9]) < 1e-9
      && Math.abs(m[10] - 1) < 1e-9 && Math.abs(m[11]) < 1e-9 && Math.abs(m[14]) < 1e-9;
  }

  /** AABB top-left of a w*h box at the local origin under the 2D linear part of m. */
  function localAabbTopLeft(m, w, h) {
    const corners = [[0, 0], [w, 0], [w, h], [0, h]];
    let minX = Infinity;
    let minY = Infinity;
    for (const [x, y] of corners) {
      const px = m[0] * x + m[4] * y;
      const py = m[1] * x + m[5] * y;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
    }
    return [minX, minY];
  }

  function parseOrigin(value) {
    const parts = String(value || '0px 0px').split(/\s+/).map(parseFloat);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }

  // --- structure ------------------------------------------------------------
  function classify(el, cs) {
    const tag = el.tagName;
    if (tag === 'CANVAS') return 'canvas';
    if (tag === 'IMG' || tag === 'PICTURE') return 'image';
    if (tag === 'VIDEO') return 'video';
    if (el.namespaceURI === NS_SVG) return tag === 'svg' ? 'svgRoot' : 'svgShape';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return 'control';
    // A text leaf is an element whose direct children include a non-empty text
    // node; that is the unit that becomes an AE text layer.
    for (const child of el.childNodes) {
      if (child.nodeType === 3 && child.nodeValue.trim()) return 'text';
    }
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return 'imageBox';
    return 'box';
  }

  function paints(cs, role) {
    if (role !== 'box') return true;
    const hasBg = cs.backgroundColor && !/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(cs.backgroundColor)
      && cs.backgroundColor !== 'transparent';
    const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some((side) => {
      const w = parseFloat(cs[`border${side}Width`]) || 0;
      return w > 0 && cs[`border${side}Style`] !== 'none';
    });
    const hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
    const hasOutline = cs.outlineStyle && cs.outlineStyle !== 'none' && (parseFloat(cs.outlineWidth) || 0) > 0;
    return Boolean(hasBg || hasBorder || hasShadow || hasOutline);
  }

  // Indexing is STABLE and CUMULATIVE. An element keeps the id it was first
  // given for the whole capture, and an element that appears mid-animation gets
  // appended rather than renumbering everything after it. That matters because
  // an id is what ties a layer in After Effects to its keyframe track: if ids
  // shifted when the DOM changed, a component mounting at frame 40 would
  // silently rewrite the motion of every layer before it.
  function indexTree(rootSelector) {
    const selector = rootSelector === undefined ? state.rootSelector : rootSelector;
    state.rootSelector = selector;
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) throw new Error(`probe root not found: ${selector}`);

    const seen = new Set();
    let changed = false;

    const walk = (el, parentId, depth) => {
      if (SKIP_TAGS.has(el.tagName)) return;
      const cs = getComputedStyle(el);
      const existing = el.getAttribute('data-d2ae-id');
      let id = existing ? Number(existing) : null;
      if (id !== null && state.byEl.get(id) !== el) id = null; // id was cloned onto a new node
      if (id === null) {
        id = state.nextId;
        state.nextId += 1;
        el.setAttribute('data-d2ae-id', String(id));
        state.byEl.set(id, el);
        const role = classify(el, cs);
        const node = {
          id,
          parentId,
          depth,
          tag: el.tagName.toLowerCase(),
          ns: el.namespaceURI === NS_SVG ? 'svg' : 'html',
          role,
          name: nameOf(el),
          classList: Array.from(el.classList || []),
          domIndex: el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0,
          bornAtGeneration: state.generation,
        };
        state.nodesById.set(id, node);
        state.nodes.push(node);
        changed = true;
      } else {
        // Reparenting and reordering are both real: a JS animation may move a
        // node. Keep the record current so the layer hierarchy follows.
        const node = state.nodesById.get(id);
        const nextIndex = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0;
        if (node.parentId !== parentId || node.domIndex !== nextIndex || node.depth !== depth) {
          node.parentId = parentId;
          node.domIndex = nextIndex;
          node.depth = depth;
          changed = true;
        }
      }
      seen.add(id);
      const role = state.nodesById.get(id).role;
      if (role === 'canvas' || role === 'video') return;
      for (const child of el.children) walk(child, id, depth + 1);
    };
    walk(root, null, 0);

    for (const node of state.nodes) {
      const attached = seen.has(node.id);
      if (node.attached !== attached) { node.attached = attached; changed = true; }
    }
    state.lastChanged = changed;
    return state.nodes;
  }

  function nameOf(el) {
    if (el.id) return el.id;
    if (el.getAttribute && el.getAttribute('data-name')) return el.getAttribute('data-name');
    const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
    const first = String(cls).trim().split(/\s+/)[0];
    return first || el.tagName.toLowerCase();
  }

  // --- per-frame measurement ------------------------------------------------
  function ensureFlatSheet() {
    if (state.flatSheet && state.flatSheet.isConnected) return state.flatSheet;
    const sheet = document.createElement('style');
    sheet.id = 'd2ae-flat';
    // `transform` is the only property we neutralise: it is the only one that
    // moves paint without moving layout, so removing it is provably free.
    sheet.textContent = '*, *::before, *::after { transform: none !important; }';
    state.flatSheet = sheet;
    return sheet;
  }

  function styleSnapshot(cs) {
    return {
      display: cs.display,
      visibility: cs.visibility,
      opacity: parseFloat(cs.opacity),
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      backgroundSize: cs.backgroundSize,
      backgroundPosition: cs.backgroundPosition,
      backgroundRepeat: cs.backgroundRepeat,
      backgroundOrigin: cs.backgroundOrigin,
      color: cs.color,
      borderRadius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
      borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(parseFloat),
      borderColor: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
      borderStyle: [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle],
      boxShadow: cs.boxShadow,
      filter: cs.filter,
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
      mixBlendMode: cs.mixBlendMode,
      overflow: [cs.overflowX, cs.overflowY],
      clipPath: cs.clipPath,
      transformBox: cs.transformBox,
      fontKerning: cs.fontKerning,
      fontFamily: cs.fontFamily,
      fontSize: parseFloat(cs.fontSize),
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textAlign: cs.textAlign,
      textTransform: cs.textTransform,
      textDecorationLine: cs.textDecorationLine,
      whiteSpace: cs.whiteSpace,
      zIndex: cs.zIndex,
      position: cs.position,
      transformStyle: cs.transformStyle,
      perspective: cs.perspective,
      perspectiveOrigin: cs.perspectiveOrigin,
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat),
      // SVG paint
      fill: cs.fill,
      stroke: cs.stroke,
      strokeWidth: parseFloat(cs.strokeWidth),
      strokeDasharray: cs.strokeDasharray,
      strokeDashoffset: parseFloat(cs.strokeDashoffset),
      strokeLinecap: cs.strokeLinecap,
      strokeLinejoin: cs.strokeLinejoin,
      fillOpacity: parseFloat(cs.fillOpacity),
      strokeOpacity: parseFloat(cs.strokeOpacity),
    };
  }

  function directText(el) {
    let out = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) out += child.nodeValue;
    }
    return out;
  }

  function snapshot() {
    const nodes = state.nodes;
    const n = nodes.length;
    const els = nodes.map((node) => state.byEl.get(node.id));

    // --- pass 1: transforms off, one layout, exact untransformed boxes -------
    const sheet = ensureFlatSheet();
    document.head.appendChild(sheet);
    void document.documentElement.offsetWidth;
    const flatRects = new Array(n);
    const residuals = new Array(n);
    // An SVG shape's geometry (`d`, cx/cy, points) is written in its USER space,
    // which the page reaches through the root's viewBox mapping, not through
    // the shape's bounding box. With every transform off, the screen CTM is
    // exactly that mapping, and the layer's own space is made to match it.
    const userFrames = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const node = nodes[i];
      const el = els[i];
      if (!el || !el.isConnected || node.attached === false) {
        flatRects[i] = null; residuals[i] = null; continue;
      }
      const r = el.getBoundingClientRect();
      flatRects[i] = [r.x, r.y, r.width, r.height];
      userFrames[i] = null;
      if (node.role === 'svgShape' && typeof el.getScreenCTM === 'function') {
        try {
          const c = el.getScreenCTM();
          if (c) userFrames[i] = [c.a, c.b, c.c, c.d, c.e, c.f];
        } catch { /* detached or not rendered */ }
      }
      // A transform that survives the flat sheet is a running transition.
      residuals[i] = parseMatrix(getComputedStyle(el).transform);
    }
    sheet.remove();
    void document.documentElement.offsetWidth;

    // --- pass 2: live styles, transforms on --------------------------------
    const out = new Array(n);
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    for (let i = 0; i < n; i += 1) {
      const node = nodes[i];
      const el = els[i];
      if (!el || !el.isConnected || !flatRects[i] || node.attached === false) {
        out[i] = { id: node.id, present: false }; continue;
      }
      const cs = getComputedStyle(el);
      const style = styleSnapshot(cs);
      const matrix = parseMatrix(cs.transform);
      const origin = parseOrigin(cs.transformOrigin);

      let [bx, by, bw, bh] = flatRects[i];
      let residualResolved = true;
      const residual = residuals[i];
      if (residual && !isIdentityish(residual)) {
        if (is2d(residual)) {
          // Undo the surviving transition analytically. The origin terms cancel
          // (see docs/geometry.md), leaving a closed form that needs no inverse:
          //     box = flatTopLeft - localAabbTopLeft - o + A.o - t
          const [ox, oy] = origin;
          const [ax, ay] = localAabbTopLeft(residual, bw, bh);
          const rox = residual[0] * ox + residual[4] * oy;
          const roy = residual[1] * ox + residual[5] * oy;
          bx = bx - ax - ox + rox - residual[12];
          by = by - ay - oy + roy - residual[13];
          // The AABB of a rotated box is larger than the box; restore true size.
          bw = parseFloat(cs.width) + (style.padding[1] + style.padding[3])
            + (style.borderWidth[1] + style.borderWidth[3]);
          bh = parseFloat(cs.height) + (style.padding[0] + style.padding[2])
            + (style.borderWidth[0] + style.borderWidth[2]);
          if (cs.boxSizing === 'border-box') {
            bw = parseFloat(cs.width);
            bh = parseFloat(cs.height);
          }
        } else {
          residualResolved = false;
          warn('residual-3d-transition', { id: node.id, tag: node.tag });
        }
      }

      const entry = {
        id: node.id,
        present: true,
        box: [bx + scrollX, by + scrollY, bw, bh],
        m: matrix,
        origin,
        style,
        residualResolved,
      };
      const uf = userFrames[i];
      if (uf) entry.user = { origin: [uf[4] + scrollX, uf[5] + scrollY], scale: [Math.hypot(uf[0], uf[1]), Math.hypot(uf[2], uf[3])] };

      if (node.role === 'text' || node.role === 'control') {
        entry.text = node.role === 'control' ? (el.value ?? '') : directText(el);
        entry.baseline = measureBaseline(cs);
      }
      if (node.ns === 'svg' && typeof el.getBBox === 'function') {
        try {
          const b = el.getBBox();
          entry.bbox = [b.x, b.y, b.width, b.height];
        } catch { /* getBBox throws on non-rendered SVG */ }
        if (typeof el.getTotalLength === 'function') {
          try { entry.pathLength = el.getTotalLength(); } catch { /* not a geometry element */ }
        }
        if (el.tagName === 'path') entry.d = el.getAttribute('d');
        else if (el.tagName === 'circle') entry.geom = { cx: el.cx.baseVal.value, cy: el.cy.baseVal.value, r: el.r.baseVal.value };
        else if (el.tagName === 'ellipse') entry.geom = { cx: el.cx.baseVal.value, cy: el.cy.baseVal.value, rx: el.rx.baseVal.value, ry: el.ry.baseVal.value };
        else if (el.tagName === 'rect') entry.geom = { x: el.x.baseVal.value, y: el.y.baseVal.value, width: el.width.baseVal.value, height: el.height.baseVal.value, rx: el.rx.baseVal.value, ry: el.ry.baseVal.value };
        else if (el.tagName === 'line') entry.geom = { x1: el.x1.baseVal.value, y1: el.y1.baseVal.value, x2: el.x2.baseVal.value, y2: el.y2.baseVal.value };
        else if (el.tagName === 'polygon' || el.tagName === 'polyline') entry.geom = { points: el.getAttribute('points') };
      }
      if (node.role === 'image') {
        entry.src = el.currentSrc || el.src || '';
        entry.natural = [el.naturalWidth || 0, el.naturalHeight || 0];
        entry.objectFit = cs.objectFit;
      }
      out[i] = entry;
    }
    return out;
  }

  // Where the FIRST BASELINE of this element's text sits, relative to the
  // border-box top-left. After Effects anchors a text layer at its first
  // baseline, whereas every other layer here is anchored at its box top-left --
  // so without this offset all imported text floats up by roughly one ascent,
  // which is glaring at display sizes.
  let metricsCtx = null;
  function measureBaseline(cs) {
    const num = (v) => parseFloat(v) || 0;
    const fontSize = num(cs.fontSize) || 16;
    const lineHeight = cs.lineHeight === 'normal' ? fontSize * 1.2 : (num(cs.lineHeight) || fontSize * 1.2);
    let ascent = fontSize * 0.8;
    let descent = fontSize * 0.2;
    try {
      if (!metricsCtx) metricsCtx = document.createElement('canvas').getContext('2d');
      metricsCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${fontSize}px ${cs.fontFamily}`;
      const m = metricsCtx.measureText('Hxg');
      if (m.fontBoundingBoxAscent) {
        ascent = m.fontBoundingBoxAscent;
        descent = m.fontBoundingBoxDescent;
      }
    } catch { /* canvas unavailable; the 0.8/0.2 approximation stands */ }
    // CSS distributes the difference between line-height and the font's own
    // height equally above and below: the "half-leading" model.
    const halfLeading = (lineHeight - (ascent + descent)) / 2;
    const contentWidth = num(cs.width);
    let dx = num(cs.borderLeftWidth) + num(cs.paddingLeft);
    const align = cs.textAlign;
    if (align === 'center') dx += contentWidth / 2;
    else if (align === 'right' || align === 'end') dx += contentWidth;
    return [dx, num(cs.borderTopWidth) + num(cs.paddingTop) + halfLeading + ascent, ascent, descent];
  }

  function isIdentityish(m) {
    return Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[4]) < 1e-9
      && Math.abs(m[5] - 1) < 1e-9 && Math.abs(m[12]) < 1e-9 && Math.abs(m[13]) < 1e-9 && is2d(m);
  }

  // --- animation scrubbing --------------------------------------------------
  // Every Animation gets a birth time the first frame we see it; its local time
  // is then (virtual now - birth). That is what makes animation-delay, fill
  // modes, iteration counts and JS-triggered transitions all land correctly
  // without us reimplementing any of the Web Animations timing model.
  function scrub(virtualMs) {
    let animations = [];
    try { animations = document.getAnimations(); } catch { return 0; }

    // Hoist transform transitions out of the CSS transition machinery FIRST.
    // A running CSSTransition on `transform` is destroyed and restarted by the
    // flat pass (Chromium treats the !important rule as a before-change style
    // change even though the transition still wins the cascade), so its clock
    // resets to zero on every frame and the motion never advances. Replacing it
    // with an equivalent script-created Animation fixes both halves: script
    // animations sit BELOW !important in the cascade, so the flat pass can
    // neutralise them properly, and nothing recreates them behind our back.
    // Keyframes, timing and easing are copied verbatim, so the motion is the
    // transition's own -- this changes the plumbing, not the animation.
    for (const anim of animations) {
      if (!isTransformTransition(anim)) continue;
      hoistTransition(anim, virtualMs);
    }
    try { animations = document.getAnimations(); } catch { return 0; }

    for (const anim of animations) {
      let birth = state.animBirth.get(anim);
      if (birth === undefined) {
        birth = virtualMs;
        state.animBirth.set(anim, birth);
        recordTiming(anim, birth);
      }
      try {
        if (anim.playState !== 'paused') anim.pause();
        anim.currentTime = virtualMs - birth;
      } catch { /* a cancelled animation rejects currentTime */ }
    }
    return animations.length;
  }

/**
 * Remember each animation's timing against the element it drives.
 *
 * Loop detection reads this rather than looking for periodicity in the sampled
 * values. The page already knows its own cycle length exactly; inferring it from
 * samples would be guesswork that fails on anything whose motion happens to
 * repeat approximately.
 */
function recordTiming(anim, birth) {
  try {
    const target = anim.effect && anim.effect.target;
    if (!target || !target.getAttribute) return;
    const timing = anim.effect.getComputedTiming();
    const entry = {
      // The ELEMENT, not its id: the first scrub happens during the t=0
      // bootstrap, before index() has assigned any ids, so resolving now would
      // file every animation under a phantom element.
      target,
      birth,
      delay: Number(timing.delay) || 0,
      duration: Number(timing.duration) || 0,
      iterations: timing.iterations,
      infinite: !Number.isFinite(timing.iterations),
      direction: timing.direction,
      property: anim.transitionProperty || (anim.animationName || null),
    };
    state.animTimings.push(entry);
  } catch { /* a cancelled animation has no readable timing */ }
}

function isTransformTransition(anim) {
    return typeof anim.transitionProperty === 'string'
      && anim.transitionProperty === 'transform'
      && anim.effect
      && anim.effect.target
      && !state.hoisted.has(anim);
  }

  function hoistTransition(anim, virtualMs) {
    const el = anim.effect.target;
    let keyframes;
    let timing;
    let currentTime;
    try {
      keyframes = anim.effect.getKeyframes().map((k) => ({ ...k }));
      timing = anim.effect.getTiming();
      currentTime = Number(anim.currentTime) || 0;
    } catch { return; }
    if (!keyframes || keyframes.length < 2) return;

    // The swap must be ATOMIC: cancel and replace inside one synchronous block
    // with no forced style flush in between. The browser then does a single
    // recalculation in which the before-change value (the transition's value at
    // this instant) and the after-change value (the replacement animation's
    // value at the same instant) are equal, so no fresh transition is generated.
    //
    // The obvious alternative -- setting `transition-property: none` around the
    // swap -- is wrong: it cancels EVERY transition on the element, so hoisting
    // a transform transition would silently snap a concurrent colour transition
    // straight to its end value.
    try {
      anim.cancel();
      const replacement = el.animate(keyframes, {
        duration: timing.duration,
        delay: timing.delay,
        endDelay: timing.endDelay,
        easing: timing.easing,
        fill: 'both',
        iterations: timing.iterations,
        direction: timing.direction,
      });
      replacement.pause();
      replacement.currentTime = currentTime;
      state.hoisted.add(replacement);
      state.animBirth.set(replacement, virtualMs - currentTime);
      warn('hoisted-transform-transition', { tag: el.tagName.toLowerCase(), id: el.getAttribute('data-d2ae-id') });
    } catch (err) {
      warn('hoist-failed', String(err));
    }
  }

  window.__d2ae = {
    index: indexTree,
    nodes: () => state.nodes,
    snapshot,
    scrub,
    warnings: () => state.warnings,
    animationTimings: () => {
      const out = {};
      for (const entry of state.animTimings) {
        const id = Number(entry.target && entry.target.getAttribute
          ? entry.target.getAttribute('data-d2ae-id') : NaN);
        if (!Number.isFinite(id)) continue;
        if (!out[id]) out[id] = [];
        const { target, ...rest } = entry;
        out[id].push(rest);
      }
      return out;
    },
    setGeneration: (g) => { state.generation = g; },
    /** Advance to `virtualMs` the way a real frame boundary would. */
    seek(virtualMs) {
      scrub(virtualMs);
      if (window.__d2aeClock) window.__d2aeClock.step(virtualMs);
      scrub(virtualMs);
      void document.documentElement.offsetWidth;
      return virtualMs;
    },

    /**
     * Snapshot every canvas as a PNG data URI, in the SAME task as the rAF
     * flush that just drew them -- a WebGL drawing buffer does not survive to
     * the next task, and reading it later yields a blank image with no error.
     */
    canvasFrames() {
      const out = [];
      for (const node of state.nodes) {
        if (node.role !== 'canvas') continue;
        const el = state.byEl.get(node.id);
        if (!el || !el.isConnected) continue;
        try {
          out.push({ id: node.id, url: el.toDataURL('image/png'), width: el.width, height: el.height });
        } catch (err) {
          warn('canvas-read-failed', { id: node.id, detail: String(err) });
        }
      }
      return out;
    },
    /** Did the last index() actually observe a change? */
    lastChanged: () => state.lastChanged,
    documentSize() {
      const d = document.documentElement;
      const b = document.body;
      return [
        Math.max(d.scrollWidth, b ? b.scrollWidth : 0, d.clientWidth),
        Math.max(d.scrollHeight, b ? b.scrollHeight : 0, d.clientHeight),
      ];
    },
  };
})();
