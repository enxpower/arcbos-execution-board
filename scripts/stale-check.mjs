// scripts/stale-check.mjs
// Stale task check — nudges engineers whose Active tasks haven't moved in N days
// ─────────────────────────────────────────────────────────────────────────────
// Logic:
//   - Fetch all Active tasks
//   - Check last_edited_time from Notion
//   - If edited > STALE_DAYS ago → send nudge to group
//
// Required env: TG_BOT_TOKEN, NOTION_TOKEN, BOARD_DB_ID, DIGEST_CHAT_ID
// Optional env: STALE_DAYS (default 2), DIGEST_BOARD_URL
// ─────────────────────────────────────────────────────────────────────────────

import { cfg } from '../src/lib/config.mjs';
import { createLogger } from '../src/lib/logger.mjs';
import { sendMessage } from '../src/lib/telegram-client.mjs';

const log = createLogger('stale-check');

function requireConfig() {
  cfg.notionToken(); cfg.boardDbId(); cfg.tgBotToken();
  const chatId = process.env.DIGEST_CHAT_ID;
  if (!chatId) throw new Error('Missing required env: DIGEST_CHAT_ID');
  return chatId;
}

const BOARD_URL  = process.env.DIGEST_BOARD_URL || 'https://board.arcbos.com';
const STALE_DAYS = parseInt(process.env.STALE_DAYS || '2', 10);
const NOTION_TOKEN = process.env.NOTION_TOKEN || cfg.notionToken();

function todayStart() {
  const d = new Date(); d.setHours(0,0,0,0); return d;
}

function daysSince(isoString) {
  if (!isoString) return 999;
  const edited = new Date(isoString);
  const today  = todayStart();
  return Math.floor((today - edited) / 86400000);
}

function daysUntil(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const t = todayStart(); dt.setHours(0,0,0,0);
  return Math.round((dt - t) / 86400000);
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('zh-CN', { month:'2-digit', day:'2-digit' }); }
  catch { return d; }
}

// Fetch Active tasks directly with last_edited_time via raw Notion API
// (notion-client queryAll doesn't expose last_edited_time, so we fetch raw)
async function fetchStaleTasks() {
  const NOTION_VERSION = '2022-06-28';
  const BASE = 'https://api.notion.com/v1';
  const dbId = cfg.boardDbId();

  let results = [];
  let cursor;

  while (true) {
    const body = {
      page_size: 100,
      filter: {
        and: [
          { property: 'Type',   select: { equals: 'Task' } },
          { property: 'Status', select: { equals: 'Active' } },
        ],
      },
      ...(cursor ? { start_cursor: cursor } : {}),
    };

    const res = await fetch(`${BASE}/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type':   'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion query failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    results.push(...data.results);
    if (!data.has_more) break;
    cursor = data.next_cursor;

    await new Promise(r => setTimeout(r, 500));
  }

  // Map to task objects including last_edited_time
  return results.map(page => {
    const p = page.properties;
    const getText  = name => (p[name]?.title || p[name]?.rich_text || []).map(t => t.plain_text).join('').trim();
    const getSelect = name => p[name]?.select?.name || '';
    const getDate   = name => p[name]?.date?.start || '';

    return {
      id:            page.id,
      name:          getText('Name'),
      taskCode:      getText('TaskCode'),
      owner:         getText('Owner') || '未指派',
      due:           getDate('Due'),
      lastEdited:    page.last_edited_time,
      staleDays:     daysSince(page.last_edited_time),
    };
  }).filter(t => t.name && t.staleDays >= STALE_DAYS);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const chatId = requireConfig();
log.info('Stale check started', { staleDays: STALE_DAYS });

const staleTasks = await fetchStaleTasks();
log.info('Stale tasks found', { count: staleTasks.length });

if (!staleTasks.length) {
  log.info('No stale tasks — all good');
  process.exit(0);
}

// Group by owner
const byOwner = new Map();
for (const t of staleTasks) {
  if (!byOwner.has(t.owner)) byOwner.set(t.owner, []);
  byOwner.get(t.owner).push(t);
}

// Send one grouped nudge message
const lines = [
  `⏰ <b>任务进度提醒</b>`,
  `以下任务已 ${STALE_DAYS}+ 天未更新，请今日处理：`,
  '─────────────────────',
];

for (const [owner, tasks] of byOwner.entries()) {
  lines.push(`👤 ${owner}`);
  for (const t of tasks) {
    const ref  = t.taskCode || t.name;
    const code = t.taskCode ? ` <code>[${t.taskCode}]</code>` : '';
    const due  = t.due ? ` · 截止${fmtDate(t.due)}` : '';
    lines.push(`   ${t.name}${code}${due} · 已${t.staleDays}天未更新`);
    lines.push(`   → <code>完成 ${ref}</code>  或  <code>阻塞 ${ref} 原因：</code>`);
  }
}

lines.push('─────────────────────');
lines.push('请回复对应命令更新状态，或告知阻塞原因。');
lines.push(`\n<a href="${BOARD_URL}">查看完整看板 →</a>`);
lines.push('\n<code>ARCBOS · Execution System</code>');

await sendMessage(chatId, lines.join('\n'));
log.info('Stale nudge sent', { owners: byOwner.size, tasks: staleTasks.length });
