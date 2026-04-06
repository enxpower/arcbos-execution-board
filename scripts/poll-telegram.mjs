// scripts/poll-telegram.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Telegram bot polling — GitHub Actions cron, every 5 min.
//
// Idempotency: offset advanced BEFORE processing (early-advance pattern).
// A crash mid-run drops at most the current batch rather than replaying.
// task-updater dedup prevents double-write if a message is somehow re-seen.
//
// Required env: TG_BOT_TOKEN, NOTION_TOKEN, BOARD_DB_ID
// Optional env: BOT_STATE_FILE, NOTION_GAP_MS, LOG_LEVEL, DRY_RUN,
//               BOARD_REFRESH_DEBOUNCE_SEC
// ─────────────────────────────────────────────────────────────────────────────

import { requireBotConfig, cfg } from '../src/lib/config.mjs';
import { createLogger } from '../src/lib/logger.mjs';
import { getUpdates, sendMessage } from '../src/lib/telegram-client.mjs';
import { loadState, saveState, canRefreshBoard } from '../src/lib/state.mjs';
import { matchTask, MATCH, formatCandidates } from '../src/core/task-matcher.mjs';
import { updateTaskStatus, transitionError, canTransition } from '../src/core/task-updater.mjs';
import { CMD, parseCommand, HELP_TEXT } from '../src/core/command-parser.mjs';

const log = createLogger('tg-bot');

requireBotConfig();

// ── Per-chat task index cache (for numeric shortcuts) ─────────────────────────
// Stores the last task list sent to each chat so engineers can use '完成 1' etc.
const taskIndexCache = new Map(); // chatId -> Task[]

function setChatTasks(chatId, tasks) {
  taskIndexCache.set(String(chatId), tasks);
}

function getTaskByIndex(chatId, index) {
  const tasks = taskIndexCache.get(String(chatId)) || [];
  return tasks[index] || null;
}


const runId = Date.now().toString(36).toUpperCase();
log.info('Bot poll started', { runId, dryRun: cfg.dryRun });

// ── Load state ──────────────────────────────────────────────────────────────

const state      = await loadState(cfg.botStateFile);
const offset     = state.bot.last_update_id ? state.bot.last_update_id + 1 : 0;
let   maxId      = state.bot.last_update_id;
let   processed  = 0;
let   boardDirty = false;

// ── Fetch updates ───────────────────────────────────────────────────────────

const updates = await getUpdates(offset);
log.info('Updates fetched', { count: updates.length, offset, runId });

if (!updates.length) {
  state.bot.last_run = new Date().toISOString();
  await saveState(cfg.botStateFile, state);
  log.info('Bot poll complete — no updates', { runId });
  process.exit(0);
}

// ── EARLY OFFSET ADVANCE ────────────────────────────────────────────────────
// Advance maxId before processing so a mid-run crash doesn't cause replay.

for (const upd of updates) maxId = Math.max(maxId, upd.update_id);
state.bot.last_update_id = maxId;
state.bot.last_run       = new Date().toISOString();
await saveState(cfg.botStateFile, state);
log.info('Offset advanced (early)', { newMaxId: maxId });

// ── Formatters ──────────────────────────────────────────────────────────────

const STATUS_ZH = {
  Done:'已完成', Active:'进行中', Blocked:'阻塞中',
  Draft:'待审批', Pending:'未开始',
};

function fmtStatus(s) { return STATUS_ZH[s] || s || '—'; }

function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('zh-CN', {
      year:'numeric', month:'2-digit', day:'2-digit',
    });
  } catch { return String(d); }
}

const SYS_TAG = '\n\n<code>ARCBOS · Execution System</code>';

