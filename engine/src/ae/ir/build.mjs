// Capture result -> intermediate representation.
//
// The IR is the contract between the two halves of this tool: everything that
// needs a browser happens before it, and everything that needs After Effects
// happens after it. It is plain JSON, so a comp can be diffed, regenerated, or
// hand-edited without rerunning a capture.
//
// It is also where the fidelity TIER is decided, per layer:
//   A  the transform is expressible in AE's model and the motion fitted inside
//      tolerance -- native, editable, sparse keyframes
//   B  the motion needed more keyframes than a designer would write by hand but
//      is still native (springs, physics, anything sampled)
//   C  the element cannot be represented as AE geometry at all (canvas, WebGL,
//      3D skew, a singular matrix) and must be rasterised
// The tier is never guessed: it comes from measured round-trip error.
import { analyzeNode, unwrapAngles } from '../analyze/layers.mjs';
import { buildPerspectiveComp } from './precomp.mjs';
import { clipsContent, clipGeometry, buildClipComp, roundedRectPath } from './clip.mjs';
import { fadesAsGroup, buildGroupComp, subtreeOverlaps } from './group.mjs';
import { detectStaggers } from './stagger.mjs';
import { Decisions } from './decisions.mjs';
import { applyClipPaths } from './clippath.mjs';
import { keyPathMorph } from './morph.mjs';
import { repeatAxes, tileParams, buildTileComp } from './tile.mjs';
import { collectSubtree } from './precomp.mjs';
import { detectLoops, windowFrames } from './loops.mjs';
import {
  collectImageUrls, resolveAsset, computeFit,
  parseBackgroundPosition, parseBackgroundSize,
} from '../ingest/assets.mjs';
import { buildScalarTrack, buildVectorTrack, TOLERANCE, evaluate } from './track.mjs';
import {
  parseColor, parseFilter, parseBoxShadow, parseRadius, parseDashArray,
  parseLineHeight, primaryFontFamily, blendModeToAe,
} from '../analyze/css.mjs';

// The fidelity gate, in PIXELS of worst-case corner displacement. Half a pixel
// is below the threshold of visibility at any realistic viewing size, and it is
// expressed in the same units as every other tolerance in this tool so the
// report reads consistently.
const PIXEL_ERROR_LIMIT = 0.5;
const SKEW_PIXEL_LIMIT = 0.5;

export function indexer(frames) {
  const cache = new Map();
  return (frame, id) => {
    let map = cache.get(frame);
    if (!map) {
      map = new Map(frame.elements.map((e) => [e.id, e]));
      cache.set(frame, map);
    }
    return map.get(id) || null;
  };
}

const series = (analysis, pick) => analysis.perFrame.map((p) => ({
  t: p.time,
  v: p.transform ? pick(p.transform, p.entry) : null,
}));

/** Carry the last known value across frames where the element was absent. */
function fillGaps(samples, fallback = 0) {
  let last = fallback;
  const out = samples.map((s) => {
    if (s.v === null || s.v === undefined || !Number.isFinite(s.v)) return { t: s.t, v: last };
    last = s.v;
    return s;
  });
  // Backfill the leading run with the first real value so a layer that appears
  // at frame 40 does not ramp in from zero.
  const firstReal = samples.find((s) => Number.isFinite(s.v));
  if (firstReal) {
    for (const s of out) {
      if (s.t >= firstReal.t) break;
      s.v = firstReal.v;
    }
  }
  return out;
}

