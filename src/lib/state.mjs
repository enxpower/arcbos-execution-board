// src/lib/state.mjs
// ─────────────────────────────────────────────────────────────────────────────
// State persistence for bot and board.
//
// State file schema:
// {
//   "bot": {
//     "last_update_id": 0,
//     "last_run": "ISO string",
//     "processed_count": 0
//   },
//   "board": {
//     "last_build": "ISO string",
//     "last_refresh_triggered": "ISO string",
//     "rows_fetched": 0
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.mjs';

const log = createLogger('state');

const DEFAULT_STATE = {
  bot: {
    last_update_id: 0,
    last_run: null,
    processed_count: 0,
  },
  board: {
    last_build: null,
    last_refresh_triggered: null,
    rows_fetched: 0,
  },
};

export async function loadState(stateFile) {
  if (!stateFile) return structuredClone(DEFAULT_STATE);

  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    // Deep merge with defaults to handle missing keys
    return {
      bot:   { ...DEFAULT_STATE.bot,   ...(parsed.bot   || {}) },
      board: { ...DEFAULT_STATE.board, ...(parsed.board || {}) },
    };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log.warn(`State file parse failed, using defaults`, { error: e.message });
    } else {
      log.info(`State file not found, starting fresh`);
    }
    return structuredClone(DEFAULT_STATE);
  }
}

export async function saveState(stateFile, state) {
  if (!stateFile) return;

  try {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp.${Date.now().toString(36)}`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, stateFile);
    log.debug(`State saved`, { file: stateFile });
  } catch (e) {
    log.warn(`Failed to save state (non-fatal)`, { error: e.message });
  }
}

// Returns true if board refresh debounce has passed
export function canRefreshBoard(state, debounceSec) {
  const last = state.board?.last_refresh_triggered;
  if (!last) return true;
  const elapsed = (Date.now() - new Date(last).getTime()) / 1000;
  return elapsed >= debounceSec;
}