function buildActionReply({ headline, task, note }) {
  const lines = [`<b>${headline}</b>`, '─────────────────────'];
  if (task.taskCode) lines.push(`TaskCode : <code>${task.taskCode}</code>`);
  lines.push(`任务名称 : ${task.name}`);
  lines.push(`当前状态 : ${fmtStatus(task.status)}`);
  if (task.owner)     lines.push(`负责人   : ${task.owner}`);
  if (task.due)       lines.push(`截止日期 : ${fmtDate(task.due)}`);
  if (task.phase)     lines.push(`所属阶段 : ${task.phase}`);
  if (task.blockedBy && task.status === 'Blocked')
    lines.push(`阻塞原因 : ${task.blockedBy}`);
  if (note) { lines.push('─────────────────────'); lines.push(note); }
  lines.push(SYS_TAG);
  return lines.join('\n');
}

function buildQueryReply(task) {
  const icon = { Done:'✅', Active:'🔵', Blocked:'🚨', Draft:'🔒', Pending:'⏸' }[task.status] || '❓';
  const lines = [`${icon} <b>任务状态查询</b>`, '─────────────────────'];
  if (task.taskCode)  lines.push(`TaskCode : <code>${task.taskCode}</code>`);
  lines.push(`任务名称 : ${task.name}`);
  lines.push(`当前状态 : ${fmtStatus(task.status)}`);
  if (task.owner)     lines.push(`负责人   : ${task.owner}`);
  if (task.due)       lines.push(`截止日期 : ${fmtDate(task.due)}`);
  if (task.phase)     lines.push(`所属阶段 : ${task.phase}`);
  if (task.module)    lines.push(`模块     : ${task.module}`);
  if (task.blockedBy && task.status === 'Blocked')
    lines.push(`阻塞原因 : ${task.blockedBy}`);
  if (task.output)    lines.push(`交付物   : ${task.output}`);
  lines.push(SYS_TAG);
  return lines.join('\n');
}

function buildErrorReply(msg) {
  return `⚠️ <b>操作无法执行</b>\n─────────────────────\n${msg}${SYS_TAG}`;
}

function buildNotFoundReply(query) {
  return [
    '❌ <b>未找到匹配任务</b>',
    '─────────────────────',
    `查询条件 : ${query}`,
    '',
    '建议使用 TaskCode 精确匹配，',
    '或发送 <b>搜索 关键词</b> 查看候选列表。',
    SYS_TAG,
  ].join('\n');
}

