// Canvas Render window. Talks to the local engine at the same origin.
// In the Mac app, window.canvasRender (from the preload) adds file paths,
// folder pickers and Finder integration.

const host = window.canvasRender || null;
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
};

const RATES = { '23.976': [24000, 1001], 24: [24, 1], 25: [25, 1], '29.97': [30000, 1001], 30: [30, 1], 50: [50, 1], '59.94': [60000, 1001], 60: [60, 1] };
const MARKER_COLORS = ['#4cc38a', '#b48cff', '#4fb6e8', '#f08c4a', '#e86fa6', '#d9d35b'];
const KIND = { board: 'Board', standalone: 'Standalone export', html: 'HTML page', url: 'Web page' };
const PHASE = {
  queued: 'Waiting', checking: 'Checking for changes', rendering: 'Rendering', splicing: 'Splicing into the last render', encoding: 'Encoding', review: 'Making the review copy',
  capturing: 'Measuring', building: 'Building layers', isolating: 'Rendering raster layers', writing: 'Writing the script',
};
const BG_DEFAULT = { mode: 'page', color: '#101418', gradient: { kind: 'linear', angle: 180, from: '#1d2a33', to: '#0b1014' }, image: null, replace: false };

const state = {
  status: null,
  projects: new Map(),
  order: [],
  projectId: null,
  sceneId: null,
  frame: 0,
  ranges: {},       // `${project name}/${scene name}` -> { in, out }
  outDirs: {},      // project id -> folder
  carried: {},      // project id -> name of the project it continues
  settings: null,
  presetId: null,
  jobs: new Map(),
  batches: new Map(),
  batchOrder: [],
};

// ---------- api ----------
async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Canvas-Render': '1', ...(raw ? {} : { 'Content-Type': 'application/json' }) },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.blob();
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(msg, kind = 'error') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 7000 : 3500);
}

// ---------- time ----------
function rate() { const [n, d] = RATES[state.settings.rate] || [24000, 1001]; return { n, d, fps: n / d, base: Math.round(n / d) }; }
function framesOf(scene) { const r = rate(); return Math.max(1, Math.round((scene.info.duration * r.n) / r.d)); }
function secondsAt(f) { const r = rate(); return (f * r.d) / r.n; }
function tc(f) {
  const { base } = rate();
  const ff = f % base; const s = Math.floor(f / base);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, ff].map((v) => String(v).padStart(2, '0')).join(':');
}
function dur(seconds) { return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s` : `${+seconds.toFixed(seconds < 10 ? 2 : 1)} s`; }

// ---------- current selection ----------
const project = () => state.projects.get(state.projectId) || null;
const scene = () => { const p = project(); return p ? p.scenes.find((s) => s.id === state.sceneId) || null : null; };
const rangeKey = (p, s) => `${p.name}/${s.name}`;
function rangeOf(p, s) {
  const total = framesOf(s);
  const r = state.ranges[rangeKey(p, s)] || {};
  const a = Math.max(0, Math.min(total - 1, r.in ?? 0));
  const b = Math.max(a, Math.min(total - 1, r.out ?? total - 1));
  return { in: a, out: b, set: r.in != null || r.out != null, total };
}
function usable(s) { return s.info && !s.error && !s.pending; }

function shortPath(p) {
  const home = state.status && state.status.home;
  const dir = p.replace(/[\\/][^\\/]*$/, '');
  return home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

// ---------- rendering the window ----------
function renderTools() {
  const s = state.status; const box = $('#tools'); box.replaceChildren();
  if (!s) return;
  box.append(el('span', { class: s.ffmpeg && s.prores ? 'ok' : 'bad', text: s.ffmpeg ? (s.prores ? 'ffmpeg' : 'ffmpeg, no ProRes') : 'ffmpeg missing' }));
  box.append(el('span', { class: s.chrome ? 'ok' : 'bad', text: s.chrome ? 'Render browser' : 'Render browser missing' }));

  const setup = $('#setup'); setup.replaceChildren();
  if (!s.ffmpeg || !s.prores) {
    const cmd = 'brew install ffmpeg';
    setup.append(el('div', { class: 'item' },
      el('p', {}, s.ffmpeg ? 'This ffmpeg has no ProRes encoder. Install the Homebrew build: ' : 'ffmpeg encodes every format and is not installed. In Terminal, run ', el('code', { text: cmd })),
      el('button', { class: 'ghost small', type: 'button', onclick: () => { navigator.clipboard.writeText(cmd); toast('Copied.', 'info'); } }, 'Copy'),
      el('button', { class: 'ghost small', type: 'button', onclick: refreshStatus }, 'Check again')));
  }
  if (!s.chrome) {
    const running = s.setup && s.setup.running;
    setup.append(el('div', { class: 'item' },
      el('p', { text: 'Renders run in a headless Chromium. Download it once (about 150 MB), or install Google Chrome.' }),
      el('button', { class: 'primary', type: 'button', disabled: running, onclick: installChrome }, running ? 'Downloading…' : 'Download Chromium'),
      el('div', { class: 'log', id: 'setup-log', text: s.setup && s.setup.log && s.setup.log.length ? s.setup.log[s.setup.log.length - 1] : '' })));
  }
  setup.hidden = !setup.children.length;
}

function renderTabs() {
  const box = $('#tabs'); box.replaceChildren();
  for (const id of state.order) {
    const p = state.projects.get(id);
    box.append(el('div', { class: `tab${id === state.projectId ? ' on' : ''}`, role: 'button', tabindex: 0, title: p.source || p.name,
      onclick: () => selectProject(id), onkeydown: (e) => { if (e.key === 'Enter') selectProject(id); } },
    el('span', { class: 'name', text: p.name }),
    el('span', { class: 'x', role: 'button', 'aria-label': `Close ${p.name}`, title: 'Close', onclick: (e) => { e.stopPropagation(); closeProject(id); } }, '×')));
  }
  $('#open-btn').hidden = !state.order.length;
}

function renderRecent() {
  const box = $('#recent'); box.replaceChildren();
  const recent = (state.status && state.status.prefs && state.status.prefs.recent) || [];
  if (!recent.length) return;
  box.append(el('h2', { text: 'Recent' }));
  for (const r of recent.slice(0, 5)) {
    box.append(el('button', { type: 'button', title: r.source, onclick: () => openPath(r.source) },
      el('span', { text: r.name }), el('span', { class: 'path', text: shortPath(r.source) })));
  }
}

function renderScenes() {
  const p = project(); const list = $('#scene-list'); list.replaceChildren();
  $('#drop').hidden = !!p;
  if (!p) { $('#scene-count').textContent = ''; $('#carry').hidden = true; return; }
  const chosen = p.scenes.filter((s) => s.selected && usable(s)).length;
  $('#scene-count').textContent = `${chosen} of ${p.scenes.length} to render`;
  for (const s of p.scenes) {
    const ok = usable(s);
    const li = el('li', { class: `scene${s.id === state.sceneId ? ' on' : ''}${s.pending ? ' pending' : ''}${s.error ? ' failed' : ''}`,
      onclick: (e) => { if (e.target.tagName !== 'INPUT') selectScene(s.id); } });
    const box = el('input', { type: 'checkbox', 'aria-label': `Render ${s.name}`, disabled: !ok });
    box.checked = !!s.selected && ok;
    box.addEventListener('change', () => { s.selected = box.checked; renderScenes(); renderGo(); });
    li.append(box, el('div', { class: 'title', title: s.rel || s.name, text: s.name }));
    const meta = el('div', { class: 'meta' });
    if (s.info) {
      meta.append(el('span', { text: `${s.info.width} × ${s.info.height}` }), el('span', { text: dur(s.info.duration) }));
      if (s.info.mode === 'page') meta.append(el('span', { class: 'kind', text: s.info.durationSource === 'default' ? 'length guessed' : 'page' }));
    }
    meta.append(el('span', { class: 'kind', text: KIND[s.kind] || s.kind }));
    if (s.empty) li.classList.add('failed');
    li.append(meta);
    if (s.error) li.append(el('div', { class: 'err', text: s.error }));
    else if (s.note) li.append(el('div', { class: 'note', text: s.note }));
    if (ok) { const r = rangeOf(p, s); if (r.set) li.append(el('div', { class: 'io', text: `${tc(r.in)} to ${tc(r.out)}` })); }
    list.append(li);
  }
  const carry = $('#carry');
  carry.hidden = !state.carried[p.id];
  if (state.carried[p.id]) carry.textContent = `Same boards as ${state.carried[p.id]}, so this saves to the same folder and only re-renders frames that changed.`;
}

function renderPresets() {
  const box = $('#presets'); box.replaceChildren();
  for (const pr of state.status.presets) {
    box.append(el('button', { class: `preset${pr.id === state.presetId ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(pr.id === state.presetId),
      onclick: () => applyPreset(pr.id) }, el('b', { text: pr.label }), el('small', { text: pr.detail })));
  }
}

