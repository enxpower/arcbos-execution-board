// scripts/daily-digest.mjs
// v1.2 — split: Founder decision brief (1 msg) + per-engineer task cards
// ─────────────────────────────────────────────────────────────────────────────
// Sends in order:
//   1. Founder brief — one message, decision-grade, minimal noise
//   2. Per-engineer — one message each, task list + ready-to-send commands
//
// Required env: TG_BOT_TOKEN, NOTION_TOKEN, BOARD_DB_ID, DIGEST_CHAT_ID
// Optional env: DIGEST_BOARD_URL, FOUNDER_CHAT_ID (separate if needed)
// ─────────────────────────────────────────────────────────────────────────────

import { cfg } from '../src/lib/config.mjs';
import { createLogger } from '../src/lib/logger.mjs';
import { notion, propText, propSelect, propDate } from '../src/lib/notion-client.mjs';
import { sendMessage } from '../src/lib/telegram-client.mjs';

const log = createLogger('daily-digest');

function requireConfig() {
  cfg.notionToken(); cfg.boardDbId(); cfg.tgBotToken();
  const chatId = process.env.DIGEST_CHAT_ID;
  if (!chatId) throw new Error('Missing required env: DIGEST_CHAT_ID');
  return chatId;
}

const BOARD_URL    = process.env.DIGEST_BOARD_URL || 'https://board.arcbos.com';
// If Founder wants a separate private chat, set FOUNDER_CHAT_ID; otherwise same group
const FOUNDER_CHAT = process.env.FOUNDER_CHAT_ID || null;

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

function taskRef(task) {
  return task.taskCode || task.name;
}

