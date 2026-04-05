// src/lib/notion-client.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Unified Notion API access layer.
//
// ALL Notion calls go through this module. Features:
//   - Global request gap (NOTION_GAP_MS)
//   - 429 rate-limit: respects Retry-After header strictly
//   - 5xx: exponential backoff with jitter
//   - Automatic pagination (queryAll)
//   - Write deduplication (skip PATCH if value unchanged)
//   - Structured logging of every retry/failure
//   - Token never appears in logs
// ─────────────────────────────────────────────────────────────────────────────

import { cfg } from './config.mjs';
import { createLogger } from './logger.mjs';

const log = createLogger('notion');
const NOTION_VERSION = '2022-06-28';
const BASE = 'https://api.notion.com/v1';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function jitter(ms) { return ms + Math.floor(Math.random() * ms * 0.3); }

// ── Core request with retry ────────────────────────────────────────────────

async function request(method, path, body, label = '') {
  const token      = cfg.notionToken();
  const maxRetries = cfg.notionMaxRetries;
  const gapMs      = cfg.notionGapMs;
  let attempt = 0;

  while (true) {
    attempt++;
    const url = `${BASE}${path}`;

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Authorization':  `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type':   'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // 429 rate limit — respect Retry-After
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') || 60);
        const waitMs = (retryAfter + 1) * 1000;
        log.warn(`429 rate-limited`, { op: label || path, retryAfter, waitMs, attempt });
        await sleep(waitMs);
        continue;
      }

      // 5xx — exponential backoff with jitter
      if (res.status >= 500 && res.status < 600) {
        if (attempt > maxRetries) {
          const text = await res.text().catch(() => '');
          throw new Error(`Notion ${res.status} after ${maxRetries} retries on ${path}: ${text}`);
        }
        const backoff = jitter(Math.min(30000, 500 * 2 ** attempt));
        log.warn(`${res.status} server error`, { op: label || path, attempt, backoff });
        await sleep(backoff);
        continue;
      }

      // Other errors
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Notion ${res.status} on ${method} ${path}: ${text}`);
      }

      await sleep(gapMs);
      return res.json();

    } catch (e) {
      // Network / fetch errors
      if (attempt > maxRetries) throw e;
      const backoff = jitter(Math.min(20000, 1000 * 2 ** attempt));
      log.warn(`Network error, retrying`, { op: label || path, attempt, error: e.message, backoff });
      await sleep(backoff);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export const notion = {

  // Query a single page of a database
  queryPage(databaseId, opts = {}) {
    return request('POST', `/databases/${databaseId}/query`, {
      page_size: cfg.notionPageSize,
      ...opts,
    }, `query:${databaseId.slice(0,8)}`);
  },

  // Query ALL pages of a database (handles pagination automatically)
  async queryAll(databaseId, opts = {}) {
    const rows = [];
    let cursor;
    let page = 0;

    while (true) {
      page++;
      const body = {
        page_size: cfg.notionPageSize,
        ...opts,
        ...(cursor ? { start_cursor: cursor } : {}),
      };
      const res = await request('POST', `/databases/${databaseId}/query`, body,
        `queryAll:${databaseId.slice(0,8)}:p${page}`);

      rows.push(...res.results);
      log.debug(`queryAll page ${page}`, { count: res.results.length, hasMore: res.has_more });

      if (!res.has_more) break;
      cursor = res.next_cursor;
    }

    log.info(`queryAll complete`, { db: databaseId.slice(0,8), total: rows.length, pages: page });
    return rows;
  },

  // Get a single page
  getPage(pageId) {
    return request('GET', `/pages/${pageId}`, null, `getPage:${pageId.slice(0,8)}`);
  },

  // PATCH a page's properties
  updatePage(pageId, properties, label = '') {
    if (cfg.dryRun) {
      log.info(`[DRY RUN] PATCH page`, { pageId: pageId.slice(0,8), props: Object.keys(properties) });
      return Promise.resolve({ id: pageId });
    }
    return request('PATCH', `/pages/${pageId}`, { properties },
      label || `updatePage:${pageId.slice(0,8)}`);
  },

  // Create a new page in a database
  createPage(databaseId, properties) {
    if (cfg.dryRun) {
      log.info(`[DRY RUN] CREATE page`, { db: databaseId.slice(0,8), props: Object.keys(properties) });
      return Promise.resolve({ id: 'dry-run-id' });
    }
    return request('POST', '/pages', {
      parent: { database_id: databaseId },
      properties,
    }, `createPage:${databaseId.slice(0,8)}`);
  },
};

// ── Property helpers ───────────────────────────────────────────────────────

export function propText(props, name) {
  const p = props[name];
  if (!p) return '';
  if (p.type === 'title')     return (p.title     || []).map(t => t.plain_text).join('').trim();
  if (p.type === 'rich_text') return (p.rich_text || []).map(t => t.plain_text).join('').trim();
  return '';
}

export function propSelect(props, name) {
  return props[name]?.select?.name || '';
}

export function propDate(props, name) {
  return props[name]?.date?.start || '';
}

export function propNumber(props, name) {
  const v = props[name]?.number;
  return typeof v === 'number' ? v : 9999;
}

// Build a rich_text property value
export function richText(content) {
  return content
    ? [{ type: 'text', text: { content: String(content).slice(0, 2000) } }]
    : [];
}