export function buildIR(capture, options = {}) {
  const opts = {
    name: options.name || 'Design Import',
    collapseStaticContainers: options.collapseStaticContainers !== false,
    ...options,
  };
  const at = indexer(capture.frames);
  const [docW, docH] = capture.documentSize;
  const width = options.width || Math.round(docW) || 1200;
  const height = options.height || Math.round(docH) || 800;

  // Resolve every image the design referenced into real bytes, once, so a
  // sprite used by ten layers is imported as one piece of footage.
  const assets = [];
  const assetProblems = [];
  const assetByUrl = new Map();
  for (const url of collectImageUrls(capture)) {
    const resolved = resolveAsset(url, { assetFiles: capture.assetFiles, baseDir: options.baseDir });
    const size = (capture.imageSizes || {})[url] || [0, 0];
    if (!resolved) {
      // Buffered, not reported: `report` does not exist yet, and reaching for
      // it here throws before any design with a missing image can be imported.
      assetProblems.push({ name: 'image', note: `could not resolve image source: ${describeUrl(url)}` });
      continue;
    }
    const asset = {
      id: `img-${assets.length + 1}`,
      ext: resolved.ext,
      bytes: resolved.bytes,
      width: size[0],
      height: size[1],
      source: describeUrl(url),
    };
    assets.push(asset);
    assetByUrl.set(url, asset);
  }
  // A canvas becomes an image SEQUENCE: one asset, many frames. Where every
  // frame is byte-identical the canvas is static and a single still is enough.
  const sequenceByNode = new Map();
  for (const [nodeId, seq] of (capture.canvasSequences || new Map())) {
    if (!seq.files.length) continue;
    const isStatic = seq.distinct.size === 1 && seq.files.length > 1;
    const asset = {
      id: `canvas-${nodeId}`,
      kind: isStatic ? 'still' : 'sequence',
      ext: '.png',
      files: isStatic ? [seq.files[0]] : seq.files,
      frames: isStatic ? 1 : seq.files.length,
      width: seq.width,
      height: seq.height,
      source: `<canvas> ${seq.width}x${seq.height}, ${seq.files.length} frame(s)${isStatic ? ' (static)' : ''}`,
    };
    assets.push(asset);
    sequenceByNode.set(nodeId, asset);
  }
  // Gradients a person chose to have drawn exactly rather than approximated by
  // a two-stop ramp. The bitmap arrives already rendered at the element's own
  // size; here it just becomes another piece of footage.
  const gradientAssets = new Map();
  for (const [nodeId, bitmap] of (options.gradientBitmaps || new Map())) {
    const asset = {
      id: `grad-${nodeId}`,
      ext: '.png',
      bytes: bitmap.bytes,
      width: bitmap.width,
      height: bitmap.height,
      source: `gradient on node ${nodeId}, drawn at ${bitmap.width}x${bitmap.height}`,
    };
    assets.push(asset);
    gradientAssets.set(nodeId, asset);
  }

  opts.assetByUrl = assetByUrl;
  opts.sequenceByNode = sequenceByNode;
  opts.gradientAssets = gradientAssets;
  // Every trade of editability for fidelity is recorded here and put to a
  // person by the command line, rather than being made quietly.
  const decisions = options.decisions instanceof Decisions
    ? options.decisions : new Decisions(options.accepted || []);
  opts.decisions = decisions;

  // Looping animations are emitted as one cycle plus loopOut(); anything that
  // cannot be reduced to a single cycle is reported rather than half-looped.
  // Skips are BUFFERED rather than reported straight away: this runs before
  // `report` exists, and reaching for it here throws before any design that
  // actually has an unloopable animation can be imported at all.
  const loopSkips = [];
  opts.loops = detectLoops(capture.animationTimings, capture.duration, (skip) => {
    loopSkips.push(skip);
  });

  const roleById = new Map(capture.nodes.map((n) => [n.id, n.role]));
  opts.roleOf = (id) => roleById.get(id) ?? null;
  const analyses = capture.nodes.map((node) => analyzeNode(node, capture.frames, at, opts));
  const byId = new Map(analyses.map((a) => [a.node.id, a]));

  // A 3D element flattens its descendants into its own plane and the whole
  // plane is then projected -- that is what CSS does without preserve-3d. After
  // Effects will not do that for a 2D child of a 3D parent: it composites the
  // child against the parent's already-projected position, so a tilted panel's
  // contents slide by a few pixels. Putting the whole subtree into 3D space (at
  // z = 0, which is exactly what "flattened into the parent's plane" means) lets
  // the camera project the group as one, and reproduces the CSS result.
  const in3dContext = new Set();
  for (const a of analyses) {
    if (!a.everThreeD) continue;
    const stack = [a.node.id];
    while (stack.length) {
      const id = stack.pop();
      for (const child of analyses) {
        if (child.node.parentId === id && !in3dContext.has(child.node.id)) {
          in3dContext.add(child.node.id);
          stack.push(child.node.id);
        }
      }
    }
  }

  const layers = [];
  const usedNames = new Set();
  void assets;
  const report = {
    tiers: { A: 0, B: 0, C: 0 },
    rasterised: [],
    approximations: [],
    maxTrackError: 0,
    maxMatrixError: 0,
    maxPixelError: 0,
  };

  for (const problem of assetProblems) report.approximations.push(problem);
  for (const skip of loopSkips) {
    const node = capture.nodes.find((n) => n.id === skip.id);
    report.approximations.push({
      id: skip.id,
      name: node ? node.name : String(skip.id),
      note: `loop not emitted (${skip.reason}); keyframes cover the captured span only`,
    });
  }

  // Detected before the layer loop: whether the comp has a perspective camera
  // changes what each 3D layer has to report about its own accuracy.
  const camera = detectCamera(analyses, at, capture, report);
  opts.hasPerspective = Boolean(camera);

  for (const analysis of analyses) {
    if (!analysis.everPresent) continue;
    const { node } = analysis;
    const layer = buildLayer(analysis, byId, report, opts, in3dContext.has(analysis.node.id));
    if (layer) {
      const first = layer.__firstEntry;
      layer.name = layerName(analysis.node, first, usedNames);
      delete layer.__firstEntry;
      layers.push(layer);
      // A CSS background bitmap is a separate piece of artwork from the element
      // that carries it: the element still paints its own colour and border, and
      // the image sits on top, clipped to the padding box.
      const bg = buildBackgroundImageLayer(analysis, layer, first, opts, report);
      if (bg) {
        bg.name = layerName({ name: `${layer.name} · image`, tag: 'img' }, null, usedNames);
        layers.push(bg);
      }
    }
  }

  // The document root is the comp itself; drop the <body> layer's redundant
  // full-bleed rectangle but keep it as a parent if anything hangs off it.
  const comp = {
    id: 'root',
    camera,
    name: opts.name,
    width,
    height,
    fps: capture.fps,
    duration: capture.duration,
    backgroundColor: rootBackground(analyses, at, capture),
    layers,
  };

  // CSS propagates the body's background across the WHOLE canvas, even where the
  // body itself does not reach. After Effects' composition background colour
  // cannot stand in for that: it is a viewing aid and renders as transparent in
  // any output with an alpha channel, so a design whose page colour comes from
  // the body would export with holes in it. Paint it as a real layer instead --
  // but only when nothing already covers the frame, so an artboard whose own
  // root is full-bleed does not gain a second, invisible background.
  const bg = comp.backgroundColor;
  const alreadyCovered = comp.layers.some((l) => {
    if (!l.shape || !l.shape.size) return false;
    const size = l.shape.size.static || (l.shape.size.keys || [{}])[0].v;
    const fill = l.shape.fill;
    const opaque = fill && (!fill.opacity || (fill.opacity.static ?? 100) > 99.5);
    return Boolean(size) && opaque && size[0] >= width - 0.5 && size[1] >= height - 0.5;
  });
  if (bg && bg.declared && bg.a > 0 && !alreadyCovered) {
    comp.layers.unshift({
      id: 'page-background',
      name: 'page background',
      parentId: null,
      kind: 'shape',
      tier: 'A',
      role: 'page-background',
      threeD: false,
      inPoint: 0,
      outPoint: capture.duration,
      transform: {
        anchorPoint: { static: [0, 0] },
        position: { static: [0, 0] },
        scale: { static: [100, 100] },
        opacity: { static: 100 },
        rotation: { static: 0 },
      },
      shape: {
        size: { static: [width, height] },
        roundness: { static: 0 },
        fill: { color: { static: bg.rgb }, opacity: { static: bg.a * 100 } },
        stroke: null,
        gradient: null,
        shadows: [],
      },
      mask: null,
      blendMode: null,
      effects: [],
    });
    report.pageBackground = { rgb: bg.rgb, reason: 'body background propagates to the canvas' };
  }

  const comps = [comp];

  // --- staggered text runs ---------------------------------------------------
  // Before anything else reshapes the layer tree, because collapsing a run
  // REMOVES layers, and a clip or a fade gathered around them first would
  // gather members that are about to stop existing.
  const frameTimes = capture.frames.map((f) => f.time);
  for (const run of detectStaggers(analyses, {})) {
    const ids = run.members.map((m) => m.id);
    const picked = ids.map((id) => comp.layers.find((l) => l.id === id));
    // Every member has to be a plain text layer in this comp: a member that
    // was rasterised, or carries its own effects, is not something one
    // animator can stand in for.
    if (picked.some((l) => !l || l.kind !== 'text' || l.tier !== 'A'
      || (l.effects && l.effects.length) || l.mask)) continue;

    const keep = picked[0];
    // The run's motion moves to the animator, so the layer is parked at the end
    // the animator does NOT hold: the settled state for an entrance, the
    // starting state for an exit (see the reasoning in stagger.mjs).
    const parkTime = run.exit ? frameTimes[0] : frameTimes[frameTimes.length - 1];
    for (const prop of ['position', 'scale', 'rotation', 'orientation', 'opacity', 'anchorPoint']) {
      const track = keep.transform[prop];
      if (track && track.keys) keep.transform[prop] = { static: evaluate(track, parkTime) };
    }
    if (keep.absolute && keep.absolute.keys) keep.absolute = { static: evaluate(keep.absolute, parkTime) };
    // The layer now stands for the WHOLE run, so it has to be on screen for as
    // long as any member was. Inheriting member one's span cuts an exit off
    // when the first word finishes, before the later ones have moved.
    keep.inPoint = Math.min(...picked.map((l) => l.inPoint));
    keep.outPoint = Math.max(...picked.map((l) => l.outPoint));

    keep.text.value = run.text;
    keep.text.changes = false;
    keep.name = layerName({ name: run.text.slice(0, 28), tag: 'span' }, null, usedNames);
    keep.stagger = {
      from: run.from,
      stagger: run.stagger,
      members: run.members.map((m) => ({
        text: m.text, charStart: m.charStart, charEnd: m.charEnd,
        amount: m.amount, style: m.style,
      })),
    };
    const dropped = new Set(ids.slice(1));
    comp.layers = comp.layers.filter((l) => !dropped.has(l.id));
    // Anything parented to a dropped member re-parents to the survivor, which
    // now occupies the same place in the design.
    for (const l of comp.layers) if (dropped.has(l.parentId)) l.parentId = keep.id;

    (report.staggers || (report.staggers = [])).push({
      text: run.text,
      words: run.members.length,
      stagger: run.stagger,
      residual: run.residual,
      styled: run.members.filter((m, i) => i > 0 && m.style
        && (m.style.color !== run.members[0].style.color
          || m.style.italic !== run.members[0].style.italic)).length,
    });
  }

  // --- repeating backgrounds -------------------------------------------------
  // Before clipping, so a tiled background that also sits inside an
  // overflow:hidden element is already one layer by the time the clip comp
  // gathers it.
  let tileIndex = 0;
  for (const bgLayer of comp.layers.slice()) {
    if (!bgLayer.tile || !bgLayer.tileBox) continue;
    tileIndex += 1;
    const built = buildTileComp(bgLayer, {
      ...bgLayer.tileBox,
      fps: capture.fps,
      duration: capture.duration,
      index: tileIndex,
    });
    if (!built) continue;
    delete built.comp.layers[0].tileBox;
    const at = comp.layers.findIndex((l) => l.id === bgLayer.id);
    comp.layers[at] = built.layer;
    comps.push(built.comp);
    (report.tiled || (report.tiled = [])).push({
      name: bgLayer.name,
      size: [built.comp.width, built.comp.height],
      output: [bgLayer.tile.outputWidth, bgLayer.tile.outputHeight],
    });
  }

  // --- overflow clipping -----------------------------------------------------
  // Deepest first, so a nested clipper's own contents are already gathered
  // before an ancestor gathers the subtree containing it.
  const clippers = analyses
    .filter((a) => {
      const entry = at(capture.frames[0], a.node.id);
      return entry && entry.present && clipsContent(entry.style);
    })
    .sort((x, y) => y.node.depth - x.node.depth);

  for (const analysis of clippers) {
    const layer = comp.layers.find((l) => l.id === analysis.node.id);
    if (!layer) continue;
    const entry = at(capture.frames[0], analysis.node.id);
    const built = buildClipComp(comp, layer, clipGeometry(entry));
    if (!built) continue;
    const insideIds = new Set(built.comp.layers.map((l) => l.id));
    comp.layers = comp.layers.filter((l) => !insideIds.has(l.id));
    // Contents paint after the element's own background, so the clip layer goes
    // immediately after the clipper in the (bottom-first) layer order.
    const index = comp.layers.findIndex((l) => l.id === analysis.node.id);
    comp.layers.splice(index + 1, 0, built.layer);
    comps.unshift(built.comp);
    // Every comp that rebases coordinates records its shift, so verification
    // compares like with like instead of blaming the importer for the offset it
    // was told to apply.
    (report.compShifts || (report.compShifts = {}))[built.comp.id] = built.shift;
    // A clip comp holds its contents in the clipper's UNTRANSFORMED box space:
    // the wrapper is parented to the clipper, so the clipper's own transform --
    // and everything above it -- is applied outside the comp. Verification has
    // to stop composing there or it counts those transforms twice.
    (report.compBoundaries || (report.compBoundaries = {}))[built.comp.id] = analysis.node.id;
    (report.clipped || (report.clipped = [])).push({
      compId: built.comp.id,
      name: layer.name,
      size: built.size,
      layersClipped: built.lifted,
      rounded: Boolean(built.layer.mask),
    });
  }

  // --- group opacity --------------------------------------------------------
  // After clipping, because CSS clips first and fades the clipped result: the
  // fade wrapper has to CONTAIN the clip comp, not the other way round.
  // Deepest first again, so a nested fade is composited before an outer one
  // gathers it.
  // Which elements paint something of their own -- needed by the overlap test,
  // because an element's own background is one of the parts being composited.
  const analysisById = new Map(analyses.map((a) => [a.node.id, a]));

  const perFramePaints = new Set(
    analyses.filter((a) => a.perFrame.some((p) => paintsContent(p.entry, a.node.role)))
      .map((a) => a.node.id),
  );

  const faders = analyses
    .slice()
    .sort((x, y) => y.node.depth - x.node.depth);

  for (const analysis of faders) {
    const host = comps.find((c) => c.layers.some((l) => l.id === analysis.node.id));
    if (!host) continue;
    const layer = host.layers.find((l) => l.id === analysis.node.id);
    if (!layer || !fadesAsGroup(layer.transform.opacity)) continue;

    let parentOffset = [0, 0];
    if (layer.absolute) {
      const abs = evaluate(layer.absolute, 0) || [0, 0];
      const rel = evaluate(layer.transform.position, 0) || [0, 0];
      parentOffset = [abs[0] - rel[0], abs[1] - rel[1]];
    }
    // Only composite when the parts can actually cover each other. Where they
    // cannot, fading the group and fading its parts are the same picture, so
    // the opacity is baked down instead and no composition is spent.
    const ids = collectSubtree(host.layers, layer.id);
    // An element with no descendants fades correctly on its own: there is no
    // group, nothing to composite and nothing to bake.
    if (ids.size <= 1) continue;
    // A synthetic layer -- a clip or fade comp standing in for a subtree -- has
    // no analysis behind it, so the overlap test cannot see its geometry.
    // Assume the worst rather than guess: an unseen overlap is a wrong picture.
    const opaqueToTest = [...ids].some((id) => id !== layer.id && !analysisById.has(id));
    if (!opaqueToTest
      && !subtreeOverlaps(analyses, ids, host.duration, host.fps, (id) => perFramePaints.has(id))) {
      bakeGroupOpacity(host, layer, ids, frameTimes);
      (report.bakedGroups || (report.bakedGroups = [])).push({
        name: layer.name,
        layers: ids.size - 1,
      });
      continue;
    }

    const built = buildGroupComp(host, layer, { parentOffset });
    if (!built) continue;

    const insideIds = new Set(built.comp.layers.map((l) => l.id));
    const index = host.layers.findIndex((l) => l.id === analysis.node.id);
    host.layers = host.layers.filter((l) => !insideIds.has(l.id));
    host.layers.splice(Math.max(0, index), 0, built.layer);
    comps.unshift(built.comp);
    (report.compShifts || (report.compShifts = {}))[built.comp.id] = built.shift;
    (report.grouped || (report.grouped = [])).push({
      compId: built.comp.id,
      name: layer.name,
      size: built.size,
      layersGrouped: built.lifted,
    });
  }

  if (camera) {
    // Clipping may already have moved the perspective container into a clip
    // comp, so look for it wherever it ended up.
    const host = comps.find((c) => c.layers.some((l) => l.id === camera.id)) || comp;
    const containerLayer = host.layers.find((l) => l.id === camera.id);
    // A layer's position is parent-relative; the precomp layer replacing this
    // subtree needs the same frame of reference, so recover the parent's box
    // origin from the difference between the absolute and relative tracks.
    let parentOffset = [0, 0];
    if (containerLayer) {
      const abs = evaluate(containerLayer.absolute, 0) || [0, 0];
      const rel = evaluate(containerLayer.transform.position, 0) || [0, 0];
      parentOffset = [abs[0] - rel[0], abs[1] - rel[1]];
    }
    const lifted = buildPerspectiveComp(host, camera, { parentOffset });
    if (lifted) {
      const insideIds = new Set(lifted.comp.layers.map((l) => l.id));
      const index = host.layers.findIndex((l) => l.id === camera.id);
      host.layers = host.layers.filter((l) => !insideIds.has(l.id));
      host.layers.splice(Math.max(0, index), 0, lifted.layer);
      // The camera now lives in the precomp, where its centre is the CSS
      // perspective origin. The host comp no longer needs one.
      host.camera = null;
      comps.unshift(lifted.comp);
      (report.compShifts || (report.compShifts = {}))[lifted.comp.id] = lifted.shift;
      report.perspective = {
        compId: lifted.comp.id,
        shift: lifted.shift,
        size: lifted.size,
        origin: camera.point,
        layersLifted: insideIds.size,
        note: 'perspective subtree moved into its own comp so AE\u2019s vanishing point matches CSS perspective-origin',
      };
    }
  }
  // --- clip-path ------------------------------------------------------------
  // Last, once every layer is in the comp it will finally live in: a mask's
  // expression finds its clipping layer by name in its own comp.
  applyClipPaths({ comps, analyses, frames: capture.frames, at, report });

  for (const c of comps) {
    for (const l of c.layers) { delete l.absolute; delete l.boxSize; delete l.boxOrigin; }
  }

  // Compositions must be emitted in dependency order, and unshifting each new
  // one as it is created does not give that: a fade comp created after a clip
  // comp can CONTAIN it, and would then be built first and find nothing to
  // place. Sort properly instead of relying on creation order.
  const ordered = topoSortComps(comps);

  return {
    version: 1,
    meta: {
      generator: 'design-to-ae',
      fps: capture.fps,
      duration: capture.duration,
      frameCount: capture.frames.length,
      truncated: Boolean(capture.truncated),
      detected: capture.detected,
      capturedAt: options.capturedAt || null,
    },
    rootCompId: 'root',
    // Every editability-for-fidelity trade this build could have made, whether
    // taken or not, so the command line can put the untaken ones to a person.
    decisions: decisions.grouped(),
    assets,
    comps: ordered,
    fonts: collectFonts(analyses, at, capture),
    report: {
      ...report,
      captureWarnings: capture.warnings,
      consoleErrors: capture.consoleErrors,
    },
  };
}