function renderFields() {
  const s = state.settings; const fmt = state.status.formats[s.format];
  $('#f-format').value = s.format;
  $('#f-rate').value = s.rate;
  for (const b of document.querySelectorAll('#f-size button')) {
    const on = !s.width && b.dataset.size === s.size;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); b.setAttribute('role', 'radio');
  }
  const sc = scene();
  $('#size-hint').textContent = sc && sc.info ? `${sc.info.width} × ${sc.info.height} becomes ${outSize(sc.info).join(' × ')}` : '';
  const ae = !!fmt.editable;
  const bg = background();
  const plate = bg.mode !== 'page';
  const tr = $('#f-transparent');
  tr.checked = !!s.transparent && fmt.alpha && !plate; tr.disabled = !fmt.alpha || plate;
  tr.closest('.check').classList.toggle('off', !fmt.alpha || plate);
  $('#alpha-hint').textContent = ae ? '' : plate && fmt.alpha ? 'A background fills the frame, so there is no alpha.' : fmt.alpha ? '' : `${fmt.label} has no alpha channel.`;
  // After Effects output rebuilds the scene natively: size, blur, plates and the
  // timeline extras do not apply.
  for (const id of ['#f-size', '#transparent-row', '#f-blur', '#review-row', '#f-xml', '#f-partial', '#bg-field']) {
    const row = id.startsWith('#f-') ? $(id).closest('.field, .check') : $(id);
    row.hidden = ae;
  }
  $('#blur-opts').hidden = ae;
  $('#alpha-hint').hidden = ae;
  $('#ae-opts').hidden = !ae;
  $('#f-ae-gradients').checked = (s.aeFallbacks || []).includes('gradients');
  renderBackground();
  $('#f-blur').checked = s.motionBlur.enabled;
  $('#blur-opts').classList.toggle('off', !s.motionBlur.enabled);
  $('#f-shutter').value = s.motionBlur.shutter;
  $('#f-samples').value = String(s.motionBlur.samples);
  if (!ae) $('#review-row').hidden = s.format === 'h264';
  $('#f-review').checked = !!s.review;
  $('#f-xml').checked = !!s.xml;
  $('#f-xml').disabled = s.format === 'png';
  $('#f-xml').closest('.check').classList.toggle('off', s.format === 'png');
  $('#f-partial').checked = !!s.partial;
  const p = project();
  const od = $('#f-outdir');
  od.value = p ? outDirFor(p) : '';
  od.title = od.value;
  if (document.activeElement !== od) requestAnimationFrame(() => { od.scrollLeft = od.scrollWidth; });
  $('#f-outdir').disabled = !p;
  $('#pick-folder').disabled = !p || !host;
  $('#pick-folder').hidden = !host;
  renderGo();
}

