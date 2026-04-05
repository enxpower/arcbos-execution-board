// scripts/poll-telegram.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Telegram bot polling script.
//
// Runs via GitHub Actions cron (every 5 min).
// Pulls unread messages → parses commands → updates Notion → sends replies.
// State (last_update_id) persisted via GitHub Actions cache.
//
// Required env:
//   TG_BOT_TOKEN, NOTION_TOKEN, BOARD_DB_ID
//
// Optional env:
//   BOT_STATE_FILE, NOTION_GAP_MS, LOG_LEVEL, DRY_RUN,
//   BOARD_REFRESH_DEBOUNCE_SEC
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

const runId = Date.now().toString(36).toUpperCase();
log.info(`Bot poll started`, { runId, dryRun: cfg.dryRun });

// ── Load state ─────────────────────────────────────────────────────────────

const state      = await loadState(cfg.botStateFile);
const offset     = state.bot.last_update_id ? state.bot.last_update_id + 1 : 0;
let   maxId      = state.bot.last_update_id;
let   processed  = 0;
let   boardDirty = false; // true if any Notion write happened this run

// ── Fetch updates ──────────────────────────────────────────────────────────

const updates = await getUpdates(offset);
log.info(`Updates fetched`, { count: updates.length, offset });

// ── Handlers ───────────────────────────────────────────────────────────────

async function handleDone(chatId, query, actor) {
  const { type, task, candidates } = await matchTask(query);

  if (type === MATCH.NONE) {
    return `未找到任务「${query}」\n\n发送「<b>搜索 ${query}</b>」查看相似任务。`;
  }

  if (type === MATCH.AMBIGUOUS) {
    return `找到多个匹配任务，请用更精确的名称或 TaskCode 指定：\n\n${formatCandidates(candidates)}`;
  }

  if (!canTransition(task.status, 'Done')) {
    return transitionError(task, 'Done');
  }

  const result = await updateTaskStatus(task, 'Done', undefined, actor);
  if (!result.ok) return transitionError(task, 'Done');
  if (result.skipped) return `「${task.name}」已经是完成状态。`;

  boardDirty = true;
  const ownerNote = task.owner ? `  负责人：${task.owner}` : '';
  const dueNote   = task.due   ? `  截止：${task.due}`   : '';
  const matchNote = type === MATCH.CONTAINS ? `\n（按名称模糊匹配）` : '';
  return `✅ <b>已完成</b>：${task.name}${ownerNote}${dueNote}${matchNote}`;
}

async function handleBlock(chatId, query, reason, actor) {
  if (!reason || reason.trim().length < 3) {
    return '请填写具体的阻塞原因（至少3个字）。\n\n格式：阻塞 任务名称 原因：具体说明';
  }

  const { type, task, candidates } = await matchTask(query);

  if (type === MATCH.NONE) {
    return `未找到任务「${query}」`;
  }
  if (type === MATCH.AMBIGUOUS) {
    return `找到多个匹配任务：\n\n${formatCandidates(candidates)}`;
  }

  if (!canTransition(task.status, 'Blocked')) {
    return transitionError(task, 'Blocked');
  }

  const result = await updateTaskStatus(task, 'Blocked', reason.trim(), actor);
  if (!result.ok) return transitionError(task, 'Blocked');

  boardDirty = true;
  return `🚨 <b>已记录阻塞</b>：${task.name}\n⚠️ 原因：${reason.trim()}\n看板将在5分钟内更新。`;
}

async function handleActivate(chatId, query, actor) {
  const { type, task, candidates } = await matchTask(query);

  if (type === MATCH.NONE) return `未找到任务「${query}」`;
  if (type === MATCH.AMBIGUOUS) {
    return `找到多个匹配任务：\n\n${formatCandidates(candidates)}`;
  }

  if (!canTransition(task.status, 'Active')) {
    return transitionError(task, 'Active');
  }

  const result = await updateTaskStatus(task, 'Active', '', actor);
  if (!result.ok) return transitionError(task, 'Active');
  if (result.skipped) return `「${task.name}」已经是进行中状态。`;

  boardDirty = true;
  return `▶️ <b>已激活</b>：${task.name}\n阻塞已解除，继续进行中。`;
}

