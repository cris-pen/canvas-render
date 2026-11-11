// Draw an After Effects import the way After Effects would composite it, so
// it can be checked against the original without After Effects.
//
// Values come from the IR's own tracks (evaluated with the same ease maths the
// verification uses) and are drawn with AE's layer model: Position, Rotation,
// Scale about the Anchor Point, parenting that composes transforms but not
// opacity, precomps that clip to their size, masks in layer space. The drawing
// happens inside the scene's own page, so text uses exactly the fonts the
// design loaded.
//
// It is a check, not a replacement for After Effects: 3D layers are drawn flat,
// and effects beyond blur and drop shadow are skipped.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { evaluate } from './ir/track.mjs';
import { pathToShape, rampGeometry } from './emit/jsx.mjs';

/** A keyed path morph at time t: linear between keys, as After Effects does it. */
function morphAt(morph, t) {
  const keys = morph.keys;
  let b = keys.findIndex((k) => k.t >= t);
  if (b === -1) b = keys.length - 1;
  const a = Math.max(0, b - 1);
  const ka = keys[a];
  const kb = keys[b];
  const f = kb.t > ka.t ? Math.min(1, Math.max(0, (t - ka.t) / (kb.t - ka.t))) : 1;
  const lerp = (pa, pb) => pa.map((v, i) => [v[0] + (pb[i][0] - v[0]) * f, v[1] + (pb[i][1] - v[1]) * f]);
  return {
    contours: morph.closed.map((closed, k) => {
      const ca = ka.contours[k];
      const cb = kb.contours[k];
      const zeros = ca.vertices.map(() => [0, 0]);
      return {
        vertices: lerp(ca.vertices, cb.vertices),
        inTangents: morph.straight ? zeros : lerp(ca.inTangents, cb.inTangents),
        outTangents: morph.straight ? zeros : lerp(ca.outTangents, cb.outTangents),
        closed,
      };
    }),
  };
}
import { pathFor } from './ir/clippath.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function dataUrl(file) {
  if (!file || !existsSync(file)) return null;
  return `data:${MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'};base64,${readFileSync(file).toString('base64')}`;
}

