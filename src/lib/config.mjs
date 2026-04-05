// src/lib/config.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Unified configuration module.
// All environment variables resolved here. Scripts import from this module only.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Auto-load .env if present (local dev only)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional(name, def = '') {
  return process.env[name] || def;
}

function optionalInt(name, def) {
  const v = process.env[name];
  return v ? parseInt(v, 10) : def;
}

function optionalBool(name, def = false) {
  const v = process.env[name];
  if (!v) return def;
  return v === '1' || v.toLowerCase() === 'true';
}

// ── Validate and export ───────────────────────────────────────────────────────

export const cfg = {
  // Required
  notionToken:   () => required('NOTION_TOKEN'),
  boardDbId:     () => required('BOARD_DB_ID'),
  tgBotToken:    () => required('TG_BOT_TOKEN'),

  // Notion pacing
  notionGapMs:      optionalInt('NOTION_GAP_MS', 500),
  notionMaxRetries: optionalInt('NOTION_MAX_RETRIES', 8),
  notionPageSize:   optionalInt('NOTION_PAGE_SIZE', 100),

  // Bot
  botStateFile: optional('BOT_STATE_FILE', '/tmp/tg-bot-state.json'),

  // Board
  boardOutDir:   optional('BOARD_OUT_DIR', 'out'),
  boardCname:    optional('BOARD_CNAME', 'board.arcbos.com'),
  boardTitle:    optional('BOARD_TITLE', 'ARCBOS SnowBot — Project Board'),
  boardDomain:   optional('BOARD_DOMAIN', 'https://board.arcbos.com'),

  // Debounce: min seconds between board rebuilds triggered by bot
  boardRefreshDebounceSec: optionalInt('BOARD_REFRESH_DEBOUNCE_SEC', 300),

  // Logging
  logLevel: optional('LOG_LEVEL', 'info'), // debug | info | warn | error

  // Misc
  dryRun: optionalBool('DRY_RUN', false),
};

// Validate required vars eagerly (fail fast) when called
export function requireNotionConfig() {
  cfg.notionToken();
  cfg.boardDbId();
}

export function requireBotConfig() {
  cfg.tgBotToken();
  cfg.notionToken();
  cfg.boardDbId();
}

export function requireBoardConfig() {
  cfg.notionToken();
  cfg.boardDbId();
}
