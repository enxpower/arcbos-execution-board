// scripts/weekly-report.mjs
// Weekly executive summary for Founder — sent every Friday
// ─────────────────────────────────────────────────────────────────────────────
import { cfg } from '../src/lib/config.mjs';
import { createLogger } from '../src/lib/logger.mjs';
import { notion, propText, propSelect, propDate, propNumber } from '../src/lib/notion-client.mjs';
import { sendMessage } from '../src/lib/telegram-client.mjs';

const log = createLogger('weekly-report');

function requireConfig() {
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

async function fetchAllTasks() {
  const rows = await notion.queryAll(cfg.boardDbId(), {
    filter: { property: 'Type', select: { equals: 'Task' } },
  });
  return rows.map(page => {
    const p = page.properties;
    return {
      name:     propText(p, 'Name'),
      taskCode: propText(p, 'TaskCode'),
      status:   propSelect(p, 'Status'),
      owner:    propText(p, 'Owner') || '未指派',
      phase:    propText(p, 'Phase'),
      due:      propDate(p, 'Due'),
      blockedBy: propText(p, 'BlockedBy'),
    };
  }).filter(t => t.name);
}

async function fetchPhases() {
  const rows = await notion.queryAll(cfg.boardDbId(), {
    filter: { property: 'Type', select: { equals: 'Phase' } },
    sorts:  [{ property: 'SortOrder', direction: 'ascending' }],
  });
  return rows.map(page => {
    const p = page.properties;
    return {
      name:   propText(p, 'Name'),
      status: propSelect(p, 'Status'),
      due:    propDate(p, 'Due'),
    };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const chatId = requireConfig();
log.info('Weekly report started');

const [tasks, phases] = await Promise.all([fetchAllTasks(), fetchPhases()]);

const done    = tasks.filter(t => t.status === 'Done');
const active  = tasks.filter(t => t.status === 'Active');
const blocked = tasks.filter(t => t.status === 'Blocked');
const draft   = tasks.filter(t => t.status === 'Draft');
const overdue = active.filter(t => { const d = daysUntil(t.due); return d !== null && d < 0; });
const atrisk  = active.filter(t => { const d = daysUntil(t.due); return d !== null && d >= 0 && d <= 7; });

const weekNum = Math.ceil((new Date() - new Date(new Date().getFullYear(), 0, 1)) / 604800000);
const today   = new Date().toLocaleDateString('zh-CN', { year:'numeric', month:'long', day:'numeric' });

const lines = [
  `📊 <b>ARCBOS 周报 · Week ${weekNum}</b>`,
  `📅 ${today}`,
  '═════════════════════',
  '',
  '<b>整体执行状态</b>',
  `✅ 已完成   ${done.length} 项`,
  `🔵 进行中   ${active.length} 项`,
  `🔴 阻塞中   ${blocked.length} 项`,
  `🟠 已逾期   ${overdue.length} 项`,
  `🟡 7天内到期 ${atrisk.length} 项`,
  `🔒 待审批   ${draft.length} 项`,
  `📦 任务总计  ${tasks.length} 项`,
];

// Phase progress
if (phases.length) {
  lines.push('', '<b>阶段进度</b>');
  for (const ph of phases) {
    const phTasks  = tasks.filter(t => t.phase.toLowerCase() === ph.name.toLowerCase());
    const phDone   = phTasks.filter(t => t.status === 'Done').length;
    const pct      = phTasks.length ? Math.round((phDone / phTasks.length) * 100) : 0;
    const daysLeft = daysUntil(ph.due);
    const dueNote  = daysLeft !== null
      ? (daysLeft < 0 ? ` · ⚠️ 已逾期 ${Math.abs(daysLeft)} 天`
        : ` · ${daysLeft} 天后截止`)
      : '';
    const statusIcon = ph.status === 'Done' ? '✅' : ph.status === 'Active' ? '🔵' : '⏸';
    lines.push(`${statusIcon} ${ph.name}：${pct}% (${phDone}/${phTasks.length})${dueNote}`);
  }
}

// Issues requiring Founder attention
const issues = [];
if (blocked.length) {
  issues.push('', '<b>需要 Founder 关注</b>');
  for (const t of blocked) {
    const ref = t.taskCode || t.name;
    issues.push(`🔴 ${t.name}${t.taskCode ? ` [${t.taskCode}]` : ''} · ${t.owner}`);
    if (t.blockedBy) issues.push(`   原因：${t.blockedBy}`);
  }
}
if (overdue.length && !blocked.length) {
  issues.push('', '<b>逾期任务</b>');
  for (const t of overdue) {
    const dd = Math.abs(daysUntil(t.due));
    issues.push(`🟠 ${t.name} · ${t.owner} · 已逾期 ${dd} 天`);
  }
}
if (draft.length) {
  issues.push('', `<b>待审批任务 (${draft.length} 项)</b>`, '以下任务等待 Founder 在 Notion 中将状态改为 Active：');
  for (const t of draft) {
    issues.push(`🔒 ${t.name}${t.taskCode ? ` [${t.taskCode}]` : ''} · ${t.owner}`);
  }
}

lines.push(...issues);

// Overall health assessment
lines.push('', '═════════════════════');
if (blocked.length === 0 && overdue.length === 0) {
  lines.push('✅ 本周执行健康，无阻塞或逾期项。');
} else if (blocked.length > 0) {
  lines.push(`⚠️ 有 ${blocked.length} 个阻塞项需要 Founder 介入解决。`);
} else {
  lines.push(`⚠️ 有 ${overdue.length} 个任务已逾期，请跟进。`);
}

lines.push(`\n<a href="${BOARD_URL}">查看完整看板 →</a>`);
lines.push('\n<code>ARCBOS · Execution System</code>');

await sendMessage(chatId, lines.join('\n'));
log.info('Weekly report sent', { tasks: tasks.length, blocked: blocked.length });
