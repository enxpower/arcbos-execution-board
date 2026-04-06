// scripts/daily-digest.mjs
// v1.1 — upgraded format: per-owner messages include ready-to-use commands
// ─────────────────────────────────────────────────────────────────────────────
import { cfg } from '../src/lib/config.mjs';
import { createLogger } from '../src/lib/logger.mjs';
import { notion, propText, propSelect, propDate, propNumber } from '../src/lib/notion-client.mjs';
import { sendMessage } from '../src/lib/telegram-client.mjs';

const log = createLogger('daily-digest');

function requireDigestConfig() {
  cfg.notionToken(); cfg.boardDbId(); cfg.tgBotToken();
  const chatId = process.env.DIGEST_CHAT_ID;
  if (!chatId) throw new Error('Missing required env: DIGEST_CHAT_ID');
  return chatId;
}

const BOARD_URL = process.env.DIGEST_BOARD_URL || 'https://board.arcbos.com';

function todayStart() {
  const d = new Date(); d.setHours(0,0,0,0); return d;
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

function riskLevel(task) {
  if (task.status === 'Blocked') return 'blocked';
  const dd = daysUntil(task.due);
  if (dd !== null && dd < 0)  return 'overdue';
  if (dd !== null && dd <= 3) return 'atrisk';
  return 'normal';
}

async function fetchActiveTasks() {
  log.info('Fetching tasks...');
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

// Build the identifier used in bot commands: prefer TaskCode, fall back to name
function taskRef(task) {
  return task.taskCode || task.name;
}

function buildOwnerMessage(owner, tasks, date) {
  const order = { blocked:0, overdue:1, atrisk:2, normal:3 };
  const sorted = [...tasks].sort((a,b) => (order[a._risk]??9) - (order[b._risk]??9));

  const lines = [
    `👤 <b>${owner}</b> — 今日任务`,
    `📅 ${date}`,
    '─────────────────────',
  ];

  for (const t of sorted) {
    const riskIcon = { blocked:'🔴', overdue:'🟠', atrisk:'🟡', normal:'🔵' }[t._risk] || '🔵';
    const ref      = taskRef(t);
    const code     = t.taskCode ? ` <code>[${t.taskCode}]</code>` : '';
    const dueStr   = t.due ? ` · ${fmtDate(t.due)}` : '';

    lines.push(`${riskIcon} ${t.name}${code}${dueStr}`);

    if (t._risk === 'blocked' && t.blockedBy) {
      lines.push(`   ⚠️ 阻塞：${t.blockedBy}`);
    } else if (t._risk === 'overdue') {
      lines.push(`   ⏰ 已逾期 ${Math.abs(t._dueDays)} 天`);
    } else if (t._risk === 'atrisk') {
      lines.push(`   ⏳ ${t._dueDays} 天后到期`);
    }

    // Ready-to-use command hint
    if (t._risk === 'blocked') {
      lines.push(`   💬 <code>激活 ${ref}</code>`);
    } else {
      lines.push(`   💬 <code>完成 ${ref}</code>`);
    }
  }

  const blocked = tasks.filter(t => t._risk === 'blocked').length;
  const overdue  = tasks.filter(t => t._risk === 'overdue').length;
  const atrisk   = tasks.filter(t => t._risk === 'atrisk').length;

  lines.push('─────────────────────');
  const summary = [];
  if (blocked) summary.push(`${blocked} 阻塞`);
  if (overdue)  summary.push(`${overdue} 逾期`);
  if (atrisk)   summary.push(`${atrisk} 风险`);
  lines.push(summary.length ? `⚠️ 需关注：${summary.join(' · ')}` : '✅ 今日任务无异常');
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
    '📊 <b>ARCBOS 每日执行概览</b>',
    `📅 ${date}`,
    '─────────────────────',
    `🔵 进行中   ${normal}`,
    `🟡 即将到期 ${atrisk}`,
    `🟠 已逾期   ${overdue}`,
    `🔴 阻塞中   ${blocked}`,
    '─────────────────────',
    `活跃任务共 ${total} 项`,
  ];

  if (blocked > 0 || overdue > 0) {
    lines.push('');
    lines.push('⚠️ 有阻塞或逾期项，请相关负责人今日处理。');
  } else {
    lines.push('');
    lines.push('✅ 执行正常，无阻塞或逾期任务。');
  }

  lines.push(`\n<a href="${BOARD_URL}">查看完整看板 →</a>`);
  lines.push('\n<code>ARCBOS · Execution System</code>');
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

const chatId = requireDigestConfig();
const runId  = Date.now().toString(36).toUpperCase();
log.info('Daily digest started', { runId, dryRun: cfg.dryRun });

const tasks = await fetchActiveTasks();
log.info('Tasks fetched', { total: tasks.length });

const today = new Date().toLocaleDateString('zh-CN', {
  year:'numeric', month:'long', day:'numeric', weekday:'long',
});

if (!tasks.length) {
  await sendMessage(chatId, [
    '📊 <b>ARCBOS 每日执行概览</b>',
    `📅 ${today}`,
    '─────────────────────',
    '✅ 当前无活跃任务。',
    `\n<a href="${BOARD_URL}">查看看板 →</a>`,
    '\n<code>ARCBOS · Execution System</code>',
  ].join('\n'));
  process.exit(0);
}

// Group by owner
const byOwner = new Map();
for (const task of tasks) {
  if (!byOwner.has(task.owner)) byOwner.set(task.owner, []);
  byOwner.get(task.owner).push(task);
}

// 1. Team summary
await sendMessage(chatId, buildTeamSummaryMessage(tasks, today));
log.info('Team summary sent');
await new Promise(r => setTimeout(r, 1500));

// 2. Per-owner (issues first)
const owners = [...byOwner.entries()]
  .sort((a,b) => {
    const ai = a[1].filter(t => t._risk !== 'normal').length;
    const bi = b[1].filter(t => t._risk !== 'normal').length;
    return bi - ai || a[0].localeCompare(b[0]);
  });

for (const [owner, ownerTasks] of owners) {
  await sendMessage(chatId, buildOwnerMessage(owner, ownerTasks, today));
  log.info('Owner digest sent', { owner, tasks: ownerTasks.length });
  await new Promise(r => setTimeout(r, 1000));
}

log.info('Daily digest complete', { runId, owners: byOwner.size, totalTasks: tasks.length });