/** Everything the browser side needs to draw the IR at time t. */
export function resolveAt(ir, t, { assetDir } = {}) {
  const ev = (track, fallback) => {
    const v = evaluate(track, t);
    return v === null || v === undefined ? fallback : v;
  };
  const assets = {};
  for (const a of ir.assets || []) {
    const file = a.file || (a.relative && assetDir ? path.join(assetDir, '..', a.relative) : null);
    assets[a.id] = { kind: a.kind, frames: a.frames || 1, file, width: a.width, height: a.height };
  }
  const comps = {};
  for (const comp of ir.comps) {
    comps[comp.id] = {
      id: comp.id,
      width: comp.width,
      height: comp.height,
      bg: comp.backgroundColor,
      layers: comp.layers.map((l) => {
        const fps = comp.fps || ir.meta.fps;
        const visible = (l.inPoint == null || t >= l.inPoint - 1e-6) && (l.outPoint == null || t < l.outPoint + 1 / fps - 1e-6);
        const tr = l.transform;
        const out = {
          id: l.id,
          name: l.name,
          parentId: l.parentId,
          kind: l.kind,
          compId: l.compId || null,
          visible,
          threeD: !!l.threeD,
          anchor: ev(tr.anchorPoint, [0, 0]),
          position: ev(tr.position, [0, 0]),
          scale: ev(tr.scale, [100, 100]),
          rotation: tr.rotation ? ev(tr.rotation, 0) : (tr.orientation ? (ev(tr.orientation, [0, 0, 0])[2] || 0) : 0),
          opacity: ev(tr.opacity, 100),
          skew: l.skew ? ev(l.skew, 0) : 0,
          blendMode: l.blendMode || null,
          mask: l.mask || null,
          effects: (l.effects || []).map((fx) => {
            if (fx.type === 'gaussianBlur') return { type: fx.type, blur: ev(fx.params.blurriness, 0) };
            if (fx.type === 'dropShadow') return { type: fx.type, ...fx.params };
            return { type: fx.type };
          }),
        };
        if (l.kind === 'shape' && l.shape) {
          const s = l.shape;
          out.shape = {
            size: ev(s.size, [0, 0]),
            roundness: s.roundness ? ev(s.roundness, 0) : 0,
            fill: s.fill ? { color: ev(s.fill.color, [0, 0, 0]), opacity: ev(s.fill.opacity, 100) } : null,
            stroke: s.stroke ? { width: s.stroke.width, color: s.stroke.color.rgb, alpha: s.stroke.color.a } : null,
            gradient: s.gradient && s.gradient.linear ? s.gradient.linear : null,
            // The ramp exactly as the emitter writes it (two stops, circular).
            ramp: s.gradient && s.gradient.linear
              ? rampGeometry(s.gradient.linear, ev(s.size, [0, 0]), s.gradient.css) : null,
            shadows: s.shadows || [],
            image: s.gradientImage || null,
          };
        }
        if (l.kind === 'path' && l.path) {
          const g = l.path.morph ? morphAt(l.path.morph, t) : pathToShape(l.path);
          const off = ev(l.path.dashOffset, 0);
          out.path = {
            contours: g.contours,
            fillRule: l.path.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
            strokeWidth: l.path.strokeWidth,
            strokeColor: ev(l.path.strokeColor, [0, 0, 0]),
            fill: l.path.fillColor && l.path.fillColor.a > 0 ? l.path.fillColor : null,
            dash: l.path.dashArray && l.path.dashArray.length ? { array: l.path.dashArray, offset: off } : null,
            lineCap: l.path.lineCap,
            lineJoin: l.path.lineJoin,
          };
        }
        if (l.kind === 'text' && l.text) {
          const x = l.text;
          out.text = {
            value: x.value, font: x.font, weight: x.weight, italic: x.italic,
            size: ev(x.size, 16), color: ev(x.color, [0, 0, 0]),
            tracking: x.tracking || 0, leading: x.leading, align: x.align, transform: x.transform,
            stack: x.stack || null,
            kern: l.stagger || x.kerning === 'none' ? 'none' : 'normal',
          };
          if (l.stagger) {
            out.text.stagger = {
              from: l.stagger.from,
              members: l.stagger.members.map((m) => ({ charStart: m.charStart, charEnd: m.charEnd, amount: ev(m.amount, 0) })),
            };
          }
        }
        if (l.kind === 'image' && l.image) {
          const a = assets[l.image.assetId];
          out.image = { asset: l.image.assetId, natural: l.image.natural, sequence: !!(a && a.kind === 'sequence'), frame: Math.min((a && a.frames) || 1, Math.floor(t * fps + 1e-6)) };
        }
        const clipSpec = (c, own) => {
          if (!c) return null;
          const values = c.keys.map((k, i) => (own && c.tracks ? ev(c.tracks[k], 0) : c.statics[i]));
          return { shape: c.shape, clipper: c.clipper, values, off: c.off, scale: c.scale, path: pathFor(c.shape, values, { off: c.off, scale: c.scale }) };
        };
        if (l.clip) out.clip = { role: l.clip.role, ...clipSpec(l.clip, true) };
        if (l.clipBy) out.clipBy = { clipper: l.clipBy.clipper };
        return out;
      }),
    };
  }
  return { rootCompId: ir.rootCompId, comps, assets };
}