async function fetchActiveTasks() {
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

async function fetchDraftTasks() {
  const rows = await notion.queryAll(cfg.boardDbId(), {
    filter: {
      and: [
        { property: 'Type',   select: { equals: 'Task' } },
        { property: 'Status', select: { equals: 'Draft' } },
      ],
    },
  });
  return rows.map(page => ({
    name:     propText(page.properties, 'Name'),
    taskCode: propText(page.properties, 'TaskCode'),
    owner:    propText(page.properties, 'Owner') || '未指派',
  })).filter(t => t.name);
}

// ── Founder brief — one message, decision-grade ────────────────────────────────
// Answers: is today normal? what needs my attention?

function buildFounderBrief(tasks, drafts, date) {
  const blocked = tasks.filter(t => t._risk === 'blocked');
  const overdue  = tasks.filter(t => t._risk === 'overdue');
  const atrisk   = tasks.filter(t => t._risk === 'atrisk');
  const hasIssue = blocked.length > 0 || overdue.length > 0;

  const lines = [];

  // One-line status verdict
  if (!hasIssue && !drafts.length) {
    lines.push(`✅ <b>今日执行正常</b>`);
  } else {
    lines.push(`⚠️ <b>今日有项目需要关注</b>`);
  }

  lines.push(`📅 ${date}  ·  <a href="${BOARD_URL}">打开看板</a>`);
  lines.push('─────────────────────');

  // Issues — only show if exist
  if (blocked.length) {
    lines.push(`🔴 阻塞 ${blocked.length} 项：`);
    for (const t of blocked) {
      lines.push(`   ${t.name}${t.taskCode ? ` [${t.taskCode}]` : ''} · ${t.owner}`);
      if (t.blockedBy) lines.push(`   原因：${t.blockedBy}`);
    }
  }

  if (overdue.length) {
    lines.push(`🟠 逾期 ${overdue.length} 项：`);
    for (const t of overdue) {
      lines.push(`   ${t.name}${t.taskCode ? ` [${t.taskCode}]` : ''} · ${t.owner} · 逾期${Math.abs(t._dueDays)}天`);
    }
  }

  if (atrisk.length) {
    lines.push(`🟡 即将到期 ${atrisk.length} 项`);
  }

  // Draft reminder
  if (drafts.length) {
    lines.push(`🔒 待审批 ${drafts.length} 项（在 Notion 改为 Active 即可）：`);
    for (const t of drafts) {
      lines.push(`   ${t.name}${t.taskCode ? ` [${t.taskCode}]` : ''} · ${t.owner}`);
    }
  }

  // If truly all clear
  if (!blocked.length && !overdue.length && !atrisk.length && !drafts.length) {
    lines.push(`进行中 ${tasks.filter(t=>t._risk==='normal').length} 项，无异常。`);
  }

  lines.push('\n<code>ARCBOS · Execution System</code>');
  return lines.join('\n');
}

// ── Engineer card — one per owner, task list + copy-paste commands ─────────────

function buildEngineerCard(owner, tasks, date) {
  const order = { blocked:0, overdue:1, atrisk:2, normal:3 };
  const sorted = [...tasks].sort((a,b) => (order[a._risk]??9) - (order[b._risk]??9));

  const lines = [
    `👤 <b>${owner}</b>`,
    `📅 ${date}`,
    '─────────────────────',
  ];

  for (const t of sorted) {
    const icon = { blocked:'🔴', overdue:'🟠', atrisk:'🟡', normal:'🔵' }[t._risk] || '🔵';
    const ref  = taskRef(t);
    const code = t.taskCode ? ` <code>[${t.taskCode}]</code>` : '';
    const due  = t.due ? ` · ${fmtDate(t.due)}` : '';

    lines.push(`${icon} ${t.name}${code}${due}`);

    if (t._risk === 'blocked' && t.blockedBy) lines.push(`   ⚠️ ${t.blockedBy}`);
    else if (t._risk === 'overdue')  lines.push(`   逾期 ${Math.abs(t._dueDays)} 天`);
    else if (t._risk === 'atrisk')   lines.push(`   ${t._dueDays} 天后到期`);

    // One-tap command — the key UX improvement
    if (t._risk === 'blocked') {
      lines.push(`   → <code>激活 ${ref}</code>  或  <code>阻塞 ${ref} 原因：</code>`);
    } else {
      lines.push(`   → <code>完成 ${ref}</code>  或  <code>阻塞 ${ref} 原因：</code>`);
    }
  }

  lines.push('─────────────────────');

  const issues = tasks.filter(t => t._risk !== 'normal').length;
  lines.push(issues ? `⚠️ ${issues} 项需关注，请今日更新` : '✅ 今日无异常任务');
  lines.push('\n<code>ARCBOS · Execution System</code>');
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

const chatId = requireConfig();
log.info('Daily digest started', { dryRun: cfg.dryRun });

const [tasks, drafts] = await Promise.all([fetchActiveTasks(), fetchDraftTasks()]);
log.info('Data fetched', { active: tasks.length, drafts: drafts.length });

const today = new Date().toLocaleDateString('zh-CN', {
  year:'numeric', month:'long', day:'numeric', weekday:'long',
});

const delay = ms => new Promise(r => setTimeout(r, ms));

// 1. Founder brief — always first
const founderChat = FOUNDER_CHAT || chatId;
await sendMessage(founderChat, buildFounderBrief(tasks, drafts, today));
log.info('Founder brief sent');
await delay(1500);

if (!tasks.length) {
  log.info('No active tasks, skipping engineer cards');
  process.exit(0);
}

// 2. Engineer cards — grouped by owner, issues-first
const byOwner = new Map();
for (const task of tasks) {
  if (!byOwner.has(task.owner)) byOwner.set(task.owner, []);
  byOwner.get(task.owner).push(task);
}

const owners = [...byOwner.entries()]
  .sort((a,b) => {
    const ai = a[1].filter(t => t._risk !== 'normal').length;
    const bi = b[1].filter(t => t._risk !== 'normal').length;
    return bi - ai || a[0].localeCompare(b[0]);
  });

for (const [owner, ownerTasks] of owners) {
  await sendMessage(chatId, buildEngineerCard(owner, ownerTasks, today));
  log.info('Engineer card sent', { owner, count: ownerTasks.length });
  await delay(1000);
}

log.info('Daily digest complete', { owners: byOwner.size, tasks: tasks.length });
