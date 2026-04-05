// src/core/command-parser.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Parses raw Telegram message text into structured command objects.
//
// Supported commands:
//   完成 <task>
//   阻塞 <task> 原因：<reason>    (full-width or half-width colon)
//   进度 <task>
//   激活 <task>                   (unblock / reactivate)
//   解除阻塞 <task>               (alias for 激活)
//   搜索 <keyword>
//   帮助
//   /help  /start                 (Telegram slash commands)
// ─────────────────────────────────────────────────────────────────────────────

export const CMD = {
  DONE:     'done',
  BLOCK:    'block',
  PROGRESS: 'progress',
  ACTIVATE: 'activate',
  SEARCH:   'search',
  HELP:     'help',
  UNKNOWN:  'unknown',
};

// Strip @BotName mentions from group messages
function stripMention(text) {
  return text.replace(/^@\S+\s*/, '').trim();
}

// Strip Telegram slash command prefix
function stripSlash(text) {
  return text.replace(/^\/\w+(@\w+)?\s*/, '').trim();
}

export function parseCommand(rawText) {
  const text = stripMention(stripSlash(rawText || '')).trim();

  // Help
  if (!text || /^帮助/.test(text) || /^\/help/i.test(rawText) || /^\/start/i.test(rawText)) {
    return { cmd: CMD.HELP };
  }

  // 完成 <task>
  const done = text.match(/^完成\s+(.+)$/);
  if (done) return { cmd: CMD.DONE, query: done[1].trim() };

  // 阻塞 <task> 原因：<reason>
  const block = text.match(/^阻塞\s+(.+?)\s+原因[：:]\s*(.+)$/);
  if (block) return { cmd: CMD.BLOCK, query: block[1].trim(), reason: block[2].trim() };

  // 进度 <task>
  const progress = text.match(/^进度\s+(.+)$/);
  if (progress) return { cmd: CMD.PROGRESS, query: progress[1].trim() };

  // 激活 / 解除阻塞 <task>
  const activate = text.match(/^(激活|解除阻塞)\s+(.+)$/);
  if (activate) return { cmd: CMD.ACTIVATE, query: activate[2].trim() };

  // 搜索 <keyword>
  const search = text.match(/^搜索\s+(.+)$/);
  if (search) return { cmd: CMD.SEARCH, query: search[1].trim() };

  return { cmd: CMD.UNKNOWN, raw: text };
}

// Help text returned to users
export const HELP_TEXT = `<b>ARCBOS 任务机器人</b>

<b>完成</b> 任务名称
  将任务标记为已完成

<b>阻塞</b> 任务名称 原因：具体原因
  记录阻塞，填写阻塞说明

<b>激活</b> 任务名称
  解除阻塞，恢复为进行中

<b>进度</b> 任务名称
  查询任务当前状态

<b>搜索</b> 关键词
  搜索包含关键词的任务

<b>帮助</b>
  显示本说明

─────────────────────────
📋 <a href="https://board.arcbos.com">board.arcbos.com</a>
任务名称支持模糊匹配，也可使用 TaskCode 精确指定。`;