// The browser side. Runs in the scene's own page, over a full-window canvas.
const RENDERER = String.raw`
window.__aePreview = async function (scene) {
  var W = scene.width, H = scene.height;
  var canvas = document.getElementById('__ae_preview');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = '__ae_preview';
    canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;visibility:visible!important;';
    document.documentElement.appendChild(canvas);
    var hide = document.createElement('style');
    hide.textContent = 'html,body{background:transparent!important}body *:not(#__ae_preview){visibility:hidden!important}';
    document.head.appendChild(hide);
  }
  canvas.width = W; canvas.height = H;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  var images = {};
  async function img(src) {
    if (!src) return null;
    if (images[src]) return images[src];
    var im = new Image(); im.src = src;
    try { await im.decode(); } catch (e) { return null; }
    images[src] = im; return im;
  }
  for (var id in scene.assetUrls) await img(scene.assetUrls[id]);

  function mat(l) {
    // p_parent = Position + R(rotation) . S(scale) . (p - Anchor), plus skew.
    var r = (l.rotation || 0) * Math.PI / 180;
    var sx = l.scale[0] / 100, sy = l.scale[1] / 100;
    var m = new DOMMatrix();
    m = m.translate(l.position[0], l.position[1]).rotate(l.rotation || 0).scale(sx, sy);
    if (l.skew) m = m.skewX(l.skew);
    return m.translate(-l.anchor[0], -l.anchor[1]);
  }
  function world(layers, l) {
    var m = mat(l), p = l;
    var guard = 0;
    while (p.parentId !== null && p.parentId !== undefined && guard++ < 64) {
      var parent = layers.find(function (x) { return x.id === p.parentId; });
      if (!parent) break;
      m = mat(parent).multiply(m);
      p = parent;
    }
    return m;
  }
  function tracePath(ctx, g) {
    var v = g.vertices, ti = g.inTangents, to = g.outTangents, n = v.length;
    if (!n) return;
    ctx.moveTo(v[0][0], v[0][1]);
    var last = g.closed ? n : n - 1;
    for (var i = 0; i < last; i++) {
      var a = v[i], b = v[(i + 1) % n], o = to[i], ii = ti[(i + 1) % n];
      if (!o[0] && !o[1] && !ii[0] && !ii[1]) ctx.lineTo(b[0], b[1]);
      else ctx.bezierCurveTo(a[0] + o[0], a[1] + o[1], b[0] + ii[0], b[1] + ii[1], b[0], b[1]);
    }
    if (g.closed) ctx.closePath();
  }
  function rgba(c, a) { return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (a === undefined ? 1 : a) + ')'; }
  function roundRect(ctx, w, h, r) {
    r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
    if (ctx.roundRect) ctx.roundRect(0, 0, w, h, r); else ctx.rect(0, 0, w, h);
  }
  function drawText(ctx, x) {
    // The page's whole font stack, so the preview measures the font the page
    // fell back to on this machine (After Effects gets the first family).
    var family = x.stack || ('"' + x.font + '"');
    var font = (x.italic ? 'italic ' : '') + (x.weight || 400) + ' ' + x.size + 'px ' + family;
    ctx.font = font;
    try { ctx.fontKerning = x.kern; } catch (e) {}
    ctx.letterSpacing = ((x.tracking || 0) / 1000 * x.size) + 'px';
    ctx.textBaseline = 'alphabetic';
    var align = x.align === 'center' ? 'center' : (x.align === 'right' || x.align === 'end' ? 'right' : 'left');
    ctx.textAlign = align;
    var value = String(x.value);
    if (x.transform === 'uppercase') value = value.toUpperCase();
    var lines = value.split(/\r\n|\r|\n/);
    var lead = x.leading || x.size * 1.2;
    ctx.fillStyle = rgba(x.color, 1);
    if (!x.stagger) {
      for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], 0, i * lead);
      return;
    }
    // A text animator: each member's characters take the "from" state by its Amount.
    ctx.textAlign = 'left';
    var start = align === 'center' ? -ctx.measureText(value).width / 2 : (align === 'right' ? -ctx.measureText(value).width : 0);
    var st = x.stagger;
    for (var c = 0; c < value.length; c++) {
      var amt = 0;
      for (var k = 0; k < st.members.length; k++) {
        var m = st.members[k];
        if (c >= m.charStart && c < m.charEnd) amt = m.amount / 100;
      }
      var px = start + ctx.measureText(value.slice(0, c)).width;
      var dx = st.from.position ? st.from.position[0] * amt : 0;
      var dy = st.from.position ? st.from.position[1] * amt : 0;
      var op = st.from.opacity !== null && st.from.opacity !== undefined ? 1 + (st.from.opacity / 100 - 1) * amt : 1;
      ctx.save();
      ctx.globalAlpha *= op;
      ctx.translate(px + dx, dy);
      if (st.from.rotation) ctx.rotate(st.from.rotation * amt * Math.PI / 180);
      if (st.from.scale) ctx.scale(1 + (st.from.scale[0] / 100 - 1) * amt, 1 + (st.from.scale[1] / 100 - 1) * amt);
      ctx.fillText(value[c], 0, 0);
      ctx.restore();
    }
  }
  function clipOf(layers, l, ctx) {
    // A member of a clip-path: the clipper's region, in comp space through the
    // clipper's own transform. (A clipper's own mask is applied in its layer space.)
    if (!l.clipBy) return;
    var clipper = layers.find(function (x) { return x.name === l.clipBy.clipper; });
    var spec = clipper && clipper.clip;
    if (!spec) return;
    ctx.setTransform(world(layers, clipper));
    ctx.beginPath(); tracePath(ctx, spec.path); ctx.clip();
  }
  async function drawComp(compId) {
    var comp = scene.comps[compId];
    var c = document.createElement('canvas'); c.width = comp.width; c.height = comp.height;
    var ctx = c.getContext('2d');
    // A comp's background colour shows in AE's viewer but renders as alpha, so it is not drawn.
    for (var i = 0; i < comp.layers.length; i++) {
      var l = comp.layers[i];
      if (!l.visible || l.kind === 'null') continue;
      var tmp = document.createElement('canvas'); tmp.width = comp.width; tmp.height = comp.height;
      var t = tmp.getContext('2d');
      t.save();
      clipOf(comp.layers, l, t);
      var m = world(comp.layers, l);
      t.setTransform(m);
      if (l.mask) { t.beginPath(); tracePath(t, l.mask); t.clip(); }
      if (l.clip && l.clip.role === 'self') { t.beginPath(); tracePath(t, l.clip.path); t.clip(); }
      var blur = l.effects.find(function (f) { return f.type === 'gaussianBlur'; });
      if (blur && blur.blur > 0) t.filter = 'blur(' + blur.blur + 'px)';
      if (l.kind === 'shape' && l.shape) {
        var s = l.shape;
        t.beginPath(); roundRect(t, s.size[0], s.size[1], s.roundness);
        for (var k = 0; k < s.shadows.length; k++) {
          var sh = s.shadows[k];
          if (sh.inset) continue;
          t.save(); t.shadowColor = rgba(sh.color.rgb, sh.color.a); t.shadowBlur = sh.blur; t.shadowOffsetX = sh.dx; t.shadowOffsetY = sh.dy;
          t.fillStyle = s.fill ? rgba(s.fill.color, s.fill.opacity / 100) : 'rgba(0,0,0,1)'; t.fill(); t.restore();
        }
        if (s.gradient && s.gradient.stops && s.gradient.stops.length >= 2) {
          var rp = s.ramp;
          var g = s.gradient.kind === 'radial' || s.gradient.kind === 'conic'
            ? t.createRadialGradient(rp.start[0], rp.start[1], 0, rp.start[0], rp.start[1],
              Math.hypot(rp.end[0] - rp.start[0], rp.end[1] - rp.start[1]))
            : t.createLinearGradient(rp.start[0], rp.start[1], rp.end[0], rp.end[1]);
          var first = s.gradient.stops[0], lastS = s.gradient.stops[s.gradient.stops.length - 1];
          g.addColorStop(0, rgba(first.color.rgb, first.color.a)); g.addColorStop(1, rgba(lastS.color.rgb, lastS.color.a));
          t.fillStyle = g; t.fill();
        } else if (s.fill) { t.fillStyle = rgba(s.fill.color, s.fill.opacity / 100); t.fill(); }
        if (s.stroke && s.stroke.width > 0) { t.lineWidth = s.stroke.width; t.strokeStyle = rgba(s.stroke.color, s.stroke.alpha); t.stroke(); }
      } else if (l.kind === 'path' && l.path) {
        var p = l.path;
        t.beginPath();
        for (var ci = 0; ci < p.contours.length; ci++) tracePath(t, p.contours[ci]);
        if (p.fill) { t.fillStyle = rgba(p.fill.rgb, p.fill.a); t.fill(p.fillRule); }
        if (p.strokeWidth > 0) {
          t.lineWidth = p.strokeWidth; t.strokeStyle = rgba(p.strokeColor, 1);
          t.lineCap = p.lineCap || 'butt'; t.lineJoin = p.lineJoin || 'miter';
          if (p.dash) { t.setLineDash(p.dash.array); t.lineDashOffset = p.dash.offset; }
          t.stroke();
        }
      } else if (l.kind === 'text' && l.text) {
        drawText(t, l.text);
      } else if (l.kind === 'image' && l.image) {
        var url = scene.assetUrls[l.image.asset + (l.image.sequence ? ':' + l.image.frame : '')] || scene.assetUrls[l.image.asset];
        var im = await img(url);
        if (im) t.drawImage(im, 0, 0, l.image.natural[0], l.image.natural[1]);
      } else if (l.kind === 'precomp' && l.compId) {
        var sub = await drawComp(l.compId);
        t.drawImage(sub, 0, 0);
      } else if (l.kind === 'raster') {
        t.fillStyle = 'rgba(255,0,255,0.35)'; t.fillRect(0, 0, 40, 40);
      }
      t.restore();
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, l.opacity / 100));
      if (l.blendMode) ctx.globalCompositeOperation = l.blendMode.toLowerCase().replace(/_/g, '-').replace('classic-', '');
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
    }
    return c;
  }
  var root = await drawComp(scene.rootCompId);
  var out = canvas.getContext('2d');
  out.clearRect(0, 0, W, H);
  out.drawImage(root, 0, 0);
  return true;
};
`;