function background() {
  const b = state.settings.background || {};
  return { ...BG_DEFAULT, ...b, gradient: { ...BG_DEFAULT.gradient, ...(b.gradient || {}) } };
}

function setBackground(patch) {
  const b = background();
  setSettings({ background: { ...b, ...patch, gradient: { ...b.gradient, ...(patch.gradient || {}) } } });
}

function plateCss(p) {
  if (p.mode === 'color') return p.color;
  if (p.mode === 'gradient') {
    const g = { ...BG_DEFAULT.gradient, ...(p.gradient || {}) };
    return g.kind === 'radial' ? `radial-gradient(farthest-corner at 50% 45%, ${g.from}, ${g.to})` : `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})`;
  }
  return 'repeating-conic-gradient(var(--check-a) 0 25%, var(--check-b) 0 50%) 0 0 / 8px 8px';
}

function samePlate(a, b) {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'color') return a.color.toLowerCase() === b.color.toLowerCase();
  if (a.mode === 'gradient') {
    const x = { ...BG_DEFAULT.gradient, ...a.gradient }; const y = { ...BG_DEFAULT.gradient, ...b.gradient };
    return x.kind === y.kind && x.from.toLowerCase() === y.from.toLowerCase() && x.to.toLowerCase() === y.to.toLowerCase() && (x.kind === 'radial' || Number(x.angle) === Number(y.angle));
  }
  return a.mode === 'image' && a.image === b.image;
}

function renderBackground() {
  const b = background();
  for (const btn of document.querySelectorAll('#f-bg button')) {
    const on = btn.dataset.bg === b.mode;
    btn.classList.toggle('on', on); btn.setAttribute('aria-checked', String(on)); btn.setAttribute('role', 'radio');
  }
  $('#bg-opts').hidden = b.mode === 'page';
  $('#bg-color-row').hidden = b.mode !== 'color';
  $('#bg-grad-row').hidden = b.mode !== 'gradient';
  $('#bg-image-row').hidden = b.mode !== 'image';
  $('#f-bg-color').value = b.color;
  if (document.activeElement !== $('#f-bg-hex')) $('#f-bg-hex').value = b.color;
  $('#f-bg-from').value = b.gradient.from;
  $('#f-bg-to').value = b.gradient.to;
  $('#f-bg-kind').value = b.gradient.kind;
  $('#f-bg-angle').value = b.gradient.angle;
  $('#bg-angle-wrap').hidden = b.gradient.kind === 'radial';
  if (document.activeElement !== $('#f-bg-image')) $('#f-bg-image').value = b.image || '';
  $('#pick-bg-image').hidden = !(host && host.pickImage);
  $('#f-bg-replace').checked = !!b.replace;
  const box = $('#bg-swatches'); box.replaceChildren();
  const saved = (state.status.prefs && state.status.prefs.swatches) || [];
  const all = [...(state.status.plates || []).map((p) => ({ ...p, builtIn: true })), ...saved.map((sw, i) => ({ id: `saved-${i}`, label: sw.label || 'Saved', plate: sw.plate, index: i }))];
  for (const sw of all) {
    const pl = { ...BG_DEFAULT, ...sw.plate, gradient: { ...BG_DEFAULT.gradient, ...(sw.plate.gradient || {}) } };
    const btn = el('button', {
      class: `swatch${sw.builtIn ? '' : ' saved'}${samePlate(pl, b) ? ' on' : ''}`, type: 'button',
      title: sw.builtIn ? sw.label : `${sw.label}. Alt-click to remove.`,
      onclick: (e) => {
        if (!sw.builtIn && e.altKey) { saveSwatches(saved.filter((_, i) => i !== sw.index)); return; }
        setBackground({ mode: pl.mode, color: pl.color, gradient: pl.gradient, image: pl.mode === 'image' ? pl.image : b.image });
      },
    });
    btn.style.background = plateCss(pl);
    box.append(btn);
  }
  if (b.mode !== 'image') {
    box.append(el('button', { class: 'swatch add', type: 'button', title: 'Save this background', 'aria-label': 'Save this background',
      onclick: () => { if (!all.some((sw) => samePlate({ ...BG_DEFAULT, ...sw.plate, gradient: { ...BG_DEFAULT.gradient, ...(sw.plate.gradient || {}) } }, b))) saveSwatches([...saved, { label: b.mode === 'color' ? b.color : `${b.gradient.from} to ${b.gradient.to}`, plate: { mode: b.mode, color: b.color, gradient: b.gradient } }]); } }, '+'));
  }
}

async function saveSwatches(list) {
  try {
    const prefs = await api('/api/prefs', { method: 'PUT', body: { swatches: list } });
    state.status.prefs = prefs;
    renderBackground();
  } catch (err) { toast(err.message); }
}

function outSize(info) {
  const s = state.settings; let k = 1;
  if (s.width) k = s.width / info.width;
  else if (s.size === 'half') k = 0.5;
  else if (s.size === 'hd') k = Math.min(1920 / info.width, 1080 / info.height);
  else if (s.size === 'uhd') k = Math.min(3840 / info.width, 2160 / info.height);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return [even(info.width * k), even(info.height * k)];
}

function renderGo() {
  const p = project(); const btn = $('#render-btn'); const hint = $('#go-hint');
  const n = p ? p.scenes.filter((s) => s.selected && usable(s)).length : 0;
  const tools = state.status && state.status.ffmpeg && state.status.chrome;
  const s = state.settings;
  const ae = state.status && state.status.formats[s.format] && state.status.formats[s.format].editable;
  btn.disabled = !n || !tools;
  const verb = ae ? 'Convert' : 'Render';
  btn.textContent = n > 1 ? `${verb} ${n} scenes` : verb;
  if (!p) hint.textContent = '';
  else if (!tools) hint.textContent = 'Finish setup above to render.';
  else if (!n) hint.textContent = 'Tick at least one scene.';
  else if (ae) hint.textContent = 'Makes a .jsx per scene. Run it in After Effects, or use Open in After Effects when it is done.';
  else if (s.motionBlur.enabled) hint.textContent = `Motion blur captures ${s.motionBlur.samples} samples per frame, so it takes about ${s.motionBlur.samples} times as long.`;
  else hint.textContent = '';
}

