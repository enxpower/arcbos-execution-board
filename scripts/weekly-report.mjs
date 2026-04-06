// scripts/weekly-report.mjs
// v1.2 — Founder-only, decision-grade, minimal noise
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
      name:      propText(p, 'Name'),
      taskCode:  propText(p, 'TaskCode'),
      status:    propSelect(p, 'Status'),
      owner:     propText(p, 'Owner') || '未指派',
      phase:     propText(p, 'Phase'),
      due:       propDate(p, 'Due'),
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

const weekNum = Math.ceil((new Date() - new Date(new Date().getFullYear(), 0, 1)) / 604800000);
const today   = new Date().toLocaleDateString('zh-CN', {
  year:'numeric', month:'long', day:'numeric',
});

// ── One-line verdict ──────────────────────────────────────────────────────────
const isHealthy = blocked.length === 0 && overdue.length === 0;
const verdict   = isHealthy
  ? `✅ <b>本周执行健康</b>`
  : `⚠️ <b>本周有问题需处理</b>`;

const lines = [
  `${verdict}`,
  `📊 Week ${weekNum} · ${today}`,
  `<a href="${BOARD_URL}">打开完整看板 →</a>`,
  '═════════════════════',
];

// ── Phase progress — the most important view for Founder ──────────────────────
if (phases.length) {
  lines.push('<b>阶段进度</b>');
  for (const ph of phases) {
    const phTasks = tasks.filter(t => t.phase.toLowerCase() === ph.name.toLowerCase());
    const phDone  = phTasks.filter(t => t.status === 'Done').length;
    const pct     = phTasks.length ? Math.round((phDone / phTasks.length) * 100) : 0;
    const dl      = daysUntil(ph.due);
    const dueNote = dl === null ? ''
      : dl < 0  ? ` · ⚠️ 逾期${Math.abs(dl)}天`
      : dl <= 14 ? ` · ⏰ ${dl}天后截止`
      : ` · ${dl}天后截止`;
    const icon    = ph.status === 'Done' ? '✅' : ph.status === 'Active' ? '🔵' : '⏸';
    const bar     = '█'.repeat(Math.round(pct/10)) + '░'.repeat(10-Math.round(pct/10));
    lines.push(`${icon} ${ph.name}`);
    lines.push(`   ${bar} ${pct}%  ${phDone}/${phTasks.length} 完成${dueNote}`);
  }
  lines.push('');
}

// ── Numbers ───────────────────────────────────────────────────────────────────
lines.push('<b>本周数字</b>');
lines.push(`✅ 已完成  ${done.length} 项`);
lines.push(`🔵 进行中  ${active.length} 项`);
lines.push(`🔴 阻塞中  ${blocked.length} 项`);
lines.push(`🟠 已逾期  ${overdue.length} 项`);
if (draft.length) lines.push(`🔒 待审批  ${draft.length} 项  ← 需要你批`);

// ── Action items for Founder — only what needs Founder decision ───────────────
const actionItems = [];

if (blocked.length) {
  actionItems.push('');
  actionItems.push('<b>需要你介入的阻塞：</b>');
  for (const t of blocked) {
    actionItems.push(`🔴 ${t.name}${t.taskCode ? ` [${t.taskCode}]` : ''} · ${t.owner}`);
    if (t.blockedBy) actionItems.push(`   → ${t.blockedBy}`);
  }
}

if (overdue.length) {
  actionItems.push('');
  actionItems.push('<b>逾期未完成：</b>');
  for (const t of overdue) {
    const dd = Math.abs(daysUntil(t.due));
    actionItems.push(`🟠 ${t.name}${t.taskCode ? ` [${t.taskCode}]` : ''} · ${t.owner} · 逾期${dd}天`);
  }
}

if (draft.length) {
  actionItems.push('');
  actionItems.push('<b>等待审批（在 Notion 改 Active）：</b>');
  for (const t of draft) {
    actionItems.push(`🔒 ${t.name}${t.taskCode ? ` [${t.taskCode}]` : ''} · ${t.owner}`);
  }
}

if (actionItems.length) {
  lines.push(...actionItems);
}

lines.push('');
lines.push('═════════════════════');
lines.push(isHealthy
  ? '项目执行正常，继续保持。'
  : '请处理上述阻塞/逾期项，防止延误。');
lines.push('\n<code>ARCBOS · Execution System</code>');

await sendMessage(chatId, lines.join('\n'));
log.info('Weekly report sent', {
  tasks: tasks.length, blocked: blocked.length, overdue: overdue.length,
});