/**
 * CSS `perspective` on a container and an After Effects camera describe the
 * same projection with different vocabulary: a viewer sitting `d` pixels in
 * front of the z=0 plane, looking at `perspective-origin`. An AE camera with
 * zoom = d, positioned at the origin point and offset -d in z, reproduces it
 * exactly. Without one, AE renders 3D layers through its default camera and a
 * rotated panel lands tens of pixels away from where the browser put it.
 *
 * CSS scopes perspective per container; AE has one camera per comp. With more
 * than one perspective container the extras need their own precomps, so we take
 * the first and say so rather than silently picking.
 */
function detectCamera(analyses, at, capture, report) {
  const containers = [];
  // An element whose OWN transform uses perspective() needs the same camera as
  // a `perspective:` container -- the projection is identical, only the spelling
  // differs, and real Claude Design output uses both.
  for (const a of analyses) {
    const own = a.perFrame.find((p) => p.transform && p.transform.ownPerspective);
    if (!own) continue;
    containers.push({
      id: a.node.id,
      name: a.node.name,
      distance: own.transform.ownPerspective,
      point: own.transform.perspectivePoint,
      viaTransformFunction: true,
    });
  }
  for (const a of analyses) {
    const entry = at(capture.frames[0], a.node.id);
    if (!entry || !entry.present) continue;
    const value = entry.style.perspective;
    if (!value || value === 'none') continue;
    const distance = parseFloat(value);
    if (!Number.isFinite(distance) || distance <= 0) continue;
    const origin = String(entry.style.perspectiveOrigin || '50% 50%').split(/\s+/).map(parseFloat);
    containers.push({
      id: a.node.id,
      name: a.node.name,
      distance,
      // perspective-origin is relative to the container's own border box.
      point: [entry.box[0] + (origin[0] || 0), entry.box[1] + (origin[1] || 0)],
    });
  }
  if (!containers.length) return null;
  if (containers.length > 1) {
    report.approximations.push({
      id: containers[1].id,
      name: containers[1].name,
      note: `${containers.length} CSS perspective containers, but a comp has one camera; using ${containers[0].name}`,
    });
  }
  return containers[0];
}