function alphaPreview() {
  const fmt = state.status && state.settings ? state.status.formats[state.settings.format] : null;
  return !!(fmt && fmt.alpha && state.settings.transparent && background().mode === 'page' && !fmt.editable);
}

function renderViewer() {
  const p = project(); const s = scene();
  const frame = $('#frame'); const msg = $('#frame-msg'); const img = $('#preview');
  frame.classList.toggle('alpha', alphaPreview());
  if (!p || !s) { msg.textContent = p ? 'Pick a scene.' : ''; img.hidden = true; renderRuler(); return; }
  if (s.pending) { msg.textContent = 'Loading the scene…'; img.hidden = true; }
  else if (!s.info) { msg.textContent = s.error || 'This scene did not load.'; img.hidden = true; }
  else { msg.textContent = ''; img.hidden = false; }
  fitFrame();
  renderRuler();
  if (usable(s)) requestPreview();
}

function fitFrame() {
  const s = scene(); const frame = $('#frame'); const v = $('#viewer');
  const w = s && s.info ? s.info.width : 16; const h = s && s.info ? s.info.height : 9;
  const box = v.getBoundingClientRect();
  const k = Math.min((box.width - 36) / w, (box.height - 36) / h);
  frame.style.width = `${Math.max(1, Math.floor(w * k))}px`;
  frame.style.height = `${Math.max(1, Math.floor(h * k))}px`;
}

// ---------- ruler ----------
function renderRuler() {
  const ruler = $('#ruler'); const canvas = $('#ticks'); const p = project(); const s = scene();
  const rect = ruler.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, rect.width, rect.height);
  const sections = $('#sections'); sections.replaceChildren();
  const inout = $('#inout'); const head = $('#playhead');
  const ok = s && usable(s);
  $('#transport').classList.toggle('off', !ok);
  if (!ok) { inout.classList.add('none'); head.style.display = 'none'; $('#tc').textContent = '00:00:00:00'; $('#range').textContent = ''; return; }
  const total = framesOf(s); const r = rate(); const W = rect.width; const pad = 10; const usableW = W - pad * 2;
  const x = (f) => pad + (f / Math.max(1, total - 1)) * usableW;
  ruler.setAttribute('aria-valuemax', String(total - 1)); ruler.setAttribute('aria-valuenow', String(state.frame)); ruler.setAttribute('aria-valuetext', tc(state.frame));

  // Ticks every frame when there is room, otherwise every second / every few seconds.
  const pxPerFrame = usableW / Math.max(1, total - 1);
  const secondsStep = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((n) => n * r.fps * pxPerFrame >= 96) || 600;
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textBaseline = 'top';
  for (let f = 0; f < total; f += 1) {
    const sec = f % r.base === 0;
    if (!sec && pxPerFrame < 5) continue;
    const xx = Math.round(x(f)) + 0.5;
    ctx.strokeStyle = sec ? '#5a5d65' : '#393b41';
    ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, sec ? 9 : 5); ctx.stroke();
    const secs = f / r.base;
    if (sec && secs % secondsStep === 0 && xx + 76 < W) { ctx.fillStyle = '#7d8088'; ctx.fillText(tc(f), xx + 4, 7); }
  }
  ctx.fillStyle = '#2b2d32'; ctx.fillRect(pad, 46, usableW, 4);

  (s.info.scenes || []).forEach((sec, i) => {
    const a = Math.round((sec.start * r.n) / r.d);
    const b = i + 1 < s.info.scenes.length ? Math.round((s.info.scenes[i + 1].start * r.n) / r.d) : total - 1;
    const node = el('div', { class: 'section', title: sec.desc ? `${sec.name}: ${sec.desc}` : sec.name }, el('span', { text: sec.name }));
    node.style.left = `${x(a)}px`; node.style.width = `${Math.max(4, x(b) - x(a))}px`; node.style.color = MARKER_COLORS[i % MARKER_COLORS.length];
    sections.append(node);
  });

  const rg = rangeOf(p, s);
  inout.classList.toggle('none', !rg.set);
  inout.style.left = `${x(rg.in) - 1}px`; inout.style.width = `${Math.max(2, x(rg.out) - x(rg.in) + 2)}px`;
  head.style.display = ''; head.style.left = `${x(state.frame)}px`;
  $('#tc').textContent = tc(state.frame);
  const count = rg.out - rg.in + 1;
  $('#range').textContent = rg.set ? `In ${tc(rg.in)}  Out ${tc(rg.out)}  ${count} frames` : `${total} frames at ${state.settings.rate}`;
}

function frameFromPointer(e) {
  const s = scene(); if (!s || !usable(s)) return 0;
  const rect = $('#ruler').getBoundingClientRect(); const pad = 10;
  const t = (e.clientX - rect.left - pad) / (rect.width - pad * 2);
  return Math.round(Math.max(0, Math.min(1, t)) * (framesOf(s) - 1));
}

function seek(f) {
  const s = scene(); if (!s || !usable(s)) return;
  state.frame = Math.max(0, Math.min(framesOf(s) - 1, Math.round(f)));
  renderRuler();
  requestPreview();
}