/**
 * Draw the IR at each time inside the scene's page and screenshot it, beside a
 * screenshot of the page itself at the same time. Returns [{ t, original, preview }].
 */
export async function previewFrames({ browser, roots, scene, info, ir, times, assetDir, wireContext, clockInit }) {
  const context = await browser.newContext({ viewport: { width: info.width, height: info.height }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  await wireContext(context, roots);
  await context.addInitScript({ content: clockInit });
  const page = await context.newPage();
  const out = [];
  try {
    await page.goto(scene.url, { waitUntil: 'load', timeout: 90000 });
    await page.evaluate((o) => window.__cr.ready(o), { transparent: true });
    await page.addScriptTag({ content: RENDERER });
    for (const t of times) {
      await page.evaluate((ms) => window.__cr.seek(ms), t * 1000);
      const original = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: info.width, height: info.height } });
      const resolved = resolveAt(ir, t, { assetDir });
      const assetUrls = {};
      for (const [id, a] of Object.entries(resolved.assets)) {
        if (a.kind === 'sequence' && a.file) {
          const dir = path.dirname(a.file);
          const frame = Math.min(a.frames - 1, Math.floor(t * ir.meta.fps + 1e-6));
          const files = (await import('node:fs')).readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
          assetUrls[`${id}:${frame}`] = dataUrl(path.join(dir, files[Math.min(files.length - 1, frame)]));
        } else assetUrls[id] = dataUrl(a.file);
      }
      await page.evaluate((s) => window.__aePreview(s), { ...resolved, width: info.width, height: info.height, assetUrls });
      const preview = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: info.width, height: info.height } });
      await page.evaluate(() => { const c = document.getElementById('__ae_preview'); if (c) c.remove(); document.querySelectorAll('style').forEach((s) => { if (/__ae_preview/.test(s.textContent)) s.remove(); }); });
      out.push({ t, original, preview });
    }
  } finally {
    await context.close().catch(() => {});
  }
  return out;
}