/**
 * The bitmap behind an element that uses `background-image: url(...)`.
 *
 * It becomes its own layer parented to the element, fitted per background-size
 * and background-position, and masked to the padding box -- which is both where
 * CSS paints a background by default (background-origin: padding-box) and where
 * it clips it.
 */
function buildBackgroundImageLayer(analysis, parentLayer, firstEntry, opts, report) {
  if (!firstEntry || !firstEntry.present) return null;
  const css = firstEntry.style.backgroundImage;
  if (!css || css === 'none') return null;
  // A background can carry BOTH a bitmap and a gradient. `isGradient` only asks
  // whether one is present anywhere in the value, so testing it first threw the
  // url() away silently -- the picture simply did not arrive. The bitmap wins
  // the layer; the gradient is still painted by the element's own shape.
  const match = /url\((['"]?)(.*?)\1\)/.exec(css);
  if (!match) {
    return isGradient(css) ? buildGradientBitmapLayer(analysis, parentLayer, firstEntry, opts) : null;
  }
  const asset = opts.assetByUrl && opts.assetByUrl.get(match[2]);
  if (!asset || !asset.width) {
    report.approximations.push({
      id: analysis.node.id, name: analysis.node.name,
      note: `background image could not be resolved: ${describeUrl(match[2])}`,
    });
    return null;
  }

  const s = firstEntry.style;
  const border = s.borderWidth || [0, 0, 0, 0];
  const boxW = firstEntry.box[2] - (border[1] || 0) - (border[3] || 0);
  const boxH = firstEntry.box[3] - (border[0] || 0) - (border[2] || 0);
  const sizing = parseBackgroundSize(s.backgroundSize);
  const fit = computeFit({
    naturalW: asset.width, naturalH: asset.height,
    boxW, boxH,
    mode: sizing.mode, sizeW: sizing.sizeW, sizeH: sizing.sizeH,
    position: parseBackgroundPosition(s.backgroundPosition),
  });

  // A repeating background is reproduced, not approximated: Motion Tile lays
  // down the same grid CSS does, anchored on the same first tile.
  const axes = repeatAxes(s.backgroundRepeat);
  const tileW = fit.scale[0] * asset.width;
  const tileH = fit.scale[1] * asset.height;
  const needsX = axes.x && tileW > 0.5 && tileW < boxW - 0.5;
  const needsY = axes.y && tileH > 0.5 && tileH < boxH - 0.5;
  const tile = needsX || needsY
    ? tileParams({
      offset: fit.offset,
      tile: [tileW, tileH],
      box: [boxW, boxH],
      axes: { x: needsX, y: needsY },
      natural: [asset.width, asset.height],
    })
    : null;

  const sx = fit.scale[0] || 1;
  const sy = fit.scale[1] || 1;
  const radii = (s.borderRadius || []).map((r) => Math.max(0, (parseFloat(r) || 0) - Math.max(border[0] || 0, border[3] || 0)));
  return {
    id: `${analysis.node.id}-bg`,
    name: `${analysis.node.name} image`,
    parentId: analysis.node.id,
    kind: 'image',
    tier: 'A',
    threeD: parentLayer.threeD,
    role: 'background-image',
    inPoint: parentLayer.inPoint,
    outPoint: parentLayer.outPoint,
    image: { assetId: asset.id, natural: [asset.width, asset.height], objectFit: sizing.mode },
    absolute: backgroundAbsolute(analysis, border[3] || 0, border[0] || 0),
    tile,
    // Kept so the tiling pass can size the composition it needs.
    tileBox: tile ? { boxW, boxH, radii, originX: border[3] || 0, originY: border[0] || 0 } : null,
    transform: {
      // Source pixels -> padding-box space, expressed the same way an <img>
      // layer is: scale carries the fit, the anchor is in source pixels.
      anchorPoint: { static: [-fit.offset[0] / sx, -fit.offset[1] / sy] },
      position: { static: [border[3] || 0, border[0] || 0] },
      scale: { static: [sx * 100, sy * 100] },
      opacity: { static: 100 },
      rotation: { static: 0 },
    },
    mask: roundedRectInSource(-fit.offset[0] / sx, -fit.offset[1] / sy, boxW / sx, boxH / sy, radii, sx, sy),
    blendMode: null,
    effects: [],
  };
}

/**
 * A gradient drawn exactly, as a picture over the element's padding box.
 *
 * Only reached once the choice has been accepted AND the bitmap rendered, so
 * the absence of one simply means the ramp is still doing the job.
 */
function buildGradientBitmapLayer(analysis, parentLayer, firstEntry, opts) {
  const asset = opts.gradientAssets && opts.gradientAssets.get(analysis.node.id);
  if (!asset) return null;
  const s = firstEntry.style;
  const border = s.borderWidth || [0, 0, 0, 0];
  const boxW = firstEntry.box[2] - (border[1] || 0) - (border[3] || 0);
  const boxH = firstEntry.box[3] - (border[0] || 0) - (border[2] || 0);
  // The bitmap was drawn at the padding box's own size, so the fit is a
  // straight stretch of source pixels back onto it.
  const sx = boxW / asset.width;
  const sy = boxH / asset.height;
  const radii = (s.borderRadius || [])
    .map((r) => Math.max(0, (parseFloat(r) || 0) - Math.max(border[0] || 0, border[3] || 0)));
  return {
    id: `${analysis.node.id}-grad`,
    name: `${analysis.node.name} gradient`,
    parentId: analysis.node.id,
    kind: 'image',
    tier: 'A',
    threeD: parentLayer.threeD,
    role: 'gradient-bitmap',
    inPoint: parentLayer.inPoint,
    outPoint: parentLayer.outPoint,
    image: { assetId: asset.id, natural: [asset.width, asset.height], objectFit: 'fill' },
    absolute: backgroundAbsolute(analysis, border[3] || 0, border[0] || 0),
    transform: {
      anchorPoint: { static: [0, 0] },
      position: { static: [border[3] || 0, border[0] || 0] },
      scale: { static: [sx * 100, sy * 100] },
      opacity: { static: 100 },
      rotation: { static: 0 },
    },
    mask: roundedRectInSource(0, 0, boxW / sx, boxH / sy, radii, sx, sy),
    blendMode: null,
    effects: [],
  };
}

/**
 * The page-space position a background layer's own origin sits at.
 *
 * Synthetic layers are parented to the element they belong to and positioned
 * relative to it, which is right until a pass severs that parent -- the clip
 * comp rebases a clipper's direct children, and `layer.absolute ||
 * layer.transform.position` then reads a PARENT-RELATIVE position as an
 * absolute one. The background silently jumps by the element's own page
 * position, and nothing catches it: a synthetic layer has no capture entry, so
 * verification skips it entirely.
 */
function backgroundAbsolute(analysis, offsetX, offsetY) {
  const channels = [offsetX, offsetY].map((off, k) => fillGaps(analysis.perFrame.map((p) => ({
    t: p.time,
    // The element's box origin in page space is its anchor position less the
    // anchor's offset within the box.
    v: p.transform
      ? p.transform.absolutePosition[k] - p.transform.anchorPoint[k] + off
      : null,
  }))));
  return buildVectorTrack(channels, 'position');
}

/** The padding box as a mask path in a layer's source pixels. */
function roundedRectInSource(x, y, w, h, radii, sx, sy) {
  if (!radii.some((r) => r > 0.01)) {
    const v = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    return { vertices: v, inTangents: v.map(() => [0, 0]), outTangents: v.map(() => [0, 0]), closed: true };
  }
  const path = roundedRectPath(w, h, radii.map((r, i) => r / (i % 2 === 0 ? sx : sy)));
  return {
    vertices: path.vertices.map(([px, py]) => [px + x, py + y]),
    inTangents: path.inTangents,
    outTangents: path.outTangents,
    closed: true,
  };
}

/**
 * Order compositions so every one is built after the comps it places. A cycle
 * is impossible by construction (a subtree is only ever lifted downward), but
 * the traversal guards against one anyway rather than looping.
 */
function topoSortComps(comps) {
  const byId = new Map(comps.map((c) => [c.id, c]));
  const out = [];
  const state = new Map();
  const visit = (comp) => {
    if (!comp || state.get(comp.id) === 'done') return;
    if (state.get(comp.id) === 'visiting') return;
    state.set(comp.id, 'visiting');
    for (const layer of comp.layers) {
      if (layer.kind === 'precomp' && layer.compId) visit(byId.get(layer.compId));
    }
    state.set(comp.id, 'done');
    out.push(comp);
  };
  for (const comp of comps) visit(comp);
  return out;
}

/** An axis-aligned rectangle as a mask path, in a layer's source pixels. */
function rectPathInSource(x, y, w, h) {
  const v = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  return { vertices: v, inTangents: v.map(() => [0, 0]), outTangents: v.map(() => [0, 0]), closed: true };
}

/** A short, readable stand-in for a data URI in reports. */
function describeUrl(url) {
  if (!url) return '(none)';
  if (url.startsWith('data:')) {
    const mime = /^data:([^;,]+)/.exec(url);
    return `inline ${mime ? mime[1] : 'data'} (${Math.round(url.length / 1024)}KB)`;
  }
  return url.length > 90 ? `${url.slice(0, 87)}...` : url;
}

/**
 * The composition's background colour, and whether the page actually declared
 * one.
 *
 * The black fallback is right for After Effects' comp background, which is a
 * VIEWING aid -- but it must not be mistaken for a background the design asked
 * for. An artboard whose body is rgba(0,0,0,0) is meant to be transparent, and
 * painting the fallback behind it would export a black card.
 */
function rootBackground(analyses, at, capture) {
  const body = analyses.find((a) => a.node.tag === 'body');
  const entry = body ? at(capture.frames[0], body.node.id) : null;
  const color = entry ? parseColor(entry.style.backgroundColor) : null;
  if (color && color.a > 0) return { rgb: color.rgb, a: color.a, declared: true };
  return { rgb: [0, 0, 0], a: 1, declared: false };
}

function collectFonts(analyses, at, capture) {
  const fonts = new Map();
  for (const a of analyses) {
    if (a.node.role !== 'text') continue;
    const entry = at(capture.frames[0], a.node.id);
    if (!entry || !entry.present) continue;
    const family = primaryFontFamily(entry.style.fontFamily);
    if (!family) continue;
    const key = `${family}|${entry.style.fontWeight}|${entry.style.fontStyle}`;
    if (!fonts.has(key)) {
      fonts.set(key, { family, weight: entry.style.fontWeight, style: entry.style.fontStyle });
    }
  }
  return [...fonts.values()];
}

/**
 * A name a motion designer can navigate by. The DOM rarely offers one -- most
 * elements are an anonymous <div> -- so fall back through the things that carry
 * meaning: an id, a data-name, a class, the element's own text, and finally the
 * tag with a disambiguating index.
 */
function layerName(node, firstEntry, used) {
  let base = node.name;
  const isBareTag = base === node.tag;
  if (isBareTag && firstEntry) {
    const text = (firstEntry.text || '').trim().replace(/\s+/g, ' ');
    if (text) base = text.length > 28 ? `${text.slice(0, 27)}\u2026` : text;
    else if (node.role === 'svgShape') base = node.tag;
  }
  if (isBareTag && base === node.tag) base = node.tag;
  let name = base;
  let n = 2;
  while (used.has(name)) { name = `${base} ${n}`; n += 1; }
  used.add(name);
  return name;
}

/**
 * Fold a group's opacity down into its descendants.
 *
 * Only ever called once the overlap test has established that nothing inside
 * the group covers anything else -- there, `fade the group` and `fade each
 * part` are the same picture, and this is the one that stays editable: every
 * layer keeps its own transform and its own keyframes instead of disappearing
 * into a composition.
 *
 * The group's own layer keeps its opacity: it fades its own paint, and only its
 * descendants need the extra multiplication. A nested comp standing in for a
 * clipped subtree is fine to multiply as a single layer -- a precomp's opacity
 * already fades its whole content as one, which is the behaviour being copied.
 */
function bakeGroupOpacity(host, groupLayer, ids, frameTimes) {
  const groupTrack = groupLayer.transform.opacity;
  for (const layer of host.layers) {
    if (!ids.has(layer.id) || layer.id === groupLayer.id) continue;
    const own = layer.transform.opacity;
    const samples = frameTimes.map((t) => ({
      t,
      v: (evaluate(own, t) ?? 100) * (evaluate(groupTrack, t) ?? 100) / 100,
    }));
    // A product of two eases is not itself a cubic bezier, so the refit is
    // held to a tighter tolerance than a plain track -- this is the one place
    // a curve is approximated rather than converted exactly.
    layer.transform.opacity = buildScalarTrack(samples, 'opacity', { tolerance: 0.15 });
    (layer.opacityBakedFrom || (layer.opacityBakedFrom = [])).push(groupLayer.id);
  }
}

/**
 * Does this element put ANY ink on the page -- its box, or its own content?
 *
 * `paintsAnything` answers only the box question, which is the right question
 * when deciding whether a plain div needs a shape layer. It is the WRONG one
 * for overlap: it says a paragraph, an <img>, a <canvas> and an <svg> all paint
 * nothing, so every one of them was filtered out of the overlap test and a
 * group of overlapping words was baked as though nothing inside it could
 * cover anything else -- the one direction that produces a wrong picture.
 */
function paintsContent(entry, role) {
  if (!entry || !entry.present) return false;
  if (role && role !== 'box') return true;
  return paintsAnything(entry);
}

function paintsAnything(entry) {
  if (!entry || !entry.present) return false;
  const s = entry.style;
  const bg = parseColor(s.backgroundColor);
  if (bg && bg.a > 0.001) return true;
  if (s.backgroundImage && s.backgroundImage !== 'none') return true;
  if (s.boxShadow && s.boxShadow !== 'none') return true;
  for (let i = 0; i < 4; i += 1) {
    if ((s.borderWidth[i] || 0) > 0 && s.borderStyle[i] !== 'none') return true;
  }
  return false;
}

function buildLayer(analysis, byId, report, opts, inheritsThreeD) {
  const { node } = analysis;
  // One cycle of samples, so the emitted keyframes ARE the loop.
  const loop = opts.loops && opts.loops.get(node.id);
  if (loop) analysis = { ...analysis, perFrame: windowFrames(analysis.perFrame, loop) };
  const { perFrame } = analysis;
  const present = perFrame.filter((p) => p.transform);
  if (!present.length) return null;
  const firstEntry = present[0].entry;

  // --- tier -----------------------------------------------------------------
  let tier = 'A';
  const sequenceAsset = opts.sequenceByNode && opts.sequenceByNode.get(node.id);
  if (node.role === 'canvas' || node.role === 'video' || analysis.unrepresentable) {
    tier = 'C';
    report.rasterised.push({
      id: node.id,
      name: node.name,
      reason: sequenceAsset
        ? `${node.role} rasterised: ${sequenceAsset.frames} frame(s) at ${sequenceAsset.width}x${sequenceAsset.height}`
        : (analysis.unrepresentable || `${node.role} content is opaque to DOM measurement`),
      frames: sequenceAsset ? sequenceAsset.frames : 0,
    });
  } else if (!Number.isFinite(analysis.worstPixelError) || analysis.worstPixelError > PIXEL_ERROR_LIMIT) {
    tier = 'C';
    report.rasterised.push({
      id: node.id,
      name: node.name,
      reason: `transform not expressible in AE's model (would displace corners by ${analysis.worstPixelError.toFixed(2)}px)`,
    });
  } else if (analysis.worstSkewPixels > SKEW_PIXEL_LIMIT) {
    tier = 'C';
    report.rasterised.push({
      id: node.id,
      name: node.name,
      reason: `3D skew displaces corners by ${analysis.worstSkewPixels.toFixed(2)}px and AE layers cannot skew in 3D`,
    });
  }
  report.maxMatrixError = Math.max(report.maxMatrixError, Number.isFinite(analysis.worstError) ? analysis.worstError : 0);
  report.maxPixelError = Math.max(report.maxPixelError || 0, Number.isFinite(analysis.worstPixelError) ? analysis.worstPixelError : 0);

  // --- kind -----------------------------------------------------------------
  const paints = perFrame.some((p) => paintsAnything(p.entry));
  let kind = 'null';
  // A rasterised element with captured frames is just an image layer whose
  // source happens to be a sequence -- everything downstream treats it as one.
  if (tier === 'C') kind = sequenceAsset ? 'image' : 'raster';
  else if (node.role === 'text') kind = 'text';
  else if (node.role === 'image') kind = 'image';
  else if (node.role === 'imageBox') kind = 'shape';
  else if (node.role === 'svgShape') kind = 'path';
  else if (paints) kind = 'shape';

  // --- transform tracks -----------------------------------------------------
  const posX = fillGaps(series(analysis, (t) => t.position[0]));
  const posY = fillGaps(series(analysis, (t) => t.position[1]));
  const posZ = fillGaps(series(analysis, (t) => t.position[2]));
  const absX = fillGaps(series(analysis, (t) => t.absolutePosition[0]));
  const absY = fillGaps(series(analysis, (t) => t.absolutePosition[1]));
  const absZ = fillGaps(series(analysis, (t) => t.absolutePosition[2]));
  // A text layer's own origin is its first baseline, not its box top-left, so
  // its anchor point has to be expressed in that shifted space. Everything else
  // in the transform model stays untouched:
  //     Anchor = transformOrigin - baselineOffset
  // which is the exact algebra that keeps CSS and AE agreeing for text.
  const baselineOf = (entry) => (node.role === 'text' && entry && entry.baseline ? entry.baseline : [0, 0]);

  // An image layer's SOURCE is the file's natural pixel size, not the element's
  // box, so the fit has to be folded into the layer transform:
  //     source p  ->  box point  offset + p * fitScale  ->  CSS transform
  // which rearranges to scale = cssScale * fitScale and
  // anchor = (transformOrigin - offset) / fitScale, both in source pixels.
  const imageAsset = node.role === 'image' && firstEntry.src
    ? (opts.assetByUrl && opts.assetByUrl.get(firstEntry.src))
    : (opts.sequenceByNode && opts.sequenceByNode.get(node.id)) || null;
  const fitAt = (p) => {
    if (!imageAsset || !p.transform || !p.entry || !p.entry.present) return null;
    return computeFit({
      naturalW: imageAsset.width,
      naturalH: imageAsset.height,
      boxW: p.transform.size[0],
      boxH: p.transform.size[1],
      // A canvas's intrinsic buffer is stretched to its CSS box, which is
      // exactly object-fit: fill.
      mode: node.role === 'canvas' ? 'fill' : (p.entry.objectFit || 'fill'),
    });
  };
  const ancX = fillGaps(analysis.perFrame.map((p) => {
    if (!p.transform) return { t: p.time, v: null };
    const base = p.transform.anchorPoint[0] - baselineOf(p.entry)[0];
    const fit = fitAt(p);
    return { t: p.time, v: fit ? (base - fit.offset[0]) / (fit.scale[0] || 1) : base };
  }));
  const ancY = fillGaps(analysis.perFrame.map((p) => {
    if (!p.transform) return { t: p.time, v: null };
    const base = p.transform.anchorPoint[1] - baselineOf(p.entry)[1];
    const fit = fitAt(p);
    return { t: p.time, v: fit ? (base - fit.offset[1]) / (fit.scale[1] || 1) : base };
  }));
  const ancZ = fillGaps(series(analysis, (t) => t.anchorPoint[2]));
  const sclX = fillGaps(analysis.perFrame.map((p) => {
    if (!p.transform) return { t: p.time, v: null };
    const fit = fitAt(p);
    return { t: p.time, v: p.transform.scale[0] * (fit ? fit.scale[0] : 1) };
  }), 100);
  const sclY = fillGaps(analysis.perFrame.map((p) => {
    if (!p.transform) return { t: p.time, v: null };
    const fit = fitAt(p);
    return { t: p.time, v: p.transform.scale[1] * (fit ? fit.scale[1] : 1) };
  }), 100);
  const sclZ = fillGaps(series(analysis, (t) => t.scale[2]), 100);
  const opacity = fillGaps(series(analysis, (t) => t.opacity), 100);

  const threeD = analysis.everThreeD || Boolean(inheritsThreeD);
  const transform = {
    anchorPoint: buildVectorTrack([ancX, ancY, ancZ].slice(0, threeD ? 3 : 2), 'anchorPoint'),
    position: buildVectorTrack([posX, posY, posZ].slice(0, threeD ? 3 : 2), 'position'),
    scale: buildVectorTrack([sclX, sclY, sclZ].slice(0, threeD ? 3 : 2), 'scale'),
    opacity: buildScalarTrack(opacity, 'opacity'),
  };
  if (threeD) {
    const ox = fillGaps(series(analysis, (t) => t.orientation[0]));
    const oy = fillGaps(series(analysis, (t) => t.orientation[1]));
    const oz = fillGaps(series(analysis, (t) => t.orientation[2]));
    transform.orientation = buildVectorTrack(
      [ox, oy, oz].map((s) => unwrapSeries(s)), 'orientation',
    );
  } else {
    transform.rotation = buildScalarTrack(unwrapSeries(fillGaps(series(analysis, (t) => t.rotation))), 'rotation');
  }

  for (const track of Object.values(transform)) {
    if (track && Number.isFinite(track.maxError)) {
      report.maxTrackError = Math.max(report.maxTrackError, track.maxError);
    }
  }

  const layer = {
    id: node.id,
    name: node.name,
    __firstEntry: firstEntry,
    // Page-space position, kept alongside the parent-relative one so a layer can
    // be lifted into a precomp where its parent did not follow.
    absolute: buildVectorTrack([absX, absY, absZ].slice(0, threeD ? 3 : 2), 'position'),
    // Every layer's untransformed box, not just shapes -- a precomp sized from
    // shape extents alone omits all the text and comes out far too small.
    // The page-space top-left of the border box, taken from the transformed
    // box corners rather than reconstructed from position minus anchor -- the
    // anchor means different things per layer kind, so the old arithmetic put a
    // text layer's box a whole ascent too low and an image layer's in the wrong
    // units. Composition bounds are measured from this.
    boxOrigin: buildVectorTrack([0, 1].map((k) => fillGaps(analysis.perFrame.map((p) => ({
      t: p.time,
      v: p.transform && p.transform.boxQuad ? p.transform.boxQuad[0][k] : null,
    })))), 'position'),
    boxSize: buildVectorTrack(
      [fillGaps(series(analysis, (t) => t.size[0])), fillGaps(series(analysis, (t) => t.size[1]))],
      'size',
    ),
    parentId: node.parentId,
    kind,
    tier,
    threeD,
    role: node.role,
    inPoint: analysis.firstVisible,
    outPoint: analysis.lastVisible,
    loop: loop ? { start: loop.start, period: loop.period } : null,
    transform,
    blendMode: blendModeToAe(firstEntry.style.mixBlendMode),
    effects: buildEffects(analysis, report),
  };

  if (analysis.everSkewed) {
    const skew = fillGaps(series(analysis, (t) => t.skew));
    layer.skew = buildScalarTrack(skew, 'angle');
    report.approximations.push({
      id: node.id, name: node.name,
      note: 'CSS skew written as a Transform effect; AE layers have no native skew',
    });
  }

  if (kind === 'shape') layer.shape = buildShape(analysis, opts);
  if (kind === 'text') layer.text = buildText(analysis);
  if (kind === 'path') {
    layer.path = buildPath(analysis);
    const unit = firstEntry && firstEntry.user ? Math.max(firstEntry.user.scale[0], firstEntry.user.scale[1]) : 1;
    const morph = keyPathMorph(analysis, TOLERANCE.position / (unit || 1));
    if (morph && morph.mismatch) {
      report.approximations.push({
        id: node.id, name: node.name,
        note: `path changes shape (${morph.mismatch.vertices[0]} to ${morph.mismatch.vertices[1]} points at ${morph.mismatch.time.toFixed(2)}s); only its first outline was kept`,
      });
    } else if (morph) {
      layer.path.morph = morph;
    }
  }
  if (kind === 'image') {
    if (imageAsset) {
      const fit0 = fitAt(present[0]);
      layer.image = {
        assetId: imageAsset.id,
        natural: [imageAsset.width, imageAsset.height],
        objectFit: node.role === 'canvas' ? 'fill' : (firstEntry.objectFit || 'fill'),
        sequence: imageAsset.kind === 'sequence',
      };
      // cover (and an oversized `none`) deliberately overflow the element box,
      // and CSS clips that overflow to the box. AE will not, so the layer gets a
      // mask -- in SOURCE pixels, because that is the space a mask lives in.
      if (fit0 && fit0.clips) {
        const sx = fit0.scale[0] || 1;
        const sy = fit0.scale[1] || 1;
        layer.mask = rectPathInSource(
          -fit0.offset[0] / sx, -fit0.offset[1] / sy,
          present[0].transform.size[0] / sx, present[0].transform.size[1] / sy,
        );
      }
    } else {
      layer.kind = 'null';
      report.approximations.push({
        id: node.id, name: node.name,
        note: `image source could not be resolved; layer imports as an empty placeholder`,
      });
    }
  }

  report.tiers[tier] += 1;
  return layer;
}

function unwrapSeries(samples) {
  const values = unwrapAngles(samples.map((s) => s.v));
  return samples.map((s, i) => ({ t: s.t, v: values[i] }));
}

function buildShape(analysis, opts = {}) {
  const w = fillGaps(analysis.perFrame.map((p) => ({ t: p.time, v: p.transform ? p.transform.size[0] : null })));
  const h = fillGaps(analysis.perFrame.map((p) => ({ t: p.time, v: p.transform ? p.transform.size[1] : null })));
  const radius = fillGaps(analysis.perFrame.map((p) => {
    if (!p.entry || !p.entry.present) return { t: p.time, v: null };
    const [rx] = parseRadius(p.entry.style.borderRadius[0], p.transform.size[0], p.transform.size[1]);
    return { t: p.time, v: rx };
  }));
  const colorChannels = [0, 1, 2].map((c) => fillGaps(analysis.perFrame.map((p) => {
    if (!p.entry || !p.entry.present) return { t: p.time, v: null };
    const col = parseColor(p.entry.style.backgroundColor);
    return { t: p.time, v: col ? col.rgb[c] : 0 };
  })));
  const fillAlpha = fillGaps(analysis.perFrame.map((p) => {
    if (!p.entry || !p.entry.present) return { t: p.time, v: null };
    const col = parseColor(p.entry.style.backgroundColor);
    return { t: p.time, v: (col ? col.a : 0) * 100 };
  }), 100);

  const first = analysis.perFrame.find((p) => p.entry && p.entry.present);
  const borderWidth = first ? first.entry.style.borderWidth[0] || 0 : 0;
  const borderColor = first ? parseColor(first.entry.style.borderColor[0]) : null;
  const gradient = first && first.entry.style.backgroundImage !== 'none'
    ? first.entry.style.backgroundImage : null;

  return {
    size: buildVectorTrack([w, h], 'size'),
    roundness: buildScalarTrack(radius, 'roundness'),
    fill: { color: buildVectorTrack(colorChannels, 'color'), opacity: buildScalarTrack(fillAlpha, 'opacity') },
    stroke: borderWidth > 0 && borderColor && borderColor.a > 0
      ? { width: borderWidth, color: borderColor }
      : null,
    gradient: gradientSpec(analysis, gradient, opts),
    shadows: first ? parseBoxShadow(first.entry.style.boxShadow) : [],
  };
}

/**
 * A shape's gradient, as an editable ramp -- or as nothing, when a person chose
 * to have it drawn exactly instead and a bitmap layer is carrying it.
 *
 * After Effects' Gradient Ramp holds two stops and no per-stop alpha. A
 * gradient that needs more than that cannot be written as a ramp without
 * losing something visible, so the choice is offered rather than made: the
 * default stays the ramp, which is the thing a motion designer can re-colour.
 */
function gradientSpec(analysis, css, opts) {
  if (!css) return null;
  const linear = parseLinearGradient(css);
  const spec = { css, linear };
  if (!linear || !opts.decisions) return spec;

  const stops = linear.stops || [];
  const losesStops = stops.length > 2;
  const losesAlpha = stops.some((stop) => stop.color && stop.color.a < 0.999);
  if (!losesStops && !losesAlpha) return spec;

  const detail = losesStops && losesAlpha
    ? `${stops.length} stops and per-stop transparency`
    : (losesStops ? `${stops.length} stops` : 'per-stop transparency');
  // What it would take to draw this one exactly: the computed background and
  // the padding box it fills. Collected now because this is where both are to
  // hand, and the command line needs them only if the choice is accepted.
  const first = analysis.perFrame.find((p) => p.entry && p.entry.present);
  const border = first ? (first.entry.style.borderWidth || [0, 0, 0, 0]) : [0, 0, 0, 0];
  const accepted = opts.decisions.offer({
    kind: 'gradients',
    layerId: analysis.node.id,
    layerName: analysis.node.name,
    detail,
    render: first ? {
      id: analysis.node.id,
      css,
      width: first.entry.box[2] - (border[1] || 0) - (border[3] || 0),
      height: first.entry.box[3] - (border[0] || 0) - (border[2] || 0),
    } : null,
  });
  if (accepted && opts.gradientAssets && opts.gradientAssets.has(analysis.node.id)) return null;
  return spec;
}

function buildText(analysis) {
  const first = analysis.perFrame.find((p) => p.entry && p.entry.present);
  const s = first.entry.style;
  const colorChannels = [0, 1, 2].map((c) => fillGaps(analysis.perFrame.map((p) => {
    if (!p.entry || !p.entry.present) return { t: p.time, v: null };
    const col = parseColor(p.entry.style.color);
    return { t: p.time, v: col ? col.rgb[c] : 0 };
  })));
  const sizes = fillGaps(analysis.perFrame.map((p) => ({
    t: p.time, v: p.entry && p.entry.present ? p.entry.style.fontSize : null,
  })));
  const values = analysis.perFrame.map((p) => (p.entry && p.entry.present ? (p.entry.text || '') : null));
  const stable = values.filter((v) => v !== null);
  return {
    baseline: first.entry.baseline || [0, 0],
    value: stable.length ? stable[stable.length - 1].trim() : '',
    changes: new Set(stable.map((v) => v.trim())).size > 1,
    font: primaryFontFamily(s.fontFamily),
    weight: s.fontWeight,
    italic: s.fontStyle === 'italic',
    size: buildScalarTrack(sizes, 'length'),
    color: buildVectorTrack(colorChannels, 'color'),
    leading: parseLineHeight(s.lineHeight, s.fontSize),
    tracking: s.letterSpacing === 'normal' ? 0 : (parseFloat(s.letterSpacing) / s.fontSize) * 1000,
    align: s.textAlign,
    transform: s.textTransform,
    kerning: s.fontKerning === 'none' ? 'none' : 'auto',
    stack: s.fontFamily,
  };
}

function buildPath(analysis) {
  const first = analysis.perFrame.find((p) => p.entry && p.entry.present);
  const dashOffsets = fillGaps(analysis.perFrame.map((p) => ({
    t: p.time, v: p.entry && p.entry.present ? p.entry.style.strokeDashoffset : null,
  })));
  const strokeChannels = [0, 1, 2].map((c) => fillGaps(analysis.perFrame.map((p) => {
    if (!p.entry || !p.entry.present) return { t: p.time, v: null };
    const col = parseColor(p.entry.style.stroke);
    return { t: p.time, v: col ? col.rgb[c] : 0 };
  })));
  return {
    d: first.entry.d || null,
    geom: first.entry.geom || null,
    tag: analysis.node.tag,
    bbox: first.entry.bbox || null,
    totalLength: first.entry.pathLength ?? null,
    strokeWidth: first.entry.style.strokeWidth || 0,
    strokeColor: buildVectorTrack(strokeChannels, 'color'),
    fillColor: parseColor(first.entry.style.fill),
    dashArray: parseDashArray(first.entry.style.strokeDasharray),
    dashOffset: buildScalarTrack(dashOffsets, 'length'),
    lineCap: first.entry.style.strokeLinecap,
    lineJoin: first.entry.style.strokeLinejoin,
  };
}

function buildEffects(analysis, report) {
  const effects = [];
  const first = analysis.perFrame.find((p) => p.entry && p.entry.present);
  if (!first) return effects;

  const blurSamples = fillGaps(analysis.perFrame.map((p) => {
    if (!p.entry || !p.entry.present) return { t: p.time, v: null };
    const fns = parseFilter(p.entry.style.filter);
    const blur = fns.find((f) => f.fn === 'blur');
    return { t: p.time, v: blur ? blur.args.value : 0 };
  }));
  if (blurSamples.some((s) => s.v > 0.001)) {
    effects.push({ type: 'gaussianBlur', params: { blurriness: buildScalarTrack(blurSamples, 'length') } });
  }

  const brightSamples = fillGaps(analysis.perFrame.map((p) => {
    if (!p.entry || !p.entry.present) return { t: p.time, v: null };
    const fns = parseFilter(p.entry.style.filter);
    const b = fns.find((f) => f.fn === 'brightness');
    return { t: p.time, v: b ? b.args.value : 1 };
  }), 1);
  if (brightSamples.some((s) => Math.abs(s.v - 1) > 0.001)) {
    effects.push({ type: 'brightness', params: { amount: buildScalarTrack(brightSamples, 'number') } });
  }

  const shadowFns = parseFilter(first.entry.style.filter).filter((f) => f.fn === 'drop-shadow');
  for (const shadow of shadowFns) {
    effects.push({ type: 'dropShadow', params: { ...shadow.args, static: true } });
  }

  const unsupported = parseFilter(first.entry.style.filter)
    .map((f) => f.fn)
    .filter((fn) => !['blur', 'brightness', 'drop-shadow'].includes(fn));
  if (unsupported.length) {
    report.approximations.push({
      id: analysis.node.id, name: analysis.node.name,
      note: `CSS filter(s) not mapped: ${unsupported.join(', ')}`,
    });
  }
  return effects;
}

/** A CSS background-image that is a gradient, not a fetched bitmap. */
export function isGradient(value) {
  return typeof value === 'string' && /(^|\s|,)(repeating-)?(linear|radial|conic)-gradient\(/.test(value);
}

/**
 * Parse a computed linear-gradient into the pieces After Effects' Gradient Fill
 * needs: an angle and a list of { position 0..1, color } stops. Chromium always
 * serialises the angle form, so this does not have to handle `to bottom right`.
 */
export function parseLinearGradient(value) {
  const text = String(value || '');
  // linear-, radial- and conic-gradient share the stop syntax; only the
  // geometry differs. The KIND matters now that gradients import as a real AE
  // Gradient Ramp effect, which has a linear and a radial mode.
  const m = /(?:^|\s|,)(linear|radial|conic)-gradient\((.*)\)\s*$/s.exec(text);
  if (!m) return null;
  const kind = m[1];
  const parts = splitTopLevel(m[2]);
  let angle = 180;
  let i = 0;
  const head = parts.length ? parts[0].trim() : '';
  if (/deg\s*$/.test(head)) {
    angle = parseFloat(head);
    i = 1;
  } else if (/^to\s+/i.test(head)) {
    // Chromium normally serialises the angle form, but a captured or
    // hand-written value can still carry the keyword form. CSS measures
    // clockwise from "to top".
    const sides = head.toLowerCase().replace(/^to\s+/, '').split(/\s+/).sort().join(' ');
    const byKeyword = {
      top: 0, right: 90, bottom: 180, left: 270,
      'right top': 45, 'bottom right': 135, 'bottom left': 225, 'left top': 315,
    };
    angle = byKeyword[sides] ?? 180;
    i = 1;
  } else if (/^(circle|ellipse|closest|farthest|at\s)/.test(head)) {
    i = 1;
  }

  const stops = [];
  for (; i < parts.length; i += 1) {
    const part = parts[i].trim();
    const colorMatch = part.match(/rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8}|\b(?:transparent|currentcolor)\b/i);
    // A fragment with no colour in it is geometry (a size or position keyword),
    // not a stop. Keeping it would inject a phantom transparent black.
    if (!colorMatch) continue;
    const color = parseColor(colorMatch[0]);
    if (!color) continue;
    const posMatch = part.match(/([\d.]+)%\s*$/);
    stops.push({ color, position: posMatch ? Number(posMatch[1]) / 100 : null });
  }

  // Fill in implicit stop positions: evenly spaced between explicit ones.
  for (let k = 0; k < stops.length; k += 1) {
    if (stops[k].position !== null) continue;
    if (k === 0) stops[k].position = 0;
    else if (k === stops.length - 1) stops[k].position = 1;
    else {
      let next = k + 1;
      while (next < stops.length && stops[next].position === null) next += 1;
      const lo = stops[k - 1].position;
      const hi = next < stops.length ? stops[next].position : 1;
      stops[k].position = lo + ((hi - lo) * (1)) / (next - k + 1);
    }
  }
  return { kind, angle, stops: stops.filter((s) => s.color) };
}

function splitTopLevel(value) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '(') depth += 1;
    else if (value[i] === ')') depth -= 1;
    else if (value[i] === ',' && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out;
}