// ---------- preview ----------
let previewBusy = false; let previewAgain = false; let previewUrl = null;
async function requestPreview() {
  if (previewBusy) { previewAgain = true; return; }
  const p = project(); const s = scene(); if (!p || !s || !usable(s)) return;
  previewBusy = true; previewAgain = false;
  const w = Math.min(1920, Math.round($('#frame').getBoundingClientRect().width * (window.devicePixelRatio || 1)) || 960);
  const t = secondsAt(state.frame);
  const alpha = alphaPreview() ? '&alpha=1' : '';
  const fmt = state.status.formats[state.settings.format];
  const b = background();
  const bg = b.mode !== 'page' && !(fmt && fmt.editable) && (b.mode !== 'image' || b.image) ? `&bg=${encodeURIComponent(JSON.stringify(b))}` : '';
  try {
    const blob = await api(`/api/preview?project=${encodeURIComponent(p.id)}&scene=${encodeURIComponent(s.id)}&t=${t.toFixed(5)}&w=${Math.ceil(w / 160) * 160}${alpha}${bg}`);
    if (project() === p && scene() === s) {
      const url = URL.createObjectURL(blob);
      const img = $('#preview');
      await new Promise((res) => { img.onload = res; img.onerror = res; img.src = url; });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = url;
    }
  } catch (err) {
    $('#frame-msg').textContent = err.message;
  } finally {
    previewBusy = false;
    if (previewAgain) requestPreview();
  }
}

// ---------- actions ----------
function setSettings(patch, keepPreset = false) {
  state.settings = { ...state.settings, ...patch, motionBlur: { ...state.settings.motionBlur, ...(patch.motionBlur || {}) } };
  if (!keepPreset) state.presetId = matchPreset();
  renderPresets(); renderFields(); renderScenes(); renderRuler();
  if ('transparent' in patch || 'format' in patch || 'background' in patch) renderViewer();
  savePrefs();
}

function matchPreset() {
  const s = state.settings;
  const hit = state.status.presets.find((pr) => Object.entries(pr.settings).every(([k, v]) => (s[k] ?? null) === v) && !s.width);
  return hit ? hit.id : null;
}

function applyPreset(id) {
  const pr = state.status.presets.find((x) => x.id === id);
  state.presetId = id;
  setSettings({ ...pr.settings, width: null }, true);
}

let saveTimer = null;
function savePrefs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { rateInfo, ...settings } = state.settings;
    api('/api/prefs', { method: 'PUT', body: { settings } }).catch(() => {});
  }, 400);
}

function outDirFor(p) {
  if (state.outDirs[p.id]) return state.outDirs[p.id];
  const root = (state.status.prefs && state.status.prefs.outRoot) || state.status.outRoot;
  return `${root}/${p.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Untitled'}`;
}

function addProject(p) {
  const fresh = !state.projects.has(p.id);
  // A new version of an open project keeps its folder and in/out points.
  if (fresh) {
    const names = new Set(p.scenes.map((s) => s.name));
    for (const id of state.order) {
      const old = state.projects.get(id);
      const overlap = old.scenes.filter((s) => names.has(s.name)).length;
      if (overlap && overlap >= Math.min(names.size, old.scenes.length) / 2 && id !== p.id) {
        state.outDirs[p.id] = outDirFor(old);
        state.carried[p.id] = old.name;
        for (const s of old.scenes) {
          const r = state.ranges[rangeKey(old, s)];
          if (r && names.has(s.name)) state.ranges[`${p.name}/${s.name}`] = r;
          const twin = p.scenes.find((x) => x.name === s.name);
          if (twin && twin.selected !== s.selected && !twin.error) twin.selected = s.selected;
        }
        break;
      }
    }
    state.order.push(p.id);
  } else {
    // Keep the editor's ticks when the engine re-sends the project.
    const prev = state.projects.get(p.id);
    for (const s of p.scenes) { const o = prev.scenes.find((x) => x.id === s.id); if (o && !o.pending && !s.pending) s.selected = o.selected; }
  }
  state.projects.set(p.id, p);
  return fresh;
}

function selectProject(id) {
  state.projectId = id;
  const p = project();
  const first = p.scenes.find((s) => s.selected && !s.error) || p.scenes[0];
  state.sceneId = first ? first.id : null;
  state.frame = 0;
  renderAll();
}

function selectScene(id) {
  state.sceneId = id; state.frame = 0;
  const p = project(); const s = scene();
  if (s && usable(s)) { const r = rangeOf(p, s); if (r.set) state.frame = r.in; }
  renderScenes(); renderFields(); renderViewer();
}

async function closeProject(id) {
  state.projects.delete(id); state.order = state.order.filter((x) => x !== id);
  if (state.projectId === id) { state.projectId = state.order[state.order.length - 1] || null; state.sceneId = null; if (state.projectId) selectProject(state.projectId); }
  renderAll();
  api(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
}

async function openPath(path) {
  try {
    $('#frame-msg').textContent = '';
    const p = await api('/api/open', { method: 'POST', body: { path } });
    if (addProject(p) || state.projectId !== p.id) selectProject(p.id); else renderAll();
    refreshStatus();
  } catch (err) { toast(err.message); }
}

async function uploadFile(file) {
  try {
    toast(`Opening ${file.name}…`, 'info');
    const p = await api(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file });
    addProject(p); selectProject(p.id); $('#toast').hidden = true;
  } catch (err) { toast(err.message); }
}

async function openFromPicker() {
  if (host && host.pickFiles) { const paths = await host.pickFiles(); for (const p of paths || []) await openPath(p); return; }
  $('#file-input').click();
}

function markIn() { edit((r) => ({ in: state.frame, out: r.out != null && r.out < state.frame ? null : r.out })); }
function markOut() { edit((r) => ({ out: state.frame, in: r.in != null && r.in > state.frame ? null : r.in })); }
function clearMarks() { edit(() => ({ in: null, out: null })); }
function edit(fn) {
  const p = project(); const s = scene(); if (!p || !s || !usable(s)) return;
  const key = rangeKey(p, s); const next = fn(state.ranges[key] || {});
  if (next.in == null && next.out == null) delete state.ranges[key]; else state.ranges[key] = next;
  renderScenes(); renderRuler();
}

