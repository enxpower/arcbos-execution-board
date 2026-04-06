// server/webhook.mjs
// ─────────────────────────────────────────────────────────────────────────────
// ARCBOS Telegram Webhook Server
// Replaces GitHub Actions cron polling with real-time webhook.
//
// Architecture:
//   Telegram → HTTPS POST /webhook → this server → src/ modules → Notion
//
// Reuses 100% of existing business logic from src/.
// No polling. Instant response.
//
// Required env (in /opt/arcbos-bot/.env):
//   TG_BOT_TOKEN, NOTION_TOKEN, BOARD_DB_ID,
//   WEBHOOK_SECRET, GITHUB_TOKEN, GITHUB_REPO
//
// Optional env:
//   PORT (default 3456), LOG_LEVEL, NOTION_GAP_MS, DRY_RUN
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Load .env ─────────────────────────────────────────────────────────────────
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

// ── Imports from existing src/ ────────────────────────────────────────────────
import { cfg, requireBotConfig } from '../src/lib/config.mjs';
import { createLogger } from '../src/lib/logger.mjs';
import { sendMessage } from '../src/lib/telegram-client.mjs';
import { matchTask, MATCH, formatCandidates } from '../src/core/task-matcher.mjs';
import { updateTaskStatus, transitionError, canTransition } from '../src/core/task-updater.mjs';
import { CMD, parseCommand, HELP_TEXT } from '../src/core/command-parser.mjs';

requireBotConfig();

const log  = createLogger('webhook');
const PORT = parseInt(process.env.PORT || '3456', 10);
const SECRET = process.env.WEBHOOK_SECRET || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO  = process.env.GITHUB_REPO  || '';

if (!SECRET) log.warn('WEBHOOK_SECRET not set — endpoint is unprotected');

// ── Message formatters (copied from poll-telegram.mjs) ────────────────────────

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

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleDone(query, actor) {
  const { type, task, candidates } = await matchTask(query);
  if (type === MATCH.NONE)      return { reply: buildNotFoundReply(query), dirty: false };
  if (type === MATCH.AMBIGUOUS) return { reply: buildAmbiguousReply(query, candidates), dirty: false };

  log.info('[match]', { taskCode: task.taskCode, name: task.name, from: task.status, to: 'Done' });

  if (!canTransition(task.status, 'Done')) {
    return { reply: buildErrorReply(transitionError(task, 'Done')), dirty: false };
  }

  const result = await updateTaskStatus(task, 'Done', undefined, actor);
  log.info('[notion]', { task: task.name, ok: result.ok, skipped: result.skipped });

  if (!result.ok) return { reply: buildErrorReply(transitionError(task, 'Done')), dirty: false };
  if (result.skipped) {
    return { reply: buildActionReply({ headline:'✅ 任务已完成（状态未变）', task:{...task,status:'Done'}, note:'任务已处于完成状态。' }), dirty: false };
  }

  const note = type === MATCH.CONTAINS ? '已通过模糊匹配记录。建议后续使用 TaskCode。' : '状态变更已写入 Notion。';
  return { reply: buildActionReply({ headline:'✅ 任务已完成', task:{...task,status:'Done'}, note }), dirty: true };
}

async function handleBlock(query, reason, actor) {
  if (!reason || reason.trim().length < 3) {
    return { reply: buildErrorReply('阻塞原因不足，请提供至少3个字的说明。\n\n格式：<code>阻塞 TASKCODE 原因：具体说明</code>'), dirty: false };
  }

  const { type, task, candidates } = await matchTask(query);
  if (type === MATCH.NONE)      return { reply: buildNotFoundReply(query), dirty: false };
  if (type === MATCH.AMBIGUOUS) return { reply: buildAmbiguousReply(query, candidates), dirty: false };

  log.info('[match]', { taskCode: task.taskCode, name: task.name, from: task.status, to: 'Blocked' });

  if (!canTransition(task.status, 'Blocked')) {
    return { reply: buildErrorReply(transitionError(task, 'Blocked')), dirty: false };
  }

  const result = await updateTaskStatus(task, 'Blocked', reason.trim(), actor);
  log.info('[notion]', { task: task.name, ok: result.ok, skipped: result.skipped });

  if (!result.ok) return { reply: buildErrorReply(transitionError(task, 'Blocked')), dirty: false };

  return {
    reply: buildActionReply({ headline:'🚨 任务已标记为阻塞', task:{...task,status:'Blocked',blockedBy:reason.trim()}, note:'阻塞状态已写入 Notion，看板将在数分钟内更新。' }),
    dirty: true,
  };
}