async function handleProgress(chatId, query) {
  const { type, task, candidates } = await matchTask(query);

  if (type === MATCH.NONE) return `未找到任务「${query}」`;
  if (type === MATCH.AMBIGUOUS) {
    return `找到 ${candidates.length} 个匹配任务：\n\n${formatCandidates(candidates)}`;
  }

  const statusMap = {
    Draft:'草案待审批', Active:'进行中', Done:'已完成',
    Blocked:'已阻塞', Pending:'未开始',
  };

  const statusIcon = { Done:'✅', Active:'🔄', Blocked:'🚨', Draft:'📝', Pending:'⏳' }[task.status] || '📋';
  const statusText = statusMap[task.status] || task.status;
  const code = task.taskCode ? ` [${task.taskCode}]` : '';
  let msg = `${statusIcon} <b>${task.name}</b>${code}\n状态：${statusText}`;
  if (task.owner) msg += `  负责人：${task.owner}`;
  if (task.due)   msg += `  截止：${task.due}`;
  if (task.phase) msg += `\n阶段：${task.phase}`;
  if (task.module) msg += `  模块：${task.module}`;
  if (task.blockedBy && task.status === 'Blocked') msg += `\n⚠️ 阻塞原因：${task.blockedBy}`;
  if (task.output) msg += `\n📄 输出物：${task.output}`;
  return msg;
}

async function handleSearch(query) {
  const { type, task, candidates } = await matchTask(query);

  if (type === MATCH.NONE) return `未找到包含「${query}」的任务。`;
  if (type === MATCH.EXACT_CODE || type === MATCH.EXACT_NAME || type === MATCH.CONTAINS) {
    if (candidates.length === 1) return handleProgress(null, task.name);
  }

  const list = formatCandidates(candidates);
  return `搜索「${query}」找到 ${candidates.length} 个任务：\n\n${list}\n\n发送「进度 任务名」查看详情。`;
}

// ── Process each update ────────────────────────────────────────────────────

for (const upd of updates) {
  maxId = Math.max(maxId, upd.update_id);

  const msg  = upd.message;
  if (!msg?.text) continue;

  const chatId  = msg.chat.id;
  const text    = msg.text.trim();
  const from    = msg.from?.first_name || msg.from?.username || `user:${msg.from?.id}`;
  const isGroup = msg.chat.type !== 'private';

  // In group chats: only respond if @mentioned or starts with a known keyword
  if (isGroup) {
    const stripped = text.replace(/^@\S+\s*/, '').trim();
    const isMentioned  = text.includes('@');
    const isKnownCmd   = /^(完成|阻塞|进度|激活|解除阻塞|搜索|帮助|\/help|\/start)/.test(stripped);
    if (!isMentioned && !isKnownCmd) continue;
  }

  const parsed = parseCommand(text);
  log.info(`Processing message`, {
    updateId: upd.update_id, chatId, from, cmd: parsed.cmd,
    query: parsed.query || '', isGroup,
  });

  let reply;
  try {
    switch (parsed.cmd) {
      case CMD.DONE:     reply = await handleDone(chatId, parsed.query, from); break;
      case CMD.BLOCK:    reply = await handleBlock(chatId, parsed.query, parsed.reason, from); break;
      case CMD.ACTIVATE: reply = await handleActivate(chatId, parsed.query, from); break;
      case CMD.PROGRESS: reply = await handleProgress(chatId, parsed.query); break;
      case CMD.SEARCH:   reply = await handleSearch(parsed.query); break;
      case CMD.HELP:     reply = HELP_TEXT; break;
      default:
        reply = `未识别的指令。\n\n发送「帮助」查看支持的命令。\n你发送的：${parsed.raw || text}`;
    }
  } catch (e) {
    log.error(`Command handler failed`, { cmd: parsed.cmd, error: e.message });
    reply = '操作失败，请稍后重试。';
  }

  await sendMessage(chatId, reply);
  processed++;
}

// ── Save state ─────────────────────────────────────────────────────────────

state.bot.last_update_id = maxId;
state.bot.last_run       = new Date().toISOString();
state.bot.processed_count = (state.bot.processed_count || 0) + processed;

// Record board refresh debounce timestamp if writes happened
if (boardDirty) {
  const debounceSec = cfg.boardRefreshDebounceSec;
  if (canRefreshBoard(state, debounceSec)) {
    state.board.last_refresh_triggered = new Date().toISOString();
    log.info(`Board refresh debounce triggered`, { debounceSec });
  } else {
    log.info(`Board refresh skipped (debounce active)`);
  }
}

await saveState(cfg.botStateFile, state);

log.info(`Bot poll complete`, {
  runId, processed, maxId, boardDirty,
  totalProcessed: state.bot.processed_count,
});
