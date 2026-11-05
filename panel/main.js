// Canvas Render panel for Premiere Pro.
//
// Premiere blocks plain http:// from panels on macOS, so this panel never
// talks to the app over the network. It drops a request file into the app's
// mailbox folder and reads progress back from a status file:
//
//   ~/Library/Application Support/Canvas Render/mailbox/inbox/<id>.json
//   ~/Library/Application Support/Canvas Render/mailbox/outbox/<id>.json
//
// When the renders finish it imports them into a bin, as clips or as a
// sequence built from the timeline XML.

(function () {
  var fs = require("fs");
  var os = require("os");
  var uxp = require("uxp");
  var ppro = null;
  try { ppro = require("premierepro"); } catch (error) { ppro = null; }

  var WIN = os.platform() === "win32";
  var HOME = os.homedir();
  var DATA = WIN
    ? HOME + "\\AppData\\Roaming\\Canvas Render"
    : HOME + "/Library/Application Support/Canvas Render";
  var BOX = DATA + (WIN ? "\\mailbox" : "/mailbox");
  var SEP = WIN ? "\\" : "/";

  var state = {
    engine: null,
    input: null,
    project: null,
    sceneChoice: {},
    requestId: null,
    polling: null,
    imported: false,
    busy: false,
  };

  // ---------- small helpers ----------
  function $(id) { return document.getElementById(id); }
  function join() { return Array.prototype.slice.call(arguments).join(SEP); }
  function fileUrl(p) { return "file:" + p; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function errorText(error) { return error && error.message ? error.message : String(error); }
  function baseName(p) { return String(p).split(/[\\/]/).pop(); }
  function dirName(p) { var parts = String(p).split(/[\\/]/); parts.pop(); return parts.join(SEP); }

  async function readJson(p) {
    try { return JSON.parse(await fs.readFile(fileUrl(p), { encoding: "utf-8" })); } catch (error) { return null; }
  }

  async function writeJson(p, value) {
    var part = p + ".part";
    await fs.writeFile(fileUrl(part), JSON.stringify(value), { encoding: "utf-8" });
    await fs.rename(fileUrl(part), fileUrl(p));
  }

  function say(text, isError) {
    var m = $("message");
    m.textContent = text || "";
    m.className = isError ? "message error" : "message";
  }

  // Sticks to DOM calls every UXP version handles the same way:
  // classList.add/remove and style.display, rather than toggle(name, force)
  // and the hidden property.
  function setClass(el, name, on) { if (on) el.classList.add(name); else el.classList.remove(name); }
  function show(el, on) { el.style.display = on ? "" : "none"; if (on) el.removeAttribute("hidden"); else el.setAttribute("hidden", ""); }

  function makeButton(id, fn) {
    var el = $(id);
    var run = function () { if (!el.classList.contains("disabled")) fn(); };
    el.addEventListener("click", run);
    el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(); } });
  }

  // ---------- the app ----------
  async function checkEngine() {
    var beat = await readJson(join(BOX, "engine.json"));
    var alive = beat && beat.app === "canvas-render" && Date.now() - beat.updatedAt < 6000;
    var label = $("engineState");
    if (alive) {
      var missing = [];
      if (!beat.ready.ffmpeg || !beat.ready.prores) missing.push("ffmpeg");
      if (!beat.ready.chrome) missing.push("the render browser");
      label.textContent = missing.length ? "Canvas Render is open but needs " + missing.join(" and ") + ". Finish setup in the app." : "Canvas Render is running.";
      label.className = missing.length ? "engine bad" : "engine ok";
      if (!state.engine) fillOptions(beat);
    } else {
      label.textContent = "Canvas Render isn't open. Open it to render.";
      label.className = "engine bad";
    }
    show($("launchButton"), !alive);
    state.engine = alive ? beat : null;
    refreshButtons();
  }

  function fillOptions(beat) {
    var presets = $("presetSelect");
    var rates = $("rateSelect");
    var savedPreset = localStorage.getItem("preset") || "master-alpha";
    var savedRate = localStorage.getItem("rate") || "23.976";
    presets.innerHTML = "";
    (beat.presets || []).forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.id; o.textContent = p.label + ": " + p.detail;
      if (p.id === savedPreset) o.selected = true;
      presets.appendChild(o);
    });
    rates.innerHTML = "";
    (beat.rates || []).forEach(function (r) {
      var o = document.createElement("option");
      o.value = r; o.textContent = r + " fps";
      if (r === savedRate) o.selected = true;
      rates.appendChild(o);
    });
  }

  async function launchApp() {
    try {
      await uxp.shell.openExternal("canvas-render://open", "Canvas Render renders the animations this panel imports.");
      say("Opening Canvas Render…");
    } catch (error) {
      say("Open Canvas Render from your Applications folder. (" + errorText(error) + ")", true);
    }
  }

  // ---------- requests ----------
  function newId() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  async function send(request) {
    request.id = newId();
    await writeJson(join(BOX, "inbox", request.id + ".json"), request);
    return request.id;
  }

  async function waitFor(id, onUpdate) {
    var file = join(BOX, "outbox", id + ".json");
    var started = Date.now();
    for (;;) {
      await sleep(500);
      var s = await readJson(file);
      if (s) {
        onUpdate(s);
        if (s.state !== "working") return s;
      } else if (Date.now() - started > 15000 && !state.engine) {
        throw new Error("Canvas Render stopped answering. Is it still open?");
      }
    }
  }

  // ---------- choosing an export ----------
  async function choose(folder) {
    try {
      var fsp = uxp.storage.localFileSystem;
      var entry = folder ? await fsp.getFolder() : await fsp.getFileForOpening({ types: ["zip", "html", "htm"] });
      if (!entry) return;
      state.input = entry.nativePath;
      state.project = null;
      state.sceneChoice = {};
      $("sourceName").textContent = baseName(state.input);
      $("sourceName").className = "source";
      show($("jobsGroup"), false);
      await analyze();
    } catch (error) {
      say(errorText(error), true);
    }
  }

  async function analyze() {
    if (!state.engine) { say("Open Canvas Render first.", true); return; }
    say("Reading the export…");
    state.busy = true; refreshButtons();
    try {
      var id = await send({ action: "analyze", input: state.input });
      var s = await waitFor(id, function () {});
      if (s.state === "error") throw new Error(s.message);
      state.project = s.project;
      renderScenes();
      say("");
    } catch (error) {
      say(errorText(error), true);
    } finally {
      state.busy = false; refreshButtons();
    }
  }

  function usable(scene) { return scene.info && !scene.error && !scene.empty; }

  function renderScenes() {
    var list = $("sceneList");
    list.innerHTML = "";
    var p = state.project;
    show($("scenesGroup"), !!p);
    if (!p) return;
    p.scenes.forEach(function (scene) {
      var ok = usable(scene);
      if (state.sceneChoice[scene.id] === undefined) state.sceneChoice[scene.id] = ok && scene.selected;
      var row = document.createElement("label");
      row.className = "scene" + (ok ? "" : " off");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!state.sceneChoice[scene.id];
      box.disabled = !ok;
      box.addEventListener("change", function () { state.sceneChoice[scene.id] = box.checked; refreshButtons(); });
      var text = document.createElement("div");
      text.className = "text";
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = scene.name;
      text.appendChild(name);
      var meta = document.createElement("span");
      if (scene.error) { meta.className = "err"; meta.textContent = scene.error; } else {
        meta.className = "meta";
        meta.textContent = scene.info ? scene.info.width + " × " + scene.info.height + ", " + (+scene.info.duration.toFixed(2)) + " s" : (scene.note || "");
      }
      text.appendChild(meta);
      row.appendChild(box);
      row.appendChild(text);
      list.appendChild(row);
    });
  }

  function chosenScenes() {
    if (!state.project) return [];
    return state.project.scenes.filter(function (s) { return usable(s) && state.sceneChoice[s.id]; });
  }

  function refreshButtons() {
    var ready = !!state.engine && !state.busy && chosenScenes().length > 0;
    setClass($("renderButton"), "disabled", !ready);
    ["chooseFile", "chooseFolder"].forEach(function (id) { setClass($(id), "disabled", state.busy); });
  }

  // ---------- render ----------
  async function activeProject() {
    if (!ppro) throw new Error("This panel only runs inside Premiere Pro.");
    var project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("Open a Premiere project first.");
    return project;
  }

  async function render() {
    var scenes = chosenScenes();
    if (!scenes.length) return;
    var preset = $("presetSelect").value;
    var rate = $("rateSelect").value;
    localStorage.setItem("preset", preset);
    localStorage.setItem("rate", rate);
    var request = { action: "render", input: state.input, scenes: scenes.map(function (s) { return s.id; }), preset: preset, settings: { rate: rate } };
    var asSequence = $("importSequence").checked;
    if (asSequence) request.settings.xml = true;

    state.busy = true; refreshButtons();
    say("");
    try {
      var project = await activeProject();
      if ($("besideProject").checked && project.path) {
        request.outDir = join(dirName(project.path), "Canvas Render", state.project.name.replace(/[\\/:*?"<>|]+/g, "_"));
      }
      var id = await send(request);
      show($("jobsGroup"), true);
      var final = await waitFor(id, renderJobs);
      renderJobs(final);
      if (final.state === "error" && !(final.jobs || []).some(function (j) { return j.status === "done"; })) throw new Error(final.message || "The render failed.");
      if (final.state === "cancelled") { say("Cancelled."); return; }
      await importResults(project, final, asSequence);
      if (final.message) say(final.message, true);
    } catch (error) {
      say(errorText(error), true);
    } finally {
      state.busy = false; refreshButtons();
    }
  }

  function jobText(j) {
    var p = j.progress || {};
    if (j.status === "queued") return "Waiting";
    if (j.status === "rendering") {
      var label = { checking: "Checking for changes", rendering: "Rendering", splicing: "Splicing", review: "Review copy" }[p.phase] || "Working";
      return p.total && p.phase !== "splicing" ? label + " " + p.done + " of " + p.total : label;
    }
    if (j.status === "done") {
      var r = j.result || {};
      if (r.upToDate) return "Already up to date";
      return r.reused ? r.rendered + " re-rendered, " + r.reused + " reused" : "Done, " + r.frames + " frames";
    }
    if (j.status === "cancelled") return "Cancelled";
    return j.error || "Failed";
  }

  function renderJobs(s) {
    var list = $("jobList");
    list.innerHTML = "";
    (s.jobs || []).forEach(function (j) {
      var p = j.progress || {};
      var pct = j.status === "done" || j.status === "error" ? 1 : (p.total ? p.done / p.total : 0);
      if (j.status === "rendering" && p.phase === "checking") pct *= 0.15;
      var row = document.createElement("div");
      row.className = "job " + j.status;
      var top = document.createElement("div");
      top.className = "top";
      var name = document.createElement("span");
      name.textContent = j.sceneName;
      var st = document.createElement("span");
      st.className = "state";
      st.textContent = jobText(j);
      top.appendChild(name); top.appendChild(st);
      var bar = document.createElement("div");
      bar.className = "bar";
      var fill = document.createElement("div");
      fill.style.width = Math.round(pct * 100) + "%";
      bar.appendChild(fill);
      row.appendChild(top); row.appendChild(bar);
      list.appendChild(row);
    });
  }

  // ---------- importing into Premiere ----------
  function tryFolder(item) {
    try { var f = ppro.FolderItem.cast(item); return f && typeof f.getItems === "function" ? f : null; } catch (error) { return null; }
  }

  async function findChildBin(parent, name) {
    var items = await parent.getItems();
    for (var i = 0; i < items.length; i += 1) {
      var f = tryFolder(items[i]);
      if (f && items[i].name === name) return f;
    }
    return null;
  }

  function transact(project, fn, label) {
    var ok = false; var failure = null;
    var runner = function () { try { ok = project.executeTransaction(fn, label); } catch (error) { failure = error; } };
    if (typeof project.lockedAccess === "function") project.lockedAccess(runner); else runner();
    if (failure) throw failure;
    if (!ok) throw new Error(label + " failed in Premiere.");
  }

  async function ensureBin(project, parent, name) {
    var found = await findChildBin(parent, name);
    if (found) return found;
    transact(project, function (compound) { compound.addAction(parent.createBinAction(name, false)); }, "Create " + name + " bin");
    for (var attempt = 0; attempt < 10; attempt += 1) {
      found = await findChildBin(parent, name);
      if (found) return found;
      await sleep(100);
    }
    throw new Error("Premiere did not create the " + name + " bin.");
  }

  async function mediaPathsIn(bin) {
    var paths = {};
    var items = await bin.getItems();
    for (var i = 0; i < items.length; i += 1) {
      try {
        var clip = ppro.ClipProjectItem.cast(items[i]);
        if (clip && typeof clip.getMediaFilePath === "function") {
          var p = await clip.getMediaFilePath();
          if (p) paths[p] = clip;
        }
      } catch (error) { /* not a clip */ }
    }
    return paths;
  }

  async function firstPng(folder) {
    var names = await fs.readdir(fileUrl(folder));
    var pngs = names.filter(function (n) { return /\.png$/i.test(n); }).sort();
    return pngs.length ? join(folder, pngs[0]) : null;
  }

  async function importResults(project, status, asSequence) {
    var done = (status.jobs || []).filter(function (j) { return j.status === "done" && j.result; });
    if (!done.length) return;
    var root = await project.getRootItem();
    var top = await ensureBin(project, root, "Canvas Render");
    var bin = await ensureBin(project, top, state.project.name);

    if (asSequence && status.xml) {
      var okXml = await project.importFiles([status.xml], true, bin, false);
      say(okXml ? "Imported a sequence of " + done.length + " scene" + (done.length > 1 ? "s" : "") + " into Canvas Render > " + state.project.name + "." : "Premiere did not import the timeline XML.", !okXml);
      return;
    }

    var existing = await mediaPathsIn(bin);
    var fresh = []; var updated = 0;
    for (var i = 0; i < done.length; i += 1) {
      var r = done[i].result;
      if (r.format === "png") {
        var first = await firstPng(r.file);
        if (first && !existing[first]) await project.importFiles([first], true, bin, true); else if (first) updated += 1;
        continue;
      }
      if (existing[r.file]) {
        // Rendered over the same file. Ask Premiere to re-read it if it can.
        try { if (typeof existing[r.file].refreshMedia === "function") await existing[r.file].refreshMedia(); } catch (error) { /* older Premiere */ }
        updated += 1;
      } else fresh.push(r.file);
    }
    if (fresh.length) await project.importFiles(fresh, true, bin, false);
    var parts = [];
    if (fresh.length) parts.push("Imported " + fresh.length + " clip" + (fresh.length > 1 ? "s" : ""));
    if (updated) parts.push(updated + " already in the bin, updated in place");
    say(parts.join(". ") + " (Canvas Render > " + state.project.name + ").");
  }

  // ---------- start ----------
  makeButton("chooseFile", function () { choose(false); });
  makeButton("chooseFolder", function () { choose(true); });
  makeButton("renderButton", render);
  makeButton("launchButton", launchApp);
  $("sourceName").className = "source empty";
  checkEngine();
  setInterval(checkEngine, 1500);
})();
