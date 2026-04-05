// src/lib/telegram-client.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Thin Telegram Bot API client.
// Token never logged. All errors surfaced cleanly.
// ─────────────────────────────────────────────────────────────────────────────

import { cfg } from './config.mjs';
import { createLogger } from './logger.mjs';

const log = createLogger('telegram');

function apiUrl(method) {
  return `https://api.telegram.org/bot${cfg.tgBotToken()}/${method}`;
}

export async function getUpdates(offset) {
  const url = new URL(apiUrl('getUpdates'));
  if (offset) url.searchParams.set('offset', offset);
  url.searchParams.set('limit', '100');
  url.searchParams.set('timeout', '0');
  url.searchParams.set('allowed_updates', 'message');

  const res  = await fetch(url.toString());
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram getUpdates error: ${data.description}`);
  return data.result;
}

export async function sendMessage(chatId, text, opts = {}) {
  if (cfg.dryRun) {
    log.info(`[DRY RUN] sendMessage`, { chatId, preview: text.slice(0, 80) });
    return;
  }

  try {
    const res = await fetch(apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text,
        parse_mode: 'HTML',
        ...opts,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      log.warn(`sendMessage failed`, { chatId, error: data.description });
    }
  } catch (e) {
    log.error(`sendMessage network error`, { chatId, error: e.message });
  }
}
