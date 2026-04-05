// src/lib/logger.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Structured logger. Level-aware, token-safe.
// Levels: debug < info < warn < error
// ─────────────────────────────────────────────────────────────────────────────

import { cfg } from './config.mjs';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function levelNum(name) { return LEVELS[name] ?? 1; }

// Scrub sensitive values from log output
const SCRUB_PATTERNS = [
  /secret_[A-Za-z0-9_]+/g,
  /Bearer [A-Za-z0-9._:-]+/g,
  /\d{8,12}:[A-Za-z0-9_-]{30,}/g, // Telegram token pattern
];

function scrub(msg) {
  let s = String(msg);
  for (const re of SCRUB_PATTERNS) s = s.replace(re, '[REDACTED]');
  return s;
}

function fmt(level, ns, msg, meta) {
  const ts    = new Date().toISOString();
  const label = level.toUpperCase().padEnd(5);
  const ns_   = ns ? `[${ns}] ` : '';
  const meta_ = meta ? ' ' + scrub(JSON.stringify(meta)) : '';
  return `${ts} ${label} ${ns_}${scrub(msg)}${meta_}`;
}

export function createLogger(namespace = '') {
  const minLevel = levelNum(cfg.logLevel);

  return {
    debug: (msg, meta) => {
      if (minLevel <= LEVELS.debug) console.debug(fmt('debug', namespace, msg, meta));
    },
    info: (msg, meta) => {
      if (minLevel <= LEVELS.info) console.log(fmt('info', namespace, msg, meta));
    },
    warn: (msg, meta) => {
      if (minLevel <= LEVELS.warn) console.warn(fmt('warn', namespace, msg, meta));
    },
    error: (msg, meta) => {
      if (minLevel <= LEVELS.error) console.error(fmt('error', namespace, msg, meta));
    },
  };
}

export const log = createLogger('');
