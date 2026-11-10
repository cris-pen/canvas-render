// Canvas Render for macOS: starts the render engine and shows its window.
//
// The engine runs as a child process (Electron's own Node) so a crash in a
// render never takes the window down, and so it keeps serving the Premiere
// panel while the window is closed. Quitting the app stops it.

const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.CANVAS_RENDER_PORT || 47800);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, '..');

let engine = null;
let win = null;
let quitting = false;
const pendingPaths = [];

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    for (const a of argv.slice(1)) if (/\.(zip|html?)$/i.test(a) && existsSync(a)) openPath(a);
    showWindow();
  });
}

// Finder: drop a file on the Dock icon, or "Open With".
app.on('open-file', (e, file) => { e.preventDefault(); openPath(file); });
// The Premiere panel opens canvas-render:// to launch the app.
app.setAsDefaultProtocolClient('canvas-render');
app.on('open-url', (e) => { e.preventDefault(); showWindow(); });

function openPath(file) {
  if (win && !win.webContents.isLoading()) win.webContents.send('open-path', file);
  else pendingPaths.push(file);
}

function startEngine() {
  const bin = path.join(ROOT, 'engine', 'bin', 'canvas-render.mjs');
  engine = spawn(process.execPath, [bin, 'serve', '--port', String(PORT)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CANVAS_RENDER_PARENT: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let log = '';
  const keep = (d) => { log = (log + d.toString()).slice(-4000); };
  engine.stdout.on('data', keep);
  engine.stderr.on('data', keep);
  engine.on('exit', (code) => {
    const already = /already running/.test(log);
    engine = null;
    if (!quitting && !already && code) {
      dialog.showErrorBox('The render engine stopped', `${log.trim().split('\n').slice(-6).join('\n') || `Exit code ${code}`}\n\nCanvas Render will restart it.`);
      setTimeout(startEngine, 1000);
    }
  });
}

async function waitForEngine(ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${ORIGIN}/api/status`);
      if (r.ok && (await r.json()).app === 'canvas-render') return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Canvas Render',
    backgroundColor: '#1b1c1f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    while (pendingPaths.length) win.webContents.send('open-path', pendingPaths.shift());
    // CI smoke test: save what the window shows, then quit.
    if (process.env.CANVAS_RENDER_SMOKE) {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        require('node:fs').writeFileSync(process.env.CANVAS_RENDER_SMOKE, img.toPNG());
        quitting = true; app.quit();
      }, 2500);
    }
  });
  // The window only ever shows the local UI. Links go to the default browser.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // Closing the window keeps the engine running for the Premiere panel.
  win.on('close', (e) => { if (!quitting && process.platform === 'darwin') { e.preventDefault(); win.hide(); } });
  win.loadURL(`${ORIGIN}/`);
}

function showWindow() {
  if (!app.isReady()) return;
  if (!win) createWindow();
  else { win.show(); win.focus(); }
}

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open a Claude Design export',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'Claude Design export or HTML', extensions: ['zip', 'html', 'htm'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a background image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Save renders to',
    defaultPath: typeof current === 'string' ? current : undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('reveal', async (_e, file, open) => {
  if (typeof file !== 'string' || !existsSync(file)) throw new Error('That file is no longer there.');
  if (open) { const err = await shell.openPath(file); if (err) throw new Error(err); } else shell.showItemInFolder(file);
});

ipcMain.on('notify', (_e, title, body) => {
  if (win && win.isFocused()) return;
  if (Notification.isSupported()) new Notification({ title: String(title), body: String(body || '') }).show();
});

function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: async () => {
          showWindow();
          const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'openDirectory', 'multiSelections'], filters: [{ name: 'Claude Design export or HTML', extensions: ['zip', 'html', 'htm'] }] });
          if (!r.canceled) r.filePaths.forEach(openPath);
        } },
        { label: 'Show Renders Folder', click: () => shell.openPath(path.join(app.getPath('home'), 'Movies', 'Canvas Render')) },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Canvas Render on GitHub', click: () => shell.openExternal('https://github.com/cris-pen/canvas-render') }] },
  ]));
}

app.whenReady().then(async () => {
  buildMenu();
  startEngine();
  if (!(await waitForEngine())) {
    dialog.showErrorBox('Canvas Render could not start', `The render engine did not answer on port ${PORT}. Another program may be using it.`);
  }
  for (const a of process.argv.slice(1)) if (/\.(zip|html?)$/i.test(a) && existsSync(a)) pendingPaths.push(a);
  createWindow();
});

app.on('activate', showWindow);
app.on('before-quit', () => {
  quitting = true;
  if (engine) { engine.stdin.end(); engine.kill('SIGTERM'); }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
