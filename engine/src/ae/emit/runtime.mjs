// The ExtendScript runtime half of the importer: identical bytes for every
// import, so it can also be installed standalone as ae/Design2AE.jsx.
// ES3 only -- no let/const, no arrows, no JSON, no Array.prototype helpers.
export const RUNTIME = String.raw`
function D2AE() {}
D2AE.log = [];
D2AE.note = function (msg) { D2AE.log.push(msg); };

// --- keyframe writing -------------------------------------------------------

// AE wants an ease array whose length matches the property's dimensionality,
// except for SPATIAL properties where it wants exactly one. Rather than hard-code
// that rule, try the natural shape and fall back: one caught exception per
// property, once, and no version-specific branching to rot.
// How many KeyframeEase objects does this property want? The answer is not the
// track's dimensionality: After Effects stores Scale as THREE-dimensional even
// on a 2D layer, so a 2-element array is rejected outright, while a SPATIAL
// property such as unified Position wants exactly one (speed runs along the
// motion path). Rather than encode a table that rots between versions, ask the
// property what it is and keep a fallback list.
D2AE.easeArity = function (prop) {
  try {
    var t = prop.propertyValueType;
    if (t === PropertyValueType.TwoD_SPATIAL || t === PropertyValueType.ThreeD_SPATIAL) return [1, 2, 3];
    if (t === PropertyValueType.ThreeD) return [3, 2, 1];
    if (t === PropertyValueType.TwoD) return [2, 3, 1];
    if (t === PropertyValueType.OneD) return [1, 2, 3];
  } catch (e) {}
  return [1, 2, 3];
};

D2AE.fitEases = function (list, n) {
  var out = [];
  var i;
  for (i = 0; i < n; i += 1) out.push(list[Math.min(i, list.length - 1)]);
  return out;
};

D2AE.setEase = function (prop, index, inEases, outEases) {
  var candidates = D2AE.easeArity(prop);
  var tried = {};
  var order = [inEases.length];
  var i;
  for (i = 0; i < candidates.length; i += 1) order.push(candidates[i]);
  var lastError = null;
  for (i = 0; i < order.length; i += 1) {
    var n = order[i];
    if (!n || tried[n]) continue;
    tried[n] = true;
    try {
      prop.setTemporalEaseAtKey(index, D2AE.fitEases(inEases, n), D2AE.fitEases(outEases, n));
      return true;
    } catch (e) { lastError = e; }
  }
  D2AE.note("ease not applied on " + prop.name + ": " + (lastError ? lastError.toString() : "unknown"));
  return false;
};

D2AE.scaled = function (value, scale) {
  var i, out;
  if (!scale || scale === 1) return value;
  if (value instanceof Array) {
    out = [];
    for (i = 0; i < value.length; i += 1) out.push(value[i] * scale);
    return out;
  }
  return value * scale;
};

// track = { s: value } | { k: [ [time, value, hold, inEases, outEases], ... ] }
D2AE.applyTrack = function (prop, track, scale) {
  var i, j, rec, inEases, outEases;
  if (!track || !prop) return;
  if (track.s !== undefined) {
    try { prop.setValue(D2AE.scaled(track.s, scale)); }
    catch (e) { D2AE.note("value not set on " + prop.name + ": " + e.toString()); }
    return;
  }
  if (!track.k || track.k.length === 0) return;
  for (i = 0; i < track.k.length; i += 1) {
    prop.setValueAtTime(track.k[i][0], D2AE.scaled(track.k[i][1], scale));
  }
  for (i = 0; i < track.k.length; i += 1) {
    rec = track.k[i];
    inEases = [];
    outEases = [];
    for (j = 0; j < rec[3].length; j += 1) inEases.push(new KeyframeEase(rec[3][j][0] * (scale || 1), rec[3][j][1]));
    for (j = 0; j < rec[4].length; j += 1) outEases.push(new KeyframeEase(rec[4][j][0] * (scale || 1), rec[4][j][1]));
    D2AE.setEase(prop, i + 1, inEases, outEases);
    if (rec[2]) {
      try {
        prop.setInterpolationTypeAtKey(i + 1, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.HOLD);
      } catch (e) { D2AE.note("hold not applied: " + e.toString()); }
    }
  }
};

// --- coordinate model self-check -------------------------------------------

// The importer's coordinate mapping assumes a child's Position is expressed in
// the parent's PRE-transform space, i.e. that AE subtracts the parent's anchor
// point from points rather than shifting the child's origin by it. If that is
// wrong, every nested layer is offset and the comp is quietly useless -- so
// measure it against the running application instead of trusting a comment.
D2AE.verifyCoordinateModel = function (project) {
  var comp = project.items.addComp("d2ae-selfcheck", 400, 400, 1, 1, 30);
  var result = { ok: false, detail: "" };
  try {
    var parent = comp.layers.addNull();
    parent.transform.anchorPoint.setValue([0, 0]);
    parent.transform.position.setValue([100, 50]);
    parent.transform.rotation.setValue(90);
    parent.transform.scale.setValue([200, 200]);

    var child = comp.layers.addNull();
    // Parent first, then write values -- the same order build() uses, so the
    // check actually exercises the code path it is guarding.
    if (typeof child.setParentWithJump === "function") child.setParentWithJump(parent);
    else child.parent = parent;
    child.transform.anchorPoint.setValue([0, 0]);
    child.transform.position.setValue([10, 20]);

    // Under our model the child's origin maps to comp space as
    //   parentPos + R(90) . S(2) . (childPos - parentAnchor)
    //   = [100,50] + R(90) . [20,40] = [100,50] + [-40,20] = [60,70]
    var got = child.sourcePointToComp([0, 0]);
    var dx = Math.abs(got[0] - 60);
    var dy = Math.abs(got[1] - 70);
    result.ok = (dx < 0.05 && dy < 0.05);
    result.detail = "expected [60,70], got [" + got[0].toFixed(3) + "," + got[1].toFixed(3) + "]";
  } catch (e) {
    result.detail = "self-check threw: " + e.toString();
  }
  try { comp.remove(); } catch (e) {}
  return result;
};

// --- shape builders ---------------------------------------------------------

D2AE.addRect = function (layer, spec) {
  var i, keys;
  var vectors = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
  vectors.name = "Box";
  var group = vectors.property("ADBE Vectors Group");
  var rect = group.addProperty("ADBE Vector Shape - Rect");

  // The rectangle spans (0,0)..(w,h) in LAYER space. That is what makes
  // anchorPoint == CSS transform-origin and position == CSS layout offset hold.
  D2AE.applyTrack(rect.property("ADBE Vector Rect Size"), spec.size);
  var posProp = rect.property("ADBE Vector Rect Position");
  if (spec.size.s !== undefined) {
    posProp.setValue([spec.size.s[0] / 2, spec.size.s[1] / 2]);
  } else {
    keys = spec.size.k;
    for (i = 0; i < keys.length; i += 1) {
      posProp.setValueAtTime(keys[i][0], [keys[i][1][0] / 2, keys[i][1][1] / 2]);
    }
  }
  if (spec.roundness) D2AE.applyTrack(rect.property("ADBE Vector Rect Roundness"), spec.roundness);

  if (spec.fill) {
    var fill = group.addProperty("ADBE Vector Graphic - Fill");
    D2AE.applyTrack(fill.property("ADBE Vector Fill Color"), spec.fill.color, 1 / 255);
    if (spec.fill.opacity) D2AE.applyTrack(fill.property("ADBE Vector Fill Opacity"), spec.fill.opacity);
  }

  if (spec.ramp) D2AE.addRamp(layer, spec.ramp);

  if (spec.stroke) {
    var stroke = group.addProperty("ADBE Vector Graphic - Stroke");
    stroke.property("ADBE Vector Stroke Width").setValue(spec.stroke.width);
    stroke.property("ADBE Vector Stroke Color").setValue([
      spec.stroke.color[0] / 255, spec.stroke.color[1] / 255, spec.stroke.color[2] / 255, 1]);
    stroke.property("ADBE Vector Stroke Opacity").setValue(spec.stroke.alpha * 100);
  }
  return vectors;
};

// A CSS gradient becomes a Gradient Ramp EFFECT rather than a shape-layer
// Gradient Fill. The fill route is unusable from a script: its
// "ADBE Vector Grad Colors" property reports PropertyValueType.NO_VALUE and
// refuses both get and set, so the stops cannot be written and the gradient
// would arrive as AE's default black-to-white. ADBE Ramp is fully scriptable and,
// applied to a shape layer, RESPECTS THE SHAPE ALPHA -- the gradient fills the
// rounded rectangle and leaves the rest of the frame alone.
//
// Ramp shape is 1 = linear, 2 = radial. Its colours carry no usable alpha
// (measured: a colour-to-transparent ramp renders fully opaque), so an alpha
// falloff rides on the fill opacity instead.
D2AE.addRamp = function (layer, ramp) {
  try {
    var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Ramp");
    fx.property("ADBE Ramp-0001").setValue(ramp.start);
    fx.property("ADBE Ramp-0002").setValue([
      ramp.startColor[0] / 255, ramp.startColor[1] / 255, ramp.startColor[2] / 255, 1]);
    fx.property("ADBE Ramp-0003").setValue(ramp.end);
    fx.property("ADBE Ramp-0004").setValue([
      ramp.endColor[0] / 255, ramp.endColor[1] / 255, ramp.endColor[2] / 255, 1]);
    fx.property("ADBE Ramp-0005").setValue(ramp.shape);
    if (ramp.stopCount > 2) {
      D2AE.note("gradient on " + layer.name + " has " + ramp.stopCount +
        " stops; AE's ramp takes two, so the middle stops were dropped");
    }
    if (ramp.alphaVaries) {
      D2AE.note("gradient on " + layer.name +
        " fades in alpha; ramp colours carry no alpha, so a flat " +
        Math.round(ramp.opacity) + "% was used (a luma track matte would be exact)");
    }
  } catch (e) {
    D2AE.note("gradient ramp on " + layer.name + " failed: " + e.toString());
  }
};

D2AE.addPath = function (layer, spec) {
  var vectors = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
  vectors.name = "Path";
  var group = vectors.property("ADBE Vectors Group");
  var shapeProp = group.addProperty("ADBE Vector Shape - Group");
  var path = new Shape();
  path.vertices = spec.vertices;
  path.inTangents = spec.inTangents;
  path.outTangents = spec.outTangents;
  path.closed = spec.closed;
  shapeProp.property("ADBE Vector Shape").setValue(path);
  if (spec.morph) D2AE.applyMorph(shapeProp.property("ADBE Vector Shape"), spec.morph);

  if (spec.fill) {
    var fill = group.addProperty("ADBE Vector Graphic - Fill");
    fill.property("ADBE Vector Fill Color").setValue([spec.fill.c[0] / 255, spec.fill.c[1] / 255, spec.fill.c[2] / 255, 1]);
    fill.property("ADBE Vector Fill Opacity").setValue(spec.fill.a * 100);
  }
  if (spec.strokeWidth > 0) {
    var stroke = group.addProperty("ADBE Vector Graphic - Stroke");
    stroke.property("ADBE Vector Stroke Width").setValue(spec.strokeWidth);
    D2AE.applyTrack(stroke.property("ADBE Vector Stroke Color"), spec.strokeColor, 1 / 255);
    try { stroke.property("ADBE Vector Stroke Line Cap").setValue(spec.lineCap); } catch (e) {}
  }
  // A stroke-dashoffset animation IS a draw-on. AE spells that Trim Paths, so
  // translate the idiom rather than the numbers -- the result is editable.
  if (spec.trim) {
    var trim = group.addProperty("ADBE Vector Filter - Trim");
    D2AE.applyTrack(trim.property("ADBE Vector Trim End"), spec.trim.end);
    if (spec.trim.start) D2AE.applyTrack(trim.property("ADBE Vector Trim Start"), spec.trim.start);
  }
  return vectors;
};

// An animated SVG path ("d"): one Shape per key, linear in time, which is how AE
// interpolates a path anyway (every vertex and handle in a straight line). The
// keys were chosen so that straight-line interpolation stays on the browser's
// frames.
D2AE.applyMorph = function (prop, morph) {
  var shapes = [], i, j, s, zeros;
  for (i = 0; i < morph.t.length; i += 1) {
    s = new Shape();
    s.vertices = morph.v[i];
    if (morph.i) {
      s.inTangents = morph.i[i];
      s.outTangents = morph.o[i];
    } else {
      zeros = [];
      for (j = 0; j < morph.v[i].length; j += 1) zeros.push([0, 0]);
      s.inTangents = zeros;
      s.outTangents = zeros;
    }
    s.closed = morph.closed;
    shapes.push(s);
  }
  try { prop.setValuesAtTimes(morph.t, shapes); }
  catch (e) { for (i = 0; i < shapes.length; i += 1) prop.setValueAtTime(morph.t[i], shapes[i]); }
  for (i = 1; i <= prop.numKeys; i += 1) {
    try { prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); } catch (e2) {}
  }
};

// Map a CSS weight and italic flag onto the style names a font family might
// actually use. Foundries disagree ("SemiBold" vs "Semibold" vs "DemiBold"), so
// this is a candidate list rather than a lookup.
D2AE.styleCandidates = function (weight, italic) {
  var w = Number(weight) || 400;
  var base;
  if (w >= 800) base = ["ExtraBold", "Black", "Heavy", "Bold"];
  else if (w >= 700) base = ["Bold", "SemiBold", "Semibold"];
  else if (w >= 600) base = ["SemiBold", "Semibold", "DemiBold", "Demi", "Bold"];
  else if (w >= 500) base = ["Medium", "Regular"];
  else if (w <= 300) base = ["Light", "Thin", "ExtraLight", "Regular"];
  else base = ["Regular", "Book", "Normal"];

  // Many families ship only Regular and Italic. A heading is weight 700 by
  // default, so asking only for bold styles finds nothing and the text silently
  // imports in the application default -- which is what happened to a display
  // serif here. After the weight-appropriate candidates, fall through every
  // common style so a family that exists is always used, and let the caller
  // report the substitution.
  var universal = ["Regular", "Book", "Normal", "Medium", "SemiBold", "Semibold",
                   "Bold", "Light", "Text", "Roman"];
  var out = [];
  var i;
  var j;
  if (italic) {
    for (i = 0; i < base.length; i += 1) {
      out.push(base[i] === "Regular" ? "Italic" : base[i] + " Italic");
      out.push(base[i] + "Italic");
      out.push(base[i] + " Oblique");
    }
  }
  for (i = 0; i < base.length; i += 1) out.push(base[i]);
  if (italic) {
    for (j = 0; j < universal.length; j += 1) {
      out.push(universal[j] === "Regular" ? "Italic" : universal[j] + " Italic");
    }
  }
  for (j = 0; j < universal.length; j += 1) out.push(universal[j]);
  return out;
};

// Resolve a family + weight + italic to the PostScript name After Effects wants.
//
// Assigning TextDocument.fontFamily does not take in AE 2026's text engine --
// the value silently stays whatever it was, so text imports in Myriad Pro no
// matter how carefully the family was captured. Setting the font property to
// the PostScript name DOES work, and getFontsByFamilyNameAndStyleName is the
// reliable way to find that name for an installed family.
D2AE.resolveFont = function (family, weight, italic) {
  var styles = D2AE.styleCandidates(weight, italic);
  var i;
  try {
    for (i = 0; i < styles.length; i += 1) {
      var found = app.fonts.getFontsByFamilyNameAndStyleName(family, styles[i]);
      if (found && found.length) {
        if (i > 2) {
          D2AE.note("font " + family + " has no " + weight +
            (italic ? " italic" : "") + " face; used " + styles[i]);
        }
        return found[0].postScriptName;
      }
    }
  } catch (e) { /* older builds have no app.fonts; fall through */ }
  // Last resort: the conventional PostScript spelling, which many families use.
  var compact = String(family).replace(/\s+/g, "");
  return compact + "-" + (styles.length ? String(styles[0]).replace(/\s+/g, "") : "Regular");
};

D2AE.styleText = function (layer, spec) {
  var src = layer.property("ADBE Text Properties").property("ADBE Text Document");
  var doc = src.value;
  doc.resetCharStyle();
  doc.text = spec.value;

  if (spec.font) {
    var ps = D2AE.resolveFont(spec.font, spec.weight, spec.italic);
    var applied = false;
    if (ps) {
      try { doc.font = ps; applied = (String(doc.font) === String(ps)); } catch (e) {}
    }
    if (!applied) {
      try {
        doc.fontFamily = spec.font;
        applied = (String(doc.fontFamily) === String(spec.font));
      } catch (e) {}
    }
    if (!applied) {
      D2AE.note("font not applied: " + spec.font + " " + (spec.weight || "") +
        (spec.italic ? " italic" : "") + " -- install it and re-run");
    }
  }

  if (spec.size) doc.fontSize = spec.size;
  if (spec.color) doc.fillColor = [spec.color[0] / 255, spec.color[1] / 255, spec.color[2] / 255];
  doc.applyFill = true;
  doc.applyStroke = false;
  if (spec.tracking) doc.tracking = spec.tracking;
  // AE 24.0+; older versions keep metric kerning, a few pixels per pair at most.
  if (spec.kern === "none") {
    try { doc.autoKernType = AutoKernType.NO_AUTO_KERN; } catch (e) {}
  }
  if (spec.leading) { doc.autoLeading = false; doc.leading = spec.leading; }
  try { if (spec.justification !== undefined && spec.justification !== null) doc.justification = spec.justification; } catch (e) {}
  src.setValue(doc);
};

// A run of spans that animated one after another, rebuilt as ONE text layer
// with a text animator.
//
// The animator carries the state the run animates FROM; every member gets a
// Range Selector over its own characters, and that selector's Amount blends
// the state away on that word's own schedule. Selector Mode is Add and the
// ranges are disjoint, so each character is driven by exactly one of them.
//
// Only Units has to be changed from its default: After Effects already
// defaults Based On to Characters, Shape to Square and Mode to Add, which is
// what indexed per-word selection wants. Smoothness DOES have to go to zero --
// left at 100 it ramps the selection across the boundary characters and a word
// starts moving before its turn.
// Say what happened.
//
// An alert() is right when a person just ran the script from the File menu,
// and WRONG when something is driving After Effects from outside: a modal
// dialog stops the scripting engine dead, and every later DoScript hangs
// waiting for a click that is not coming. So the summary is always written to
// a file beside the project, and the dialog only appears when nothing has
// declared itself to be automating.
D2AE.report = function (text) {
  try { $.global.D2AE_LAST = text; } catch (e0) {}
  try {
    var f = new File(Folder.temp.fsName + "/d2ae-last-import.txt");
    f.encoding = "UTF-8";
    f.open("w"); f.write(text); f.close();
  } catch (e) {}
  var silent = false;
  try { silent = ($.global.D2AE_SILENT === true); } catch (e2) {}
  if (!silent) alert(text);
};

D2AE.applyStagger = function (layer, spec) {
  var props = layer.property("ADBE Text Properties");
  var animators = props.property("ADBE Text Animators");
  var anim = animators.addProperty("ADBE Text Animator");
  try { anim.name = "stagger"; } catch (e) {}
  var bag = anim.property("ADBE Text Animator Properties");

  if (spec.from.position) bag.addProperty("ADBE Text Position 3D").setValue(spec.from.position);
  if (spec.from.opacity !== null && spec.from.opacity !== undefined) {
    bag.addProperty("ADBE Text Opacity").setValue(spec.from.opacity);
  }
  if (spec.from.scale) bag.addProperty("ADBE Text Scale 3D").setValue([spec.from.scale[0], spec.from.scale[1], 100]);
  if (spec.from.rotation !== null && spec.from.rotation !== undefined) {
    bag.addProperty("ADBE Text Rotation").setValue(spec.from.rotation);
  }

  var selectors = anim.property("ADBE Text Selectors");
  for (var i = 0; i < spec.members.length; i++) {
    var m = spec.members[i];
    var sel = selectors.addProperty("ADBE Text Selector");
    try { sel.name = m.text; } catch (e) {}
    var adv = sel.property("ADBE Text Range Advanced");
    try { adv.property("ADBE Text Range Units").setValue(2); } catch (e) {}
    try { adv.property("ADBE Text Selector Smoothness").setValue(0); } catch (e) {}
    sel.property("ADBE Text Index Start").setValue(m.charStart);
    sel.property("ADBE Text Index End").setValue(m.charEnd);
    D2AE.applyTrack(adv.property("ADBE Text Selector Max Amount"), m.amount);
  }

  // Per-word styling. A title almost always sets one word apart, and losing
  // that is the difference between a usable import and a wrong one -- so the
  // characters get their own fill colour and face where the design gave them
  // one, which is the same thing the browser was doing with a nested span.
  for (var j = 0; j < spec.members.length; j++) {
    var mem = spec.members[j];
    if (!mem.restyle) continue;
    try {
      var src = props.property("ADBE Text Document");
      var td = src.value;
      var range = td.characterRange(mem.charStart, mem.charEnd);
      if (mem.restyle.color) {
        range.fillColor = [mem.restyle.color[0] / 255, mem.restyle.color[1] / 255, mem.restyle.color[2] / 255];
      }
      if (mem.restyle.font) {
        var ps = D2AE.resolveFont(mem.restyle.font, mem.restyle.weight, mem.restyle.italic);
        if (ps) range.font = ps;
      }
      src.setValue(td);
    } catch (e) {
      D2AE.note("could not restyle " + mem.text + " inside the collapsed run: " + e.toString());
    }
  }
};

// A composition clips its contents to its own bounds, which is what makes it
// the right answer for overflow: hidden. Rounded corners need one more step: a
// mask on the precomp layer, in the shape of the padding box's inner radius.
D2AE.applyMask = function (layer, spec) {
  try {
    var masks = layer.property("ADBE Mask Parade");
    var mask = masks.addProperty("ADBE Mask Atom");
    var path = new Shape();
    path.vertices = spec.vertices;
    path.inTangents = spec.inTangents;
    path.outTangents = spec.outTangents;
    path.closed = spec.closed;
    mask.property("ADBE Mask Shape").setValue(path);
    mask.maskMode = MaskMode.ADD;
    mask.name = "overflow";
  } catch (e) {
    D2AE.note("clip mask on " + layer.name + " failed: " + e.toString());
  }
};

// --- clip-path --------------------------------------------------------------
// A clip-path arrives as Slider Controls on the clipping layer ("Clip Left",
// "Clip Top", ...) plus a mask on every layer it cuts. A mask builds its path
// from the sliders with an expression; members map the clipper's region into
// their own space through toComp/fromComp, so a child moving under a fixed
// clip stays clipped.

D2AE.q = function (str) {
  return "\"" + String(str).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"";
};

D2AE.addClipSliders = function (layer, clip) {
  var j, fx;
  if (!clip.animated || !clip.tracks) return;
  try {
    for (j = 0; j < clip.names.length; j += 1) {
      fx = layer.property("ADBE Effect Parade").addProperty("ADBE Slider Control");
      fx.name = clip.names[j];
      D2AE.applyTrack(fx.property("ADBE Slider Control-0001"), clip.tracks[j]);
    }
  } catch (e) {
    D2AE.note("clip sliders on " + layer.name + " failed: " + e.toString());
  }
};

D2AE.clipExpression = function (clip, self) {
  var j, vals = [];
  var src = [];
  src.push(self ? "var c = thisLayer;" : "var c = thisComp.layer(" + D2AE.q(clip.clipper) + ");");
  for (j = 0; j < clip.names.length; j += 1) {
    if (clip.animated) vals.push("c.effect(" + D2AE.q(clip.names[j]) + ")(\"Slider\")");
    else vals.push(String(clip.statics[j]));
  }
  src.push("var v = [" + vals.join(", ") + "];");
  src.push("var OX = " + clip.off[0] + ", OY = " + clip.off[1] + ", SX = " + clip.scale[0] + ", SY = " + clip.scale[1] + ";");
  src.push("function L(x, y) { return [(x - OX) / SX, (y - OY) / SY]; }");
  src.push(self ? "function P(x, y) { return L(x, y); }" : "function P(x, y) { return fromComp(c.toComp(L(x, y))); }");
  src.push("function T(x, y, dx, dy) { return sub(P(x + dx, y + dy), P(x, y)); }");
  src.push("var Z = [0, 0], K = 0.5522847498307936;");
  if (clip.shape === "inset") {
    src.push("var l = v[0], t = v[1], r = v[2], b = v[3];");
    src.push("var k = Math.max(0, Math.min(v[4], (r - l) / 2, (b - t) / 2)), q = k * K;");
    src.push("if (k < 0.01) { createPath([P(l, t), P(r, t), P(r, b), P(l, b)], [], [], true); } else {");
    src.push("createPath([P(l + k, t), P(r - k, t), P(r, t + k), P(r, b - k), P(r - k, b), P(l + k, b), P(l, b - k), P(l, t + k)],");
    src.push("[T(l + k, t, -q, 0), Z, T(r, t + k, 0, -q), Z, T(r - k, b, q, 0), Z, T(l, b - k, 0, q), Z],");
    src.push("[Z, T(r - k, t, q, 0), Z, T(r, b - k, 0, q), Z, T(l + k, b, -q, 0), Z, T(l, t + k, 0, -q)], true); }");
  } else if (clip.shape === "ellipse") {
    src.push("var cx = v[0], cy = v[1], rx = v[2], ry = v[3], qx = rx * K, qy = ry * K;");
    src.push("createPath([P(cx, cy - ry), P(cx + rx, cy), P(cx, cy + ry), P(cx - rx, cy)],");
    src.push("[T(cx, cy - ry, -qx, 0), T(cx + rx, cy, 0, -qy), T(cx, cy + ry, qx, 0), T(cx - rx, cy, 0, qy)],");
    src.push("[T(cx, cy - ry, qx, 0), T(cx + rx, cy, 0, qy), T(cx, cy + ry, -qx, 0), T(cx - rx, cy, 0, -qy)], true);");
  } else {
    src.push("var pts = []; for (var i = 0; i + 1 < v.length; i += 2) pts.push(P(v[i], v[i + 1]));");
    src.push("createPath(pts, [], [], true);");
  }
  return src.join("\n");
};

D2AE.addClipMask = function (layer, clip, self) {
  try {
    var masks = layer.property("ADBE Mask Parade");
    var had = masks.numProperties > 0;
    var mask = masks.addProperty("ADBE Mask Atom");
    mask.name = "clip-path";
    mask.maskMode = had ? MaskMode.INTERSECT : MaskMode.ADD;
    var prop = mask.property("ADBE Mask Shape");
    if (self && clip.path) {
      var shape = new Shape();
      shape.vertices = clip.path.vertices;
      shape.inTangents = clip.path.inTangents;
      shape.outTangents = clip.path.outTangents;
      shape.closed = true;
      prop.setValue(shape);
      return;
    }
    prop.expression = D2AE.clipExpression(clip, self);
  } catch (e) {
    D2AE.note("clip mask on " + layer.name + " failed: " + e.toString());
  }
};

D2AE.applyTransform = function (layer, t, separate) {
  var tr = layer.transform;
  if (t.threeD) layer.threeDLayer = true;
  D2AE.applyTrack(tr.anchorPoint, t.anchorPoint);

  var usedSeparated = false;
  if (separate && t.positionSeparated) {
    try {
      tr.position.dimensionsSeparated = true;
      D2AE.applyTrack(tr.property("ADBE Position_0"), t.positionSeparated[0]);
      D2AE.applyTrack(tr.property("ADBE Position_1"), t.positionSeparated[1]);
      if (t.threeD && t.positionSeparated.length > 2) {
        D2AE.applyTrack(tr.property("ADBE Position_2"), t.positionSeparated[2]);
      }
      usedSeparated = true;
    } catch (e) {
      D2AE.note("separated position unavailable, using unified: " + e.toString());
    }
  }
  if (!usedSeparated) D2AE.applyTrack(tr.position, t.position);

  D2AE.applyTrack(tr.scale, t.scale);
  D2AE.applyTrack(tr.opacity, t.opacity);
  if (t.threeD && t.rotationXYZ) {
    // Orientation is deliberately left at zero -- see the note in the emitter.
    D2AE.applyTrack(tr.xRotation, t.rotationXYZ[0]);
    D2AE.applyTrack(tr.yRotation, t.rotationXYZ[1]);
    D2AE.applyTrack(tr.zRotation, t.rotationXYZ[2]);
  } else if (t.rotation) {
    D2AE.applyTrack(tr.rotation, t.rotation);
  }
};

// A looping animation carries one cycle of keyframes; loopOut repeats it for as
// long as the comp runs. Applied only to properties that actually have two or
// more keyframes -- loopOut on a constant is an error, and on a single keyframe
// it does nothing but clutter the timeline.
D2AE.applyLoop = function (layer) {
  var applied = 0;
  var walk = function (group) {
    var i;
    for (i = 1; i <= group.numProperties; i += 1) {
      var prop = group.property(i);
      try {
        if (prop.numProperties !== undefined && prop.numProperties > 0) { walk(prop); continue; }
        if (!prop.canSetExpression || prop.numKeys < 2) continue;
        prop.expression = 'loopOut("cycle")';
        applied += 1;
      } catch (e) { /* not every property accepts an expression */ }
    }
  };
  try { walk(layer.property("ADBE Transform Group")); } catch (e) {}
  try { walk(layer.property("ADBE Effect Parade")); } catch (e) {}
  try { walk(layer.property("ADBE Root Vectors Group")); } catch (e) {}
  if (!applied) D2AE.note("loop requested on " + layer.name + " but no keyframed property took an expression");
  return applied;
};

D2AE.applyEffects = function (layer, effects) {
  var i, spec, parade, fx;
  parade = layer.property("ADBE Effect Parade");
  for (i = 0; i < effects.length; i += 1) {
    spec = effects[i];
    try {
      if (spec.type === "gaussianBlur") {
        fx = parade.addProperty("ADBE Gaussian Blur 2");
        D2AE.applyTrack(fx.property("ADBE Gaussian Blur 2-0001"), spec.params.blurriness);
        // Repeat Edge Pixels must stay OFF. CSS filter: blur() fades an
        // element's edges outward; repeating edge pixels holds them hard, and on
        // a flat-coloured box that makes the whole effect a no-op -- the layer
        // renders identically to an unblurred one, which looks like the effect
        // was never applied at all.
        try { fx.property("ADBE Gaussian Blur 2-0003").setValue(false); } catch (e) {}
      } else if (spec.type === "brightness") {
        fx = parade.addProperty("ADBE Brightness & Contrast 2");
        D2AE.applyTrack(fx.property("ADBE Brightness & Contrast 2-0001"), spec.params.amount);
      } else if (spec.type === "dropShadow") {
        fx = parade.addProperty("ADBE Drop Shadow");
        fx.property("ADBE Drop Shadow-0001").setValue([
          spec.params.color[0] / 255, spec.params.color[1] / 255, spec.params.color[2] / 255, 1]);
        fx.property("ADBE Drop Shadow-0002").setValue(spec.params.alpha * 255);
        fx.property("ADBE Drop Shadow-0003").setValue(spec.params.direction);
        fx.property("ADBE Drop Shadow-0004").setValue(spec.params.distance);
        fx.property("ADBE Drop Shadow-0005").setValue(spec.params.softness);
      } else if (spec.type === "tile") {
        // Motion Tile. Verified match names rather than guessed ones:
        //   -0001 Tile Center   -0002 Tile Width   -0003 Tile Height
        //   -0004 Output Width  -0005 Output Height
        // Mirror Edges must stay OFF: CSS repeats a background, it never
        // flips alternate tiles, and mirrored edges look plausible enough to
        // be missed while being wrong on every second tile.
        fx = parade.addProperty("ADBE Tile");
        fx.property("ADBE Tile-0001").setValue(spec.params.center);
        fx.property("ADBE Tile-0002").setValue(spec.params.tileWidth);
        fx.property("ADBE Tile-0003").setValue(spec.params.tileHeight);
        fx.property("ADBE Tile-0004").setValue(spec.params.outputWidth);
        fx.property("ADBE Tile-0005").setValue(spec.params.outputHeight);
        try { fx.property("ADBE Tile-0006").setValue(0); } catch (e) {}
      } else if (spec.type === "skew") {
        // Match names, verified by enumeration rather than guessed:
        //   -0001 Anchor Point   -0002 Position   -0005 Skew
        //   -0006 Skew Axis      -0007 ROTATION
        // Writing the skew angle to -0007 rotates the layer instead of shearing
        // it, which is a silent and very confusing failure.
        fx = parade.addProperty("ADBE Geometry2");
        if (spec.params.anchor) {
          fx.property("ADBE Geometry2-0001").setValue(spec.params.anchor);
          fx.property("ADBE Geometry2-0002").setValue(spec.params.anchor);
        }
        D2AE.applyTrack(fx.property("ADBE Geometry2-0005"), spec.params.skew);
      }
    } catch (e) {
      D2AE.note("effect " + spec.type + " failed: " + e.toString());
    }
  }
};

// Import each asset once and hand back a map of id -> FootageItem.
//
// The path is resolved relative to the script first, so a generated .jsx and its
// assets folder can be moved together, and only then against the absolute path
// recorded at generation time.
D2AE.importAssets = function (project, assets) {
  var byId = {};
  var i;
  var scriptDir = null;
  try { scriptDir = new File($.fileName).parent; } catch (e) {}
  for (i = 0; i < (assets || []).length; i += 1) {
    var spec = assets[i];
    var file = null;
    if (scriptDir && spec.relative) {
      var near = new File(scriptDir.fsName + "/" + spec.relative);
      if (near.exists) file = near;
    }
    if (!file && spec.file) {
      var abs = new File(spec.file);
      if (abs.exists) file = abs;
    }
    if (!file) { D2AE.note("asset not found: " + (spec.relative || spec.file)); continue; }
    try {
      var io = new ImportOptions(file);
      io.importAs = ImportAsType.FOOTAGE;
      // A rasterised canvas arrives as a numbered PNG sequence, which After
      // Effects imports as ONE footage item when told to. Its frame rate has to
      // be conformed to the comp's, or the sequence plays at the project
      // default and the animation drifts out of time.
      if (spec.sequence) io.sequence = true;
      var item = project.importFile(io);
      item.name = spec.id;
      if (spec.sequence) {
        try { item.mainSource.conformFrameRate = spec.fps; } catch (e2) {
          D2AE.note("could not conform " + spec.id + " to " + spec.fps + "fps: " + e2.toString());
        }
      }
      byId[spec.id] = item;
    } catch (e) {
      D2AE.note("could not import " + file.fsName + ": " + e.toString());
    }
  }
  return byId;
};

D2AE.build = function (data) {
  var project = app.project;
  if (!project) project = app.newProject();

  var check = D2AE.verifyCoordinateModel(project);
  if (!check.ok) {
    throw new Error("This After Effects build does not match the coordinate model the " +
      "importer was written against, so the comp would be wrong everywhere. " + check.detail);
  }
  D2AE.note("coordinate self-check passed (" + check.detail + ")");

  var rootSpec = null;
  var ri;
  for (ri = 0; ri < data.comps.length; ri += 1) {
    if (data.comps[ri].id === data.rootCompId) rootSpec = data.comps[ri];
  }
  var assetFps = rootSpec ? rootSpec.fps : 30;
  var ai;
  for (ai = 0; ai < (data.assets || []).length; ai += 1) data.assets[ai].fps = assetFps;
  var assetItems = D2AE.importAssets(project, data.assets);

  // Compositions arrive in dependency order: a perspective precomp is built
  // before the composition that places it.
  var byCompId = {};
  var rootComp = null;
  var i;
  for (i = 0; i < data.comps.length; i += 1) {
    var built = D2AE.buildComp(project, data.comps[i], data, byCompId, assetItems);
    byCompId[data.comps[i].id] = built;
    if (data.comps[i].id === data.rootCompId) rootComp = built;
  }
  if (!rootComp) rootComp = byCompId[data.comps[data.comps.length - 1].id];
  D2AE.lastComps = byCompId;
  try { rootComp.openInViewer(); } catch (e) {}
  return rootComp;
};

D2AE.buildComp = function (project, spec, data, byCompId, assetItems) {
  var i, L, layer, rec, child, parent;
  var comp = project.items.addComp(spec.name, spec.width, spec.height, 1, spec.duration, spec.fps);
  comp.bgColor = [spec.bg[0] / 255, spec.bg[1] / 255, spec.bg[2] / 255];

  // A camera, when this composition carries a CSS perspective.
  //
  // It goes at the COMP CENTRE. After Effects maps the camera's own (x, y) to
  // the centre of the composition, so a camera parked anywhere else drags the
  // whole 3D scene by (cameraXY - compCentre). And because AE's vanishing point
  // IS the comp centre, a composition is built for this subtree whose centre is
  // the CSS perspective-origin -- which is what makes the two models agree.
  var cam = null;
  if (spec.camera) {
    try {
      var cx = spec.width / 2;
      var cy = spec.height / 2;
      cam = comp.layers.addCamera(spec.camera.name, [cx, cy]);
      cam.property("ADBE Transform Group").property("ADBE Position")
        .setValue([cx, cy, -spec.camera.zoom]);
      cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom")
        .setValue(spec.camera.zoom);
      D2AE.note("camera for CSS perspective " + Math.round(spec.camera.zoom) + "px in " + spec.name);
    } catch (e) { D2AE.note("camera: " + e.toString()); }
  }

  var byId = {};
  // PASS 1 -- create every layer, with no transform values yet.
  //
  // Order reproduces CSS paint order. comp.layers.add*() inserts at the TOP of
  // the stack, and CSS paints later elements over earlier ones, so iterating
  // FORWARD leaves spec.layers[0] at the bottom -- which is where the document
  // root belongs. Iterating backwards puts the page background on top and
  // renders a comp that is a single flat rectangle.
  for (i = 0; i < spec.layers.length; i += 1) {
    L = spec.layers[i];
    if (L.kind === "precomp") {
      var source = byCompId[L.compId];
      if (!source) { D2AE.note("missing precomp " + L.compId); continue; }
      layer = comp.layers.add(source);
    } else if (L.kind === "shape" || L.kind === "path" || L.kind === "raster") {
      layer = comp.layers.addShape();
      if (L.kind === "shape" && L.shape) D2AE.addRect(layer, L.shape);
      else if (L.kind === "path" && L.path) D2AE.addPath(layer, L.path);
    } else if (L.kind === "image" && L.image && assetItems && assetItems[L.image.assetId]) {
      layer = comp.layers.add(assetItems[L.image.assetId]);
    } else if (L.kind === "text") {
      layer = comp.layers.addText(L.text.value);
      D2AE.styleText(layer, L.text);
      if (L.stagger) D2AE.applyStagger(layer, L.stagger);
    } else {
      layer = comp.layers.addNull();
      layer.guideLayer = true;
    }
    layer.name = L.name;
    byId[L.id] = layer;
    if (L.comment) layer.comment = L.comment;
  }

  // PASS 2 -- parenting, BEFORE any transform value is written.
  //
  // Order matters here, and getting it wrong is silent. Assigning .parent
  // makes After Effects REWRITE the child's Position so the layer does not move
  // on screen: parent a null at [10,20] to a null at [100,50] rotated 90 and
  // scaled 200%, and the child's Position becomes [-15,45] while it stays put.
  // Our positions are already expressed in the parent's space, so that
  // compensation is exactly wrong -- it would cancel the parent's transform out
  // of every nested layer in the comp.
  for (i = 0; i < spec.layers.length; i += 1) {
    rec = spec.layers[i];
    if (rec.parentId === null || rec.parentId === undefined) continue;
    child = byId[rec.id];
    parent = byId[rec.parentId];
    if (!child || !parent) continue;
    try {
      if (typeof child.setParentWithJump === "function") child.setParentWithJump(parent);
      else child.parent = parent;
    } catch (e) {
      try { child.parent = parent; }
      catch (e2) { D2AE.note("could not parent " + rec.name + ": " + e2.toString()); }
    }
  }

  // PASS 3 -- transforms, effects and blend modes.
  for (i = 0; i < spec.layers.length; i += 1) {
    rec = spec.layers[i];
    layer = byId[rec.id];
    if (!layer) continue;
    D2AE.applyTransform(layer, rec.transform, data.separatePosition);
    if (rec.mask) D2AE.applyMask(layer, rec.mask);
    if (rec.effects && rec.effects.length) D2AE.applyEffects(layer, rec.effects);
    if (rec.loop) D2AE.applyLoop(layer);
    if (rec.blendMode) { try { layer.blendingMode = BlendingMode[rec.blendMode]; } catch (e) {} }
  }

  // PASS 3b -- clip-path. Sliders first, on every clipping layer, so no mask
  // expression ever points at a slider that does not exist yet.
  for (i = 0; i < spec.layers.length; i += 1) {
    rec = spec.layers[i];
    layer = byId[rec.id];
    if (layer && rec.clip) D2AE.addClipSliders(layer, rec.clip);
  }
  for (i = 0; i < spec.layers.length; i += 1) {
    rec = spec.layers[i];
    layer = byId[rec.id];
    if (!layer) continue;
    if (rec.clip && rec.clip.role === "self") D2AE.addClipMask(layer, rec.clip, true);
    if (rec.clipBy) D2AE.addClipMask(layer, rec.clipBy, false);
  }

  // PASS 4 -- in/out points last: AE's own bookkeeping can narrow them when a
  // parent's interval changes, so they have to outlive parenting.
  for (i = 0; i < spec.layers.length; i += 1) {
    rec = spec.layers[i];
    layer = byId[rec.id];
    if (!layer) continue;
    try {
      if (rec.inPoint !== null && rec.inPoint !== undefined) layer.inPoint = rec.inPoint;
      if (rec.outPoint !== null && rec.outPoint !== undefined) {
        layer.outPoint = Math.min(spec.duration, rec.outPoint + 1 / spec.fps);
      }
    } catch (e) { D2AE.note("in/out point on " + rec.name + ": " + e.toString()); }
  }

  // A camera only renders the 3D layers BELOW it, and every add*() call above
  // inserted at the top -- so it has to be lifted back to the top now.
  if (cam) {
    try { cam.moveToBeginning(); } catch (e) { D2AE.note("camera could not be moved to the top: " + e.toString()); }
  }

  return comp;
};
`;
