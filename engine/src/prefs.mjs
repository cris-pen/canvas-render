// Remembered choices: the last settings, output folder and recent projects.
// Shared by the app window and the Premiere panel.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataRoot } from './paths.mjs';
import { DEFAULTS } from './settings.mjs';

const file = () => path.join(dataRoot(), 'prefs.json');

const BASE = { settings: { ...DEFAULTS }, outRoot: null, recent: [], swatches: [] };

export function readPrefs() {
  try {
    if (!existsSync(file())) return structuredClone(BASE);
    const p = JSON.parse(readFileSync(file(), 'utf8'));
    return { ...structuredClone(BASE), ...p, settings: { ...DEFAULTS, ...(p.settings || {}) } };
  } catch {
    return structuredClone(BASE);
  }
}

export function writePrefs(patch) {
  const next = { ...readPrefs(), ...patch };
  if (patch.settings) next.settings = { ...readPrefs().settings, ...patch.settings };
  // Only keep keys the renderer understands.
  for (const k of Object.keys(next.settings)) if (!(k in DEFAULTS)) delete next.settings[k];
  next.recent = (next.recent || []).slice(0, 12);
  next.swatches = (next.swatches || []).slice(0, 16);
  mkdirSync(dataRoot(), { recursive: true });
  const tmp = `${file()}.part`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, file());
  return next;
}

export function rememberProject(source, name) {
  if (!source || /^https?:/i.test(source)) return;
  const recent = readPrefs().recent.filter((r) => r.source !== source);
  recent.unshift({ source, name, at: new Date().toISOString() });
  writePrefs({ recent });
}