function stepToSection(dir) {
  const s = scene(); if (!s || !usable(s)) return;
  const r = rate();
  const points = [0, ...(s.info.scenes || []).map((x) => Math.round((x.start * r.n) / r.d)), framesOf(s) - 1];
  const next = dir > 0 ? points.find((f) => f > state.frame) : [...points].reverse().find((f) => f < state.frame);
  if (next != null) seek(next);
}

async function startRender() {
  const p = project(); if (!p) return;
  const items = p.scenes.filter((s) => s.selected && usable(s)).map((s) => {
    const r = rangeOf(p, s);
    return { projectId: p.id, sceneId: s.id, inFrame: r.set ? r.in : undefined, outFrame: r.set ? r.out : undefined };
  });
  const { rateInfo, ...settings } = state.settings;
  try {
    $('#render-btn').disabled = true;
    await api('/api/render', { method: 'POST', body: { items, settings, outDir: outDirFor(p), name: p.name } });
  } catch (err) { toast(err.message); } finally { renderGo(); }
}

async function installChrome() {
  try { await api('/api/setup/chrome', { method: 'POST' }); state.status.setup = { running: true, log: [] }; renderTools(); } catch (err) { toast(err.message); }
}

async function refreshStatus() {
  try {
    const s = await api('/api/status');
    const first = !state.status;
    state.status = s;
    if (first) {
      state.settings = { ...s.defaults, ...(s.prefs && s.prefs.settings) };
      state.presetId = null;
      for (const [k, v] of Object.entries(s.formats)) $('#f-format').append(el('option', { value: k, text: v.label }));
      for (const r of s.rates) $('#f-rate').append(el('option', { value: r, text: `${r} fps` }));
      state.presetId = matchPreset();
      renderPresets(); renderFields();
    }
    renderTools(); renderRecent(); renderGo();
  } catch (err) { toast(`Can't reach the engine: ${err.message}`); }
}

function aeNotes(r) {
  const out = [];
  for (const x of r.rasterised || []) out.push(`${x.name}: ${x.reason}`);
  for (const a of r.approximations || []) out.push(`${a.name}: ${a.note}`);
  for (const d of (r.decisions || []).filter((x) => !x.accepted)) out.push(`${d.summary} (${d.layers.join(', ')}): kept ${d.keeps}. Tick Exact gradients for ${d.gains}.`);
  for (const f of (r.fonts || []).filter((x) => x.note)) out.push(`${f.family || f.name}: ${f.note}`);
  if ((r.fonts || []).some((x) => x.file)) out.push('Fonts the scene uses are in the fonts folder beside the script. Install any you do not have before running it.');
  if (r.withinTolerance === false) out.push(`Worst position error ${r.worstPositionError.toFixed(2)} px.`);
  if (r.truncated) out.push('Only the first two minutes were converted.');
  return out;
}

async function openInAE(file) {
  try { await api('/api/ae/open', { method: 'POST', body: { path: file } }); toast('Sent to After Effects.'); } catch (err) { toast(err.message); }
}

async function reveal(path, open = false) {
  try { if (host && host.reveal) await host.reveal(path, open); else await api('/api/reveal', { method: 'POST', body: { path, open } }); } catch (err) { toast(err.message); }
}

// ---------- queue ----------
function jobState(j) {
  const pr = j.progress || {};
  if (j.status === 'queued') return { text: 'Waiting', pct: 0 };
  if (j.status === 'rendering') {
    const label = PHASE[pr.phase] || 'Working';
    const pct = pr.total ? pr.done / pr.total : 0;
    const counted = pr.total && pr.phase !== 'splicing' ? ` ${pr.done} of ${pr.total}` : '';
    return { text: `${label}${counted}`, pct: pr.phase === 'checking' ? pct * 0.15 : pct };
  }
  if (j.status === 'done') {
    const r = j.result || {};
    if (r.upToDate) return { text: 'Already up to date', pct: 1 };
    const t = `Done in ${dur(r.seconds || 0)}`;
    if (r.format === 'ae') {
      const tiers = r.tiers || {};
      const parts = [`${r.layers} layers`];
      if (tiers.B) parts.push(`${tiers.B} fitted`);
      if (tiers.C) parts.push(`${tiers.C} rendered as footage`);
      return { text: `${t}. ${parts.join(', ')}.`, pct: 1 };
    }
    return { text: r.reused ? `${t}. ${r.rendered} frames re-rendered, ${r.reused} reused.` : `${t}. ${r.frames} frames.`, pct: 1 };
  }
  if (j.status === 'cancelled') return { text: 'Cancelled', pct: 0 };
  return { text: j.error || 'Failed', pct: 1 };
}

