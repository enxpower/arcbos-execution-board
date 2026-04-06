// scripts/daily-digest.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Daily task digest — sends each engineer's active tasks to the Telegram group.
//
// Runs via GitHub Actions schedule (weekday mornings).
// Reads Notion → groups by Owner → sends one structured message per owner
// → sends one summary message for blocked/overdue items.
//
// Required env:
//   TG_BOT_TOKEN, NOTION_TOKEN, BOARD_DB_ID, DIGEST_CHAT_ID
//
// Optional env:
//   DIGEST_BOARD_URL   (default: https://board.arcbos.com)
//   DRY_RUN=1          (print messages, don't send)
//   LOG_LEVEL
// ─────────────────────────────────────────────────────────────────────────────

import { cfg } from '../src/lib/config.mjs';
import { createLogger } from '../src/lib/logger.mjs';
import { notion, propText, propSelect, propDate, propNumber } from '../src/lib/notion-client.mjs';
import { sendMessage } from '../src/lib/telegram-client.mjs';

const log = createLogger('daily-digest');

// ── Config ──────────────────────────────────────────────────────────────────

function requireDigestConfig() {
  cfg.notionToken();
  cfg.boardDbId();
  cfg.tgBotToken();
  const chatId = process.env.DIGEST_CHAT_ID;
  if (!chatId) throw new Error('Missing required env: DIGEST_CHAT_ID');
  return chatId;
}

const BOARD_URL = process.env.DIGEST_BOARD_URL || 'https://board.arcbos.com';

// ── Date helpers ─────────────────────────────────────────────────────────────

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysUntil(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const t = todayStart();
  dt.setHours(0, 0, 0, 0);
  return Math.round((dt - t) / 86400000);
}

function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('zh-CN', {
      month: '2-digit', day: '2-digit',
    });
  } catch { return d; }
}

function riskLevel(task) {
  if (task.status === 'Blocked') return 'blocked';
  const dd = daysUntil(task.due);
  if (dd !== null && dd < 0)  return 'overdue';
  if (dd !== null && dd <= 3) return 'atrisk';
  return 'normal';
}

// ── Fetch tasks ──────────────────────────────────────────────────────────────

async function fetchActiveTasks() {
  log.info('Fetching tasks from Notion...');

  const rows = await notion.queryAll(cfg.boardDbId(), {
    filter: {
      and: [
        { property: 'Type',   select: { equals: 'Task' } },
        { property: 'Status', select: { does_not_equal: 'Done' } },
        { property: 'Status', select: { does_not_equal: 'Draft' } },
      ],
    },
    sorts: [{ property: 'SortOrder', direction: 'ascending' }],
  });

  return rows.map(page => {
    const p = page.properties;
    const task = {
      id:        page.id,
      name:      propText(p, 'Name'),
      taskCode:  propText(p, 'TaskCode'),
      status:    propSelect(p, 'Status'),
      owner:     propText(p, 'Owner') || '未指派',
      phase:     propText(p, 'Phase'),
      due:       propDate(p, 'Due'),
      blockedBy: propText(p, 'BlockedBy'),
    };
    task._risk    = riskLevel(task);
    task._dueDays = daysUntil(task.due);
    return task;
  }).filter(t => t.name);
}

// ── Message builders ─────────────────────────────────────────────────────────

const STATUS_ZH = { Active:'进行中', Blocked:'阻塞中' };

function taskLine(task) {
  const code    = task.taskCode ? ` <code>[${task.taskCode}]</code>` : '';
  const dueStr  = task.due ? ` · ${fmtDate(task.due)}` : '';
  const riskIcon = {
    blocked: '🔴',
    overdue:  '🟠',
    atrisk:   '🟡',
    normal:   '🔵',
  }[task._risk] || '🔵';

  let line = `${riskIcon} ${task.name}${code}${dueStr}`;

  if (task.status === 'Blocked' && task.blockedBy) {
    line += `\n    ⚠️ 阻塞：${task.blockedBy}`;
  } else if (task._risk === 'overdue') {
    line += `\n    ⏰ 已逾期 ${Math.abs(task._dueDays)} 天`;
  } else if (task._risk === 'atrisk') {
    line += `\n    ⏳ ${task._dueDays} 天后到期`;
  }

  return line;
}

