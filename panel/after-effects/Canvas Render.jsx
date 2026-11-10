// Canvas Render for After Effects
//
// Converts Claude Design exports and HTML animations into editable After
// Effects comps (shape, text and null layers with keyframes) through the
// Canvas Render app, and imports the result.
//
// Install: copy this file into
//   /Applications/Adobe After Effects <version>/Scripts/ScriptUI Panels/
// restart After Effects, then open Window > Canvas Render.jsx.
// It also runs from File > Scripts > Run Script File as a floating window.
//
// Needs: the Canvas Render app running, and in After Effects
//   Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network
// because requests go to the app as small files in its mailbox folder.

function CRJSONParse(text) {
  var at = 0;
  var ch = ' ';

  function error(m) { throw new Error("payload is not valid JSON: " + m + " at character " + at); }
  function next(expected) {
    if (expected && expected !== ch) error("expected '" + expected + "' but found '" + ch + "'");
    ch = at < text.length ? text.charAt(at) : '';
    at += 1;
    return ch;
  }
  function white() { while (ch && ch <= ' ') next(); }
  function word() {
    if (ch === 't') { next('t'); next('r'); next('u'); next('e'); return true; }
    if (ch === 'f') { next('f'); next('a'); next('l'); next('s'); next('e'); return false; }
    if (ch === 'n') { next('n'); next('u'); next('l'); next('l'); return null; }
    error("unexpected '" + ch + "'");
    return null;
  }
  function number() {
    var s = '';
    if (ch === '-') { s = '-'; next('-'); }
    while (ch >= '0' && ch <= '9') { s += ch; next(); }
    if (ch === '.') { s += '.'; while (next() && ch >= '0' && ch <= '9') s += ch; }
    if (ch === 'e' || ch === 'E') {
      s += ch; next();
      if (ch === '-' || ch === '+') { s += ch; next(); }
      while (ch >= '0' && ch <= '9') { s += ch; next(); }
    }
    var n = Number(s);
    if (isNaN(n)) error("bad number '" + s + "'");
    return n;
  }
  var ESC = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  function string() {
    var s = '', hex, i, uffff;
    if (ch !== '"') error("expected a string");
    while (next()) {
      if (ch === '"') { next(); return s; }
      if (ch === '\\') {
        next();
        if (ch === 'u') {
          uffff = 0;
          for (i = 0; i < 4; i += 1) {
            hex = parseInt(next(), 16);
            if (!isFinite(hex)) break;
            uffff = uffff * 16 + hex;
          }
          s += String.fromCharCode(uffff);
        } else if (typeof ESC[ch] === 'string') { s += ESC[ch]; }
        else break;
      } else { s += ch; }
    }
    error("unterminated string");
    return s;
  }
  function value() {
    white();
    if (ch === '{') {
      var obj = {}, key;
      next('{'); white();
      if (ch === '}') { next('}'); return obj; }
      while (ch) {
        key = string(); white(); next(':');
        obj[key] = value();
        white();
        if (ch === '}') { next('}'); return obj; }
        next(','); white();
      }
    }
    if (ch === '[') {
      var arr = [];
      next('['); white();
      if (ch === ']') { next(']'); return arr; }
      while (ch) {
        arr.push(value());
        white();
        if (ch === ']') { next(']'); return arr; }
        next(','); white();
      }
    }
    if (ch === '"') return string();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return number();
    return word();
  }
  var result = value();
  white();
  if (ch) error("trailing content");
  return result;
}