async function handleActivate(query, actor) {
  const { type, task, candidates } = await matchTask(query);
  if (type === MATCH.NONE)      return { reply: buildNotFoundReply(query), dirty: false };
  if (type === MATCH.AMBIGUOUS) return { reply: buildAmbiguousReply(query, candidates), dirty: false };

  log.info('[match]', { taskCode: task.taskCode, name: task.name, from: task.status, to: 'Active' });

  if (!canTransition(task.status, 'Active')) {
    return { reply: buildErrorReply(transitionError(task, 'Active')), dirty: false };
  }

  const result = await updateTaskStatus(task, 'Active', '', actor);
  log.info('[notion]', { task: task.name, ok: result.ok, skipped: result.skipped });

  if (!result.ok) return { reply: buildErrorReply(transitionError(task, 'Active')), dirty: false };
  if (result.skipped) {
    return { reply: buildActionReply({ headline:'🔵 任务已处于进行中（无变更）', task:{...task,status:'Active'} }), dirty: false };
  }

  return { reply: buildActionReply({ headline:'🔵 任务已恢复为进行中', task:{...task,status:'Active',blockedBy:''}, note:'阻塞已解除，状态已更新。' }), dirty: true };
}

async function handleProgress(query) {
  const { type, task, candidates } = await matchTask(query);
  if (type === MATCH.NONE)      return { reply: buildNotFoundReply(query), dirty: false };
  if (type === MATCH.AMBIGUOUS) return { reply: buildAmbiguousReply(query, candidates), dirty: false };
  return { reply: buildQueryReply(task), dirty: false };
}

async function handleSearch(query) {
  const { type, task, candidates } = await matchTask(query);
  if (type === MATCH.NONE) return { reply: buildNotFoundReply(query), dirty: false };
  if (candidates.length === 1) return { reply: buildQueryReply(candidates[0]), dirty: false };

  return {
    reply: ['🔍 <b>搜索结果</b>', '─────────────────────', `关键词 : ${query}`, `共找到 : ${candidates.length} 个任务`, '', formatCandidates(candidates), '', '发送 <b>进度 TASKCODE</b> 查看任务详情。', SYS_TAG].join('\n'),
    dirty: false,
  };
}

// ── Trigger GitHub Actions board publish ──────────────────────────────────────

async function triggerBoardPublish() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    log.warn('[board] GITHUB_TOKEN or GITHUB_REPO not set, skipping publish trigger');
    return;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/board-publish.yml/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (res.status === 204) {
      log.info('[board] publish triggered via GitHub API');
    } else {
      log.warn('[board] publish trigger failed', { status: res.status });
    }
  } catch (e) {
    log.error('[board] publish trigger error', { error: e.message });
  }
}

// ── Process one Telegram update ───────────────────────────────────────────────

async function processUpdate(upd) {
  const msg = upd.message;
  if (!msg?.text) return;

  const chatId  = msg.chat.id;
  const text    = msg.text.trim();
  const from    = msg.from?.first_name || msg.from?.username || `user:${msg.from?.id}`;
  const isGroup = msg.chat.type !== 'private';

  if (isGroup) {
    const stripped  = text.replace(/^@\S+\s*/, '').trim();
    const mentioned = text.includes('@');
    const knownCmd  = /^(完成|阻塞|进度|激活|解除阻塞|搜索|帮助|\/help|\/start)/.test(stripped);
    if (!mentioned && !knownCmd) return;
  }

  const parsed = parseCommand(text);
  log.info('[update]', { updateId: upd.update_id, chatId, from, cmd: parsed.cmd, query: parsed.query || '' });

  let result = { reply: '', dirty: false };

  try {
    switch (parsed.cmd) {
      case CMD.DONE:     result = await handleDone(parsed.query, from);                    break;
      case CMD.BLOCK:    result = await handleBlock(parsed.query, parsed.reason, from);    break;
      case CMD.ACTIVATE: result = await handleActivate(parsed.query, from);               break;
      case CMD.PROGRESS: result = await handleProgress(parsed.query);                     break;
      case CMD.SEARCH:   result = await handleSearch(parsed.query);                       break;
      case CMD.HELP:     result = { reply: HELP_TEXT, dirty: false };                      break;
      default:
        result = { reply: buildErrorReply(`未识别的指令：<code>${parsed.raw || text}</code>\n\n发送 <b>帮助</b> 查看支持的命令列表。`), dirty: false };
    }
  } catch (e) {
    log.error('[handler] exception', { error: e.message });
    result = { reply: buildErrorReply('系统内部错误，请稍后重试。'), dirty: false };
  }

  await sendMessage(chatId, result.reply);
  log.info('[telegram] reply sent', { chatId, updateId: upd.update_id });

  if (result.dirty) {
    // Fire-and-forget board publish
    triggerBoardPublish().catch(() => {});
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'arcbos-tgbot', ts: new Date().toISOString() }));
    return;
  }

  // Webhook endpoint
  if (req.method === 'POST' && req.url === '/webhook') {
    // Validate secret
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (SECRET && secret !== SECRET) {
      log.warn('[webhook] invalid secret');
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Read body
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      // Always respond 200 immediately — Telegram retries if it doesn't get 200
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');

      try {
        const upd = JSON.parse(body);
        await processUpdate(upd);
      } catch (e) {
        log.error('[webhook] processing error', { error: e.message });
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  log.info(`Webhook server started`, { port: PORT, url: `https://tgbot.arcbos.com/webhook` });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  log.info('SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  log.info('SIGINT received, shutting down');
  server.close(() => process.exit(0));
});
