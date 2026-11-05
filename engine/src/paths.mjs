// Where Canvas Render keeps its own files.

import os from 'node:os';
import path from 'node:path';

/** Preferences, presets and the Premiere mailbox. */
export function dataRoot() {
  if (process.env.CANVAS_RENDER_DATA) return process.env.CANVAS_RENDER_DATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Canvas Render');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'Canvas Render');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'canvas-render');
}

/** The folder the Premiere panel and the engine pass requests through. */
export function mailboxRoot() {
  return path.join(dataRoot(), 'mailbox');
}

export const VERSION = '0.1.0';