function buildAmbiguousReply(query, candidates) {
  return [
    '🔍 <b>找到多个匹配任务</b>',
    '─────────────────────',
    `查询条件 : ${query}`,
    '',
    '候选列表：',
    formatCandidates(candidates),
    '',
    '请使用 TaskCode 或完整任务名称重新指定。',
    SYS_TAG,
  ].join('\n');
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleDone(chatId, query, actor) {
  log.info('[handler:done] start', { query, actor });
  const { type, task, candidates } = await matchTask(query);

  if (type === MATCH.NONE)      return buildNotFoundReply(query);
  if (type === MATCH.AMBIGUOUS) return buildAmbiguousReply(query, candidates);

  log.info('[match] found', {
    taskCode: task.taskCode, name: task.name,
    currentStatus: task.status, targetStatus: 'Done', matchType: type,
  });

  if (!canTransition(task.status, 'Done')) {
    log.warn('[transition] rejected', { task: task.name, from: task.status, to: 'Done' });
    return buildErrorReply(transitionError(task, 'Done'));
  }

  const result = await updateTaskStatus(task, 'Done', undefined, actor);
  log.info('[notion] write result', { task: task.name, ok: result.ok, skipped: result.skipped });

  if (!result.ok) return buildErrorReply(transitionError(task, 'Done'));

  if (result.skipped) {
    return buildActionReply({
      headline: '✅ 任务已完成（状态未变）',
      task: { ...task, status: 'Done' },
      note: '任务已处于完成状态，无需重复操作。',
    });
  }

  boardDirty = true;
  const matchNote = type === MATCH.CONTAINS
    ? '已通过模糊匹配记录。建议后续使用 TaskCode。'
    : '状态变更已写入 Notion。';
  return buildActionReply({
    headline: '✅ 任务已完成',
    task: { ...task, status: 'Done' },
    note: matchNote,
  });
}

async function handleBlock(chatId, query, reason, actor) {
  log.info('[handler:block] start', { query, reason: reason?.slice(0, 40), actor });

  if (!reason || reason.trim().length < 3) {
    return buildErrorReply(
      '阻塞原因不足，请提供至少3个字的说明。\n\n' +
      '格式：<code>阻塞 TASKCODE 原因：具体说明</code>'
    );
  }

  const { type, task, candidates } = await matchTask(query);
  if (type === MATCH.NONE)      return buildNotFoundReply(query);
  if (type === MATCH.AMBIGUOUS) return buildAmbiguousReply(query, candidates);

  log.info('[match] found', {
    taskCode: task.taskCode, name: task.name,
    currentStatus: task.status, targetStatus: 'Blocked', matchType: type,
  });

  if (!canTransition(task.status, 'Blocked')) {
    log.warn('[transition] rejected', { task: task.name, from: task.status, to: 'Blocked' });
    return buildErrorReply(transitionError(task, 'Blocked'));
  }

  const result = await updateTaskStatus(task, 'Blocked', reason.trim(), actor);
  log.info('[notion] write result', { task: task.name, ok: result.ok, skipped: result.skipped });

  if (!result.ok) return buildErrorReply(transitionError(task, 'Blocked'));

  boardDirty = true;
  return buildActionReply({
    headline: '🚨 任务已标记为阻塞',
    task: { ...task, status: 'Blocked', blockedBy: reason.trim() },
    note: '阻塞状态已写入 Notion，看板将在5分钟内更新。',
  });
}

async function handleActivate(chatId, query, actor) {
  log.info('[handler:activate] start', { query, actor });
  const { type, task, candidates } = await matchTask(query);

  if (type === MATCH.NONE)      return buildNotFoundReply(query);
  if (type === MATCH.AMBIGUOUS) return buildAmbiguousReply(query, candidates);

  log.info('[match] found', {
    taskCode: task.taskCode, name: task.name,
    currentStatus: task.status, targetStatus: 'Active', matchType: type,
  });

  if (!canTransition(task.status, 'Active')) {
    log.warn('[transition] rejected', { task: task.name, from: task.status, to: 'Active' });
    return buildErrorReply(transitionError(task, 'Active'));
  }

  const result = await updateTaskStatus(task, 'Active', '', actor);
  log.info('[notion] write result', { task: task.name, ok: result.ok, skipped: result.skipped });

  if (!result.ok) return buildErrorReply(transitionError(task, 'Active'));

  if (result.skipped) {
    return buildActionReply({
      headline: '🔵 任务已处于进行中（无变更）',
      task: { ...task, status: 'Active' },
    });
  }

  boardDirty = true;
  return buildActionReply({
    headline: '🔵 任务已恢复为进行中',
    task: { ...task, status: 'Active', blockedBy: '' },
    note: '阻塞已解除，状态已更新。',
  });
}

async function handleProgress(chatId, query) {
  log.info('[handler:progress] start', { query });
  const { type, task, candidates } = await matchTask(query);

  if (type === MATCH.NONE)      return buildNotFoundReply(query);
  if (type === MATCH.AMBIGUOUS) return buildAmbiguousReply(query, candidates);

  log.info('[match] found', { taskCode: task.taskCode, name: task.name, status: task.status });
  return buildQueryReply(task);
}

async function handleSearch(query) {
  log.info('[handler:search] start', { query });
  const { type, task, candidates } = await matchTask(query);

  if (type === MATCH.NONE) return buildNotFoundReply(query);

  if (candidates.length === 1) return buildQueryReply(candidates[0]);

  return [
    '🔍 <b>搜索结果</b>',
    '─────────────────────',
    `关键词 : ${query}`,
    `共找到 : ${candidates.length} 个任务`,
    '',
    formatCandidates(candidates),
    '',
    '发送 <b>进度 TASKCODE</b> 查看任务详情。',
    SYS_TAG,
  ].join('\n');
}

// ── Shortcut handler ────────────────────────────────────────────────────────
async function handleShortcut(chatId, parsed, actor) {
  const { action, index, reason } = parsed;
  const task = getTaskByIndex(chatId, index);

  if (!task) {
    return [
      '❓ <b>序号无效</b>',
      '─────────────────────',
      `序号 ${index + 1} 不存在。`,
      '',
      '请先发送 <b>搜索 关键词</b> 或 <b>帮助</b> 查看任务列表，再使用序号。',
      SYS_TAG,
    ].join('\n');
  }

  if (action === 'done')     return (await handleDone(chatId, task.taskCode || task.name, actor)).reply;
  if (action === 'block')    return (await handleBlock(chatId, task.taskCode || task.name, reason, actor)).reply;
  if (action === 'activate') return (await handleActivate(chatId, task.taskCode || task.name, actor)).reply;
  if (action === 'progress') return (await handleProgress(chatId, task.taskCode || task.name)).reply;
  return buildErrorReply('未知快捷操作。');
}

// ── Process updates ─────────────────────────────────────────────────────────

for (const upd of updates) {
  const msg = upd.message;
  if (!msg?.text) continue;

  const chatId  = msg.chat.id;
  const text    = msg.text.trim();
  const from    = msg.from?.first_name || msg.from?.username || `user:${msg.from?.id}`;
  const isGroup = msg.chat.type !== 'private';

  if (isGroup) {
    const stripped  = text.replace(/^@\S+\s*/, '').trim();
    const mentioned = text.includes('@');
    const knownCmd  = /^(完成|阻塞|进度|激活|解除阻塞|搜索|帮助|\/help|\/start)/.test(stripped);
    if (!mentioned && !knownCmd) continue;
  }

  const parsed = parseCommand(text);
  log.info('[update] processing', {
    updateId: upd.update_id, chatId, from,
    cmd: parsed.cmd, query: parsed.query || '', isGroup,
  });

  let reply;
  try {
    switch (parsed.cmd) {
      case CMD.DONE:     reply = await handleDone(chatId, parsed.query, from);                 break;
      case CMD.BLOCK:    reply = await handleBlock(chatId, parsed.query, parsed.reason, from); break;
      case CMD.ACTIVATE: reply = await handleActivate(chatId, parsed.query, from);            break;
      case CMD.PROGRESS: reply = await handleProgress(chatId, parsed.query);                  break;
      case CMD.SEARCH:   reply = await handleSearch(parsed.query);                            break;
      case CMD.SHORTCUT: reply = await handleShortcut(chatId, parsed, from);                  break;
      case CMD.HELP:     reply = HELP_TEXT;                                                    break;
      default:
        reply = buildErrorReply(
          `未识别的指令：<code>${parsed.raw || text}</code>\n\n发送 <b>帮助</b> 查看支持的命令列表。`
        );
    }
  } catch (e) {
    log.error('[handler] exception', { cmd: parsed.cmd, error: e.message });
    reply = buildErrorReply('系统内部错误，请稍后重试。');
  }

  try {
    await sendMessage(chatId, reply);
    log.info('[telegram] reply sent', { updateId: upd.update_id, chatId });
  } catch (e) {
    log.error('[telegram] reply failed', { updateId: upd.update_id, chatId, error: e.message });
  }

  processed++;
}

// ── Final state save ────────────────────────────────────────────────────────
// maxId + last_run already saved in early-advance above.
// Update processed_count and board refresh debounce here.

state.bot.processed_count = (state.bot.processed_count || 0) + processed;

if (boardDirty) {
  const debounceSec = cfg.boardRefreshDebounceSec;
  if (canRefreshBoard(state, debounceSec)) {
    state.board.last_refresh_triggered = new Date().toISOString();
    log.info('[board] refresh debounce triggered', { debounceSec });
  } else {
    log.info('[board] refresh skipped — debounce active');
  }
}

await saveState(cfg.botStateFile, state);

log.info('Bot poll complete', {
  runId, processed, maxId, boardDirty,
  totalProcessed: state.bot.processed_count,
});