function buildOwnerMessage(owner, tasks, date) {
  const lines = [
    `👤 <b>${owner}</b> — 今日任务`,
    `📅 ${date}`,
    '─────────────────────',
  ];

  // Sort: blocked first, then overdue, then at-risk, then normal
  const order = { blocked:0, overdue:1, atrisk:2, normal:3 };
  const sorted = [...tasks].sort((a,b) => (order[a._risk]??9) - (order[b._risk]??9));

  for (const t of sorted) {
    lines.push(taskLine(t));
  }

  const blocked = tasks.filter(t => t._risk === 'blocked').length;
  const overdue  = tasks.filter(t => t._risk === 'overdue').length;
  const atrisk   = tasks.filter(t => t._risk === 'atrisk').length;

  lines.push('─────────────────────');

  const summary = [];
  if (blocked) summary.push(`${blocked} 阻塞`);
  if (overdue)  summary.push(`${overdue} 逾期`);
  if (atrisk)   summary.push(`${atrisk} 即将到期`);
  if (summary.length) {
    lines.push(`⚠️ 需关注：${summary.join(' · ')}`);
  } else {
    lines.push('✅ 无阻塞或逾期项');
  }

  lines.push(`\n<a href="${BOARD_URL}">查看完整看板 →</a>`);
  lines.push('\n<code>ARCBOS · Execution System</code>');

  return lines.join('\n');
}

function buildTeamSummaryMessage(tasks, date) {
  const total   = tasks.length;
  const blocked = tasks.filter(t => t._risk === 'blocked').length;
  const overdue  = tasks.filter(t => t._risk === 'overdue').length;
  const atrisk   = tasks.filter(t => t._risk === 'atrisk').length;
  const normal   = total - blocked - overdue - atrisk;

  const lines = [
    `📊 <b>ARCBOS 每日执行概览</b>`,
    `📅 ${date}`,
    '─────────────────────',
    `🔵 进行中   ${normal}`,
    `🟡 即将到期 ${atrisk}`,
    `🟠 已逾期   ${overdue}`,
    `🔴 阻塞中   ${blocked}`,
    '─────────────────────',
    `合计活跃任务：${total} 项`,
  ];

  if (blocked > 0 || overdue > 0) {
    lines.push('');
    lines.push('⚠️ 有需要立即处理的阻塞或逾期项，');
    lines.push('请相关负责人确认并更新状态。');
  } else {
    lines.push('');
    lines.push('✅ 当前无阻塞或逾期任务，执行正常。');
  }

  lines.push(`\n<a href="${BOARD_URL}">查看完整看板 →</a>`);
  lines.push('\n<code>ARCBOS · Execution System</code>');

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

const chatId = requireDigestConfig();

const runId = Date.now().toString(36).toUpperCase();
log.info('Daily digest started', { runId, dryRun: cfg.dryRun, chatId });

const tasks = await fetchActiveTasks();
log.info('Tasks fetched', { total: tasks.length });

if (!tasks.length) {
  log.info('No active tasks — sending empty digest');
  const msg = [
    '📊 <b>ARCBOS 每日执行概览</b>',
    `📅 ${new Date().toLocaleDateString('zh-CN')}`,
    '─────────────────────',
    '✅ 当前无活跃任务。',
    `\n<a href="${BOARD_URL}">查看看板 →</a>`,
    '\n<code>ARCBOS · Execution System</code>',
  ].join('\n');
  await sendMessage(chatId, msg);
  process.exit(0);
}

// Group by owner
const byOwner = new Map();
for (const task of tasks) {
  if (!byOwner.has(task.owner)) byOwner.set(task.owner, []);
  byOwner.get(task.owner).push(task);
}

const today = new Date().toLocaleDateString('zh-CN', {
  year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
});

// 1. Team summary first
const summaryMsg = buildTeamSummaryMessage(tasks, today);
await sendMessage(chatId, summaryMsg);
log.info('Team summary sent');

// Small delay between messages to avoid Telegram rate-limit
await new Promise(r => setTimeout(r, 1500));

// 2. Per-owner messages
const owners = [...byOwner.entries()]
  .sort((a, b) => {
    // Sort owners: those with issues first
    const aIssues = a[1].filter(t => t._risk !== 'normal').length;
    const bIssues = b[1].filter(t => t._risk !== 'normal').length;
    return bIssues - aIssues || a[0].localeCompare(b[0]);
  });

for (const [owner, ownerTasks] of owners) {
  const msg = buildOwnerMessage(owner, ownerTasks, today);
  await sendMessage(chatId, msg);
  log.info('Owner digest sent', { owner, tasks: ownerTasks.length });
  await new Promise(r => setTimeout(r, 1000));
}

log.info('Daily digest complete', {
  runId,
  owners: byOwner.size,
  totalTasks: tasks.length,
});