function renderQueue() {
  const list = $('#queue-list'); list.replaceChildren();
  const empty = !state.batchOrder.some((bid) => state.batches.get(bid).jobs.some((id) => state.jobs.has(id)));
  $('#app').classList.toggle('queue-empty', empty);
  $('#queue-empty').hidden = !empty;
  if (empty) return;
  for (const bid of [...state.batchOrder].reverse()) {
    const b = state.batches.get(bid); const jobs = b.jobs.map((id) => state.jobs.get(id)).filter(Boolean);
    if (!jobs.length) continue;
    const j0 = jobs[0];
    const fmt = state.status.formats[j0.format];
    const head = el('div', { class: 'batch-head' }, el('b', { text: b.name || j0.sceneName }), el('span', { text: `${fmt ? fmt.label : j0.format}, ${j0.rate} fps, ${j0.size.width} × ${j0.size.height}` }));
    if (b.xml) head.append(el('button', { class: 'link', type: 'button', onclick: () => reveal(b.xml) }, 'Show timeline XML'));
    if (b.xmlError) head.append(el('span', { text: `Timeline XML failed: ${b.xmlError}` }));
    const box = el('div', { class: 'batch' }, head);
    for (const j of jobs) {
      const st = jobState(j);
      const bar = el('div', { class: 'bar' }, el('i')); bar.firstChild.style.width = `${Math.round(st.pct * 100)}%`;
      const acts = el('div', { class: 'acts' });
      if (j.status === 'queued' || j.status === 'rendering') acts.append(el('button', { class: 'link', type: 'button', onclick: () => api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }) }, 'Cancel'));
      if (j.status === 'done' && j.result && j.result.format === 'ae') {
        acts.append(el('button', { class: 'link', type: 'button', onclick: () => reveal(j.result.file) }, 'Show in Finder'));
        if (state.status.platform === 'darwin') acts.append(el('button', { class: 'link', type: 'button', onclick: () => openInAE(j.result.file) }, 'Open in After Effects'));
      } else if (j.status === 'done' && j.result) {
        acts.append(el('button', { class: 'link', type: 'button', onclick: () => reveal(j.result.file) }, 'Show in Finder'));
        if (j.result.review) acts.append(el('button', { class: 'link', type: 'button', onclick: () => reveal(j.result.review, true) }, 'Play review'));
        else if (j.format === 'h264') acts.append(el('button', { class: 'link', type: 'button', onclick: () => reveal(j.result.file, true) }, 'Play'));
      }
      const range = j.inFrame > 0 || (j.result && j.result.inFrame > 0) ? `frames ${j.inFrame} to ${j.outFrame}` : '';
      box.append(el('div', { class: `job ${j.status}` },
        el('div', { class: 'name', title: j.result ? j.result.file : j.outDir }, j.sceneName, range ? el('small', { text: range }) : null),
        bar, el('div', { class: 'state', text: st.text }), acts));
      if (j.status === 'done' && j.result && j.result.format === 'ae') {
        const notes = aeNotes(j.result);
        if (notes.length) {
          box.lastChild.append(el('details', {}, el('summary', { text: `${notes.length} note${notes.length === 1 ? '' : 's'}` }), el('ul', {}, ...notes.map((n) => el('li', { text: n })))));
        }
      }
    }
    list.append(box);
  }
}

function trackJobs(jobs, batchId) {
  for (const j of jobs) state.jobs.set(j.id, j);
  if (!state.batches.has(batchId)) {
    const p = state.projects.get(jobs[0] && jobs[0].projectId);
    state.batches.set(batchId, { id: batchId, name: p ? p.name : '', jobs: jobs.map((j) => j.id) });
    state.batchOrder.push(batchId);
  }
}

// ---------- events ----------
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    if (e.type === 'hello') {
      for (const p of e.projects) addProject(p);
      const byBatch = {};
      for (const j of e.jobs) (byBatch[j.batchId] = byBatch[j.batchId] || []).push(j);
      for (const [bid, jobs] of Object.entries(byBatch)) trackJobs(jobs, bid);
      if (!state.projectId && state.order.length) selectProject(state.order[state.order.length - 1]); else renderAll();
    } else if (e.type === 'project') {
      if (addProject(e.project)) selectProject(e.project.id); else { renderTabs(); renderScenes(); }
    } else if (e.type === 'scene-analyzed') {
      const p = state.projects.get(e.projectId); if (!p) return;
      const i = p.scenes.findIndex((s) => s.id === e.scene.id);
      const keep = state.carried[p.id] && p.scenes[i] ? p.scenes[i].selected : null;
      if (i >= 0) p.scenes[i] = { ...e.scene, selected: keep != null && !e.scene.error ? keep : e.scene.selected };
      if (p.id === state.projectId) {
        if (!state.sceneId || (scene() && scene().id === e.scene.id)) { renderScenes(); renderFields(); renderViewer(); } else renderScenes();
        renderGo();
      }
    } else if (e.type === 'queued') {
      trackJobs(e.jobs, e.batchId); renderQueue();
    } else if (e.type === 'job') {
      state.jobs.set(e.job.id, e.job); renderQueue();
    } else if (e.type === 'progress') {
      const j = state.jobs.get(e.jobId); if (j) { j.progress = e.progress; renderQueue(); }
    } else if (e.type === 'batch') {
      const b = state.batches.get(e.batch.id);
      if (b) { b.xml = e.batch.xml; b.xmlError = e.batch.xmlError; }
      for (const j of e.batch.jobs) state.jobs.set(j.id, j);
      renderQueue();
      const failed = e.batch.jobs.filter((j) => j.status === 'error').length;
      if (host && host.notify) host.notify(failed ? `${failed} render${failed > 1 ? 's' : ''} failed` : 'Renders finished', b ? b.name : '');
    } else if (e.type === 'setup') {
      if (e.done) { state.status = { ...state.status, ...e.status, setup: { running: false, log: [], code: e.code } }; renderTools(); renderGo(); if (e.code) toast('The Chromium download failed. Check your connection and try again.'); }
      else { const log = $('#setup-log'); if (log) log.textContent = e.line; }
    }
  };
  es.onerror = () => { /* EventSource reconnects on its own */ };
}

function renderAll() { renderTabs(); renderScenes(); renderFields(); renderViewer(); renderQueue(); renderRecent(); }