(function (thisObj) {
  var CR = {};
  $.global.CanvasRenderPanel = CR;

  // --- files ---------------------------------------------------------------
  CR.root = new Folder(Folder.userData.fsName + "/Canvas Render/mailbox");
  CR.inbox = new Folder(CR.root.fsName + "/inbox");
  CR.outbox = new Folder(CR.root.fsName + "/outbox");

  CR.quote = function (s) {
    var out = '"', i, c, code;
    s = String(s);
    for (i = 0; i < s.length; i += 1) {
      c = s.charAt(i); code = s.charCodeAt(i);
      if (c === '"' || c === '\\') out += '\\' + c;
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (code < 32) out += '\\u' + ('0000' + code.toString(16)).slice(-4);
      else out += c;
    }
    return out + '"';
  };

  CR.stringify = function (v) {
    var parts = [], k, i;
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return CR.quote(v);
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v instanceof Array) {
      for (i = 0; i < v.length; i += 1) parts.push(CR.stringify(v[i]));
      return '[' + parts.join(',') + ']';
    }
    for (k in v) if (v.hasOwnProperty(k)) parts.push(CR.quote(k) + ':' + CR.stringify(v[k]));
    return '{' + parts.join(',') + '}';
  };

  CR.read = function (file) {
    if (!file.exists) return null;
    file.encoding = "UTF-8";
    if (!file.open("r")) return null;
    var text = file.read();
    file.close();
    try { return CRJSONParse(text); } catch (e) { return null; } // mid-write: try again next tick
  };

  CR.write = function (file, value) {
    var tmp = new File(file.fsName + ".part");
    tmp.encoding = "UTF-8";
    if (!tmp.open("w")) throw new Error("cannot write " + tmp.fsName);
    tmp.write(CR.stringify(value));
    tmp.close();
    if (file.exists) file.remove();
    if (!tmp.rename(file.name)) throw new Error("cannot finish " + file.fsName);
  };

  CR.canWrite = function () {
    try {
      if (!CR.inbox.exists && !CR.inbox.create()) return false;
      var probe = new File(CR.root.fsName + "/ae-panel-probe.txt");
      if (!probe.open("w")) return false;
      probe.write("ok"); probe.close(); probe.remove();
      return true;
    } catch (e) { return false; }
  };

  CR.engine = function () {
    var e = CR.read(new File(CR.root.fsName + "/engine.json"));
    if (!e || !e.updatedAt) return null;
    return (new Date().getTime() - e.updatedAt) < 10000 ? e : null;
  };

  CR.newId = function () {
    return "ae-" + new Date().getTime() + "-" + Math.floor(Math.random() * 1e6);
  };

  CR.send = function (req) {
    req.id = req.id || CR.newId();
    CR.write(new File(CR.inbox.fsName + "/" + req.id + ".json"), req);
    return req.id;
  };

  // --- import ----------------------------------------------------------------
  CR.importScript = function (path) {
    var f = new File(path);
    if (!f.exists) { CR.say("Not found: " + path); return false; }
    $.global.D2AE_SILENT = true;
    $.global.D2AE_LAST = "";
    try {
      $.evalFile(f);
    } catch (e) {
      CR.say("Import failed: " + e.toString());
      return false;
    } finally {
      $.global.D2AE_SILENT = false;
    }
    CR.say($.global.D2AE_LAST || ("Imported " + f.displayName));
    return true;
  };

  // --- polling -----------------------------------------------------------------
  CR.task = null;
  CR.waiting = null; // { id, kind: 'analyze' | 'render' }

  CR.watch = function (id, kind) {
    CR.waiting = { id: id, kind: kind, since: new Date().getTime() };
    if (CR.task === null) CR.task = app.scheduleTask("CanvasRenderPanel.poll()", 400, true);
  };

  CR.stopWatching = function () {
    if (CR.task !== null) { try { app.cancelTask(CR.task); } catch (e) {} }
    CR.task = null;
    CR.waiting = null;
    CR.ui.cancel.enabled = false;
    CR.refreshButtons();
  };

  CR.phase = { capturing: "Measuring", building: "Building layers", isolating: "Rendering raster layers", writing: "Writing the script", rendering: "Rendering" };

  CR.poll = function () {
    var w = CR.waiting, st, i, j, line, pr, imported = 0;
    if (!w) { CR.stopWatching(); return; }
    st = CR.read(new File(CR.outbox.fsName + "/" + w.id + ".json"));
    if (!st) {
      if (new Date().getTime() - w.since > 15000 && !CR.engine()) { CR.say("Canvas Render is not answering. Open the app and try again."); CR.stopWatching(); }
      return;
    }
    if (st.state === "error") { CR.say(st.message || "That did not work."); CR.stopWatching(); return; }
    if (w.kind === "analyze") {
      if (st.state !== "done") { CR.say(st.message || "Opening…"); return; }
      CR.stopWatching();
      CR.showScenes(st.project);
      return;
    }
    // render
    line = [];
    for (i = 0; i < (st.jobs || []).length; i += 1) {
      j = st.jobs[i]; pr = j.progress || {};
      if (j.status === "rendering") line.push(j.sceneName + ": " + (CR.phase[pr.phase] || "Working") + (pr.total ? " " + pr.done + " of " + pr.total : ""));
    }
    if (st.state !== "done" && st.state !== "cancelled") { CR.say(line.length ? line.join("\n") : (st.message || "Queued")); return; }
    CR.stopWatching();
    if (st.state === "cancelled") { CR.say("Cancelled."); return; }
    app.beginUndoGroup("Import from Canvas Render");
    try {
      var notes = [];
      for (i = 0; i < st.jobs.length; i += 1) {
        j = st.jobs[i];
        if (j.status === "done" && j.result && j.result.file) {
          if (CR.importScript(j.result.file)) { imported += 1; notes.push($.global.D2AE_LAST || j.sceneName); }
        } else if (j.status === "error") notes.push(j.sceneName + ": " + (j.error || "failed"));
      }
      CR.say("Imported " + imported + " scene" + (imported === 1 ? "" : "s") + ".\n\n" + notes.join("\n\n"));
    } finally {
      app.endUndoGroup();
    }
    CR.loadRecent();
  };

  // --- actions ---------------------------------------------------------------------
  CR.input = null;
  CR.scenes = [];

  CR.choose = function () {
    var filter = ($.os.indexOf("Windows") !== -1) ? "Claude Design export:*.zip;*.html;*.htm" : function (f) {
      return f instanceof Folder || /\.(zip|html?)$/i.test(f.name);
    };
    var f = File.openDialog("Choose a Claude Design export or HTML animation", filter, false);
    if (!f) return;
    if (!CR.ready()) return;
    CR.input = f.fsName;
    CR.ui.file.text = f.displayName;
    CR.ui.list.removeAll();
    CR.say("Opening " + f.displayName + "…");
    CR.watch(CR.send({ action: "analyze", input: CR.input }), "analyze");
    CR.refreshButtons();
  };

  CR.showScenes = function (project) {
    var i, s, item, usable = 0;
    CR.scenes = [];
    CR.ui.list.removeAll();
    for (i = 0; i < ((project && project.scenes) || []).length; i += 1) {
      s = project.scenes[i];
      if (!s.info || s.error || s.empty) continue;
      CR.scenes.push(s);
      item = CR.ui.list.add("item", s.name);
      item.subItems[0].text = s.info.width + " x " + s.info.height + ", " + Math.round(s.info.duration * 10) / 10 + " s";
      if (s.selected) item.selected = true;
      usable += 1;
    }
    CR.say(usable ? "Pick the scenes to convert." : "Nothing in that file can be converted.");
    CR.refreshButtons();
  };

  CR.convert = function () {
    var names = [], i, sel = CR.ui.list.selection;
    if (!CR.input || !sel || !CR.ready()) return;
    if (typeof sel.length !== "number") sel = [sel]; // one ListItem, or an array of them
    for (i = 0; i < sel.length; i += 1) names.push(CR.scenes[sel[i].index].name);
    var settings = { format: "ae", aeFallbacks: CR.ui.exact.value ? ["gradients"] : [] };
    var rate = CR.ui.rate.selection ? CR.ui.rate.selection.text : null;
    if (rate && rate !== "From the app") settings.rate = rate;
    CR.say("Sending " + names.length + " scene" + (names.length === 1 ? "" : "s") + " to Canvas Render…");
    CR.watch(CR.send({ action: "render", input: CR.input, scenes: names, settings: settings }), "render");
    CR.ui.cancel.enabled = true;
    CR.refreshButtons();
  };

  CR.cancel = function () {
    if (CR.waiting) CR.send({ action: "cancel", target: CR.waiting.id });
    CR.say("Cancelling…");
  };

  CR.ready = function () {
    if (!CR.canWrite()) {
      CR.say("After Effects is not letting scripts write files. Turn on Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network, then try again.");
      return false;
    }
    if (!CR.engine()) { CR.say("Open the Canvas Render app first; this panel sends it the work."); return false; }
    return true;
  };

  CR.recent = [];
  CR.loadRecent = function () {
    var data = CR.read(new File(CR.root.fsName + "/ae-recent.json")), i, r, item, when;
    CR.recent = (data && data.items) || [];
    CR.ui.recent.removeAll();
    for (i = 0; i < CR.recent.length; i += 1) {
      r = CR.recent[i];
      item = CR.ui.recent.add("item", r.scene);
      when = new Date(r.at);
      item.subItems[0].text = r.layers + " layers, " + (when.getMonth() + 1) + "/" + when.getDate() + " " + when.getHours() + ":" + ("0" + when.getMinutes()).slice(-2);
    }
    CR.refreshButtons();
  };

  CR.importRecent = function () {
    var sel = CR.ui.recent.selection;
    if (!sel) return;
    app.beginUndoGroup("Import from Canvas Render");
    try { CR.importScript(CR.recent[sel.index].file); } finally { app.endUndoGroup(); }
  };

  CR.importFile = function () {
    var f = File.openDialog("Choose a Canvas Render .jsx", ($.os.indexOf("Windows") !== -1) ? "After Effects script:*.jsx" : function (x) {
      return x instanceof Folder || /\.jsx$/i.test(x.name);
    }, false);
    if (!f) return;
    app.beginUndoGroup("Import from Canvas Render");
    try { CR.importScript(f.fsName); } finally { app.endUndoGroup(); }
  };

  CR.say = function (text) { CR.ui.status.text = String(text); };

  CR.refreshButtons = function () {
    var busy = !!CR.waiting;
    CR.ui.choose.enabled = !busy;
    CR.ui.convert.enabled = !busy && !!CR.ui.list.selection;
    CR.ui.importRecent.enabled = !busy && !!CR.ui.recent.selection;
    CR.ui.status.parent.layout.layout(true);
  };

  // --- UI ----------------------------------------------------------------------------
  var w = (thisObj instanceof Panel) ? thisObj : new Window("palette", "Canvas Render", undefined, { resizeable: true });
  w.orientation = "column";
  w.alignChildren = ["fill", "top"];
  w.spacing = 8;
  w.margins = 10;
  CR.ui = {};

  var top = w.add("group");
  top.orientation = "row"; top.alignChildren = ["fill", "center"];
  CR.ui.choose = top.add("button", undefined, "Choose export…");
  CR.ui.file = top.add("statictext", undefined, "No file chosen");
  CR.ui.file.alignment = ["fill", "center"];

  CR.ui.list = w.add("listbox", undefined, [], { multiselect: true, numberOfColumns: 2, showHeaders: true, columnTitles: ["Scene", "Size"], columnWidths: [170, 120] });
  CR.ui.list.preferredSize = [300, 120];

  var opts = w.add("group");
  opts.orientation = "row"; opts.alignChildren = ["left", "center"];
  CR.ui.exact = opts.add("checkbox", undefined, "Exact gradients");
  CR.ui.exact.helpTip = "Gradients with three or more stops come in as bitmaps instead of editable two-stop ramps.";
  opts.add("statictext", undefined, "Rate");
  CR.ui.rate = opts.add("dropdownlist", undefined, ["From the app", "23.976", "24", "25", "29.97", "30", "50", "59.94", "60"]);
  CR.ui.rate.selection = 0;

  var go = w.add("group");
  go.orientation = "row";
  CR.ui.convert = go.add("button", undefined, "Convert and import");
  CR.ui.cancel = go.add("button", undefined, "Cancel");
  CR.ui.cancel.enabled = false;

  CR.ui.status = w.add("statictext", undefined, "", { multiline: true });
  CR.ui.status.preferredSize = [300, 64];
  CR.ui.status.alignment = ["fill", "top"];

  var rp = w.add("panel", undefined, "Recent conversions");
  rp.alignChildren = ["fill", "top"];
  CR.ui.recent = rp.add("listbox", undefined, [], { numberOfColumns: 2, showHeaders: false, columnWidths: [170, 120] });
  CR.ui.recent.preferredSize = [300, 100];
  var rb = rp.add("group");
  CR.ui.importRecent = rb.add("button", undefined, "Import");
  CR.ui.importOther = rb.add("button", undefined, "Import a .jsx…");
  CR.ui.refresh = rb.add("button", undefined, "Refresh");

  CR.ui.choose.onClick = CR.choose;
  CR.ui.convert.onClick = CR.convert;
  CR.ui.cancel.onClick = CR.cancel;
  CR.ui.list.onChange = CR.refreshButtons;
  CR.ui.recent.onChange = CR.refreshButtons;
  CR.ui.recent.onDoubleClick = CR.importRecent;
  CR.ui.importRecent.onClick = CR.importRecent;
  CR.ui.importOther.onClick = CR.importFile;
  CR.ui.refresh.onClick = CR.loadRecent;

  w.onResizing = w.onResize = function () { this.layout.resize(); };
  CR.loadRecent();
  CR.say(CR.engine() ? "Canvas Render is running. Choose an export to convert." : "Open the Canvas Render app to convert. You can still import earlier conversions below.");
  if (w instanceof Window) { w.center(); w.show(); } else { w.layout.layout(true); }
})(this);