// ---------- wiring ----------
function wire() {
  $('#drop-open').addEventListener('click', openFromPicker);
  $('#open-btn').addEventListener('click', openFromPicker);
  $('#file-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) uploadFile(f); e.target.value = ''; });
  $('#render-btn').addEventListener('click', startRender);
  $('#clear-done').addEventListener('click', () => {
    state.batchOrder = state.batchOrder.filter((bid) => state.batches.get(bid).jobs.some((id) => { const j = state.jobs.get(id); return j && (j.status === 'queued' || j.status === 'rendering'); }));
    renderQueue();
  });
  $('#pick-folder').addEventListener('click', async () => {
    const p = project(); if (!p || !host) return;
    const dir = await host.pickFolder(outDirFor(p)); if (dir) { state.outDirs[p.id] = dir; renderFields(); }
  });
  $('#f-outdir').addEventListener('change', (e) => { const p = project(); if (p) { state.outDirs[p.id] = e.target.value.trim() || undefined; renderFields(); } });
  $('#f-format').addEventListener('change', (e) => setSettings({ format: e.target.value }));
  $('#f-ae-gradients').addEventListener('change', (e) => setSettings({ aeFallbacks: e.target.checked ? ['gradients'] : [] }));
  for (const b of document.querySelectorAll('#f-bg button')) b.addEventListener('click', () => setBackground({ mode: b.dataset.bg }));
  $('#f-bg-color').addEventListener('input', (e) => setBackground({ color: e.target.value }));
  $('#f-bg-hex').addEventListener('change', (e) => { const v = e.target.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) setBackground({ color: v.startsWith('#') ? v : `#${v}` }); else renderBackground(); });
  $('#f-bg-from').addEventListener('input', (e) => setBackground({ gradient: { from: e.target.value } }));
  $('#f-bg-to').addEventListener('input', (e) => setBackground({ gradient: { to: e.target.value } }));
  $('#f-bg-kind').addEventListener('change', (e) => setBackground({ gradient: { kind: e.target.value } }));
  $('#f-bg-angle').addEventListener('change', (e) => setBackground({ gradient: { angle: Number(e.target.value) || 0 } }));
  $('#f-bg-image').addEventListener('change', (e) => setBackground({ image: e.target.value.trim() || null }));
  $('#f-bg-replace').addEventListener('change', (e) => setBackground({ replace: e.target.checked }));
  $('#pick-bg-image').addEventListener('click', async () => { const f = await host.pickImage(); if (f) setBackground({ mode: 'image', image: f }); });
  $('#f-rate').addEventListener('change', (e) => { const s = scene(); const t = s && usable(s) ? secondsAt(state.frame) : 0; setSettings({ rate: e.target.value }); if (s && usable(s)) seek(Math.round((t * rate().n) / rate().d)); });
  for (const b of document.querySelectorAll('#f-size button')) b.addEventListener('click', () => setSettings({ size: b.dataset.size, width: null }));
  $('#f-transparent').addEventListener('change', (e) => setSettings({ transparent: e.target.checked }));
  $('#f-blur').addEventListener('change', (e) => setSettings({ motionBlur: { enabled: e.target.checked } }));
  $('#f-shutter').addEventListener('change', (e) => setSettings({ motionBlur: { shutter: Math.max(1, Math.min(720, Number(e.target.value) || 180)) } }));
  $('#f-samples').addEventListener('change', (e) => setSettings({ motionBlur: { samples: Number(e.target.value) } }));
  $('#f-review').addEventListener('change', (e) => setSettings({ review: e.target.checked }));
  $('#f-xml').addEventListener('change', (e) => setSettings({ xml: e.target.checked }));
  $('#f-partial').addEventListener('change', (e) => setSettings({ partial: e.target.checked }));
  $('#fields').addEventListener('submit', (e) => e.preventDefault());

  for (const b of document.querySelectorAll('[data-act]')) {
    b.addEventListener('click', () => {
      const p = project(); const s = scene(); if (!s || !usable(s)) return;
      const r = rangeOf(p, s);
      ({ start: () => seek(r.in), end: () => seek(r.out), back: () => seek(state.frame - 1), fwd: () => seek(state.frame + 1), in: markIn, out: markOut, clear: clearMarks })[b.dataset.act]();
    });
  }

  const ruler = $('#ruler');
  ruler.addEventListener('pointerdown', (e) => {
    ruler.setPointerCapture(e.pointerId); seek(frameFromPointer(e));
    const move = (ev) => seek(frameFromPointer(ev));
    const up = () => { ruler.removeEventListener('pointermove', move); ruler.removeEventListener('pointerup', up); };
    ruler.addEventListener('pointermove', move); ruler.addEventListener('pointerup', up);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type="text"], input[type="number"], select')) return;
    const p = project(); const s = scene(); if (!s || !usable(s)) return;
    const r = rangeOf(p, s); const k = e.key;
    let handled = true;
    if (k === 'ArrowLeft') seek(state.frame - (e.shiftKey ? 10 : 1));
    else if (k === 'ArrowRight') seek(state.frame + (e.shiftKey ? 10 : 1));
    else if (k === 'ArrowUp') stepToSection(-1);
    else if (k === 'ArrowDown') stepToSection(1);
    else if (k === 'Home') seek(0);
    else if (k === 'End') seek(framesOf(s) - 1);
    else if ((k === 'i' || k === 'I') && e.shiftKey) seek(r.in);
    else if ((k === 'o' || k === 'O') && e.shiftKey) seek(r.out);
    else if (k === 'i' || k === 'I') markIn();
    else if (k === 'o' || k === 'O') markOut();
    else if ((k === 'x' || k === 'X' || e.code === 'KeyX') && e.altKey) clearMarks();
    else handled = false;
    if (handled) e.preventDefault();
  });

  // Drag and drop anywhere in the window.
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth += 1; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { depth -= 1; if (depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
    const files = [...e.dataTransfer.files];
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (!files.length && /^https?:\/\//.test(url)) { openPath(url.trim()); return; }
    for (const f of files) {
      const path = host && host.pathForFile ? host.pathForFile(f) : null;
      if (path) await openPath(path); else await uploadFile(f);
    }
  });

  new ResizeObserver(() => { fitFrame(); renderRuler(); }).observe($('#viewer'));
  if (host && host.platform === 'darwin') document.body.classList.add('mac-app');
  if (host && host.onOpenPath) host.onOpenPath((p) => openPath(p));
}

wire();
await refreshStatus();
connect();
renderAll();
