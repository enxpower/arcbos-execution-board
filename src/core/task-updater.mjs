// src/core/task-updater.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Task state transition engine.
//
// State machine rules:
//   Draft    → Active         (Founder only, via Notion — bot cannot do this)
//   Active   → Done           ✓ bot allowed
//   Active   → Blocked        ✓ bot allowed (requires reason)
//   Blocked  → Active         ✓ bot allowed (unblock)
//   Blocked  → Done           ✓ bot allowed
//   Done     → *              ✗ terminal, no transitions allowed
//   Draft    → Done/Blocked   ✗ must be approved first
//
// Write deduplication: skips PATCH if status and blockedBy are already identical.
// ─────────────────────────────────────────────────────────────────────────────

import { notion, richText } from '../lib/notion-client.mjs';
import { cfg } from '../lib/config.mjs';
import { createLogger } from '../lib/logger.mjs';

const log = createLogger('task-updater');

// ── Transition rules ───────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS = {
  Active:  ['Done', 'Blocked'],
  Blocked: ['Active', 'Done'],
};

export function canTransition(fromStatus, toStatus) {
  return (ALLOWED_TRANSITIONS[fromStatus] || []).includes(toStatus);
}

export function transitionError(task, toStatus) {
  const s = task.status;
  if (s === 'Draft') {
    return `「${task.name}」is still <b>Draft</b> and awaiting Founder approval.\nStatus cannot be changed until approved.`;
  }
  if (s === 'Done') {
    return `「${task.name}」is already <b>Done</b>. No further status changes allowed.`;
  }
  return `Cannot change「${task.name}」from <b>${s}</b> to <b>${toStatus}</b>.`;
}

// ── Update with dedup ─────────────────────────────────────────────────────

export async function updateTaskStatus(task, toStatus, blockedBy, actor) {
  const dbId = cfg.boardDbId();

  // Check transition is allowed
  if (!canTransition(task.status, toStatus)) {
    log.warn(`Transition blocked`, {
      task: task.name, from: task.status, to: toStatus, actor,
    });
    return { ok: false, reason: 'invalid_transition' };
  }

  // Dedup — skip write if nothing changed
  const newBlockedBy = typeof blockedBy === 'string' ? blockedBy : task.blockedBy;
  if (task.status === toStatus && task.blockedBy === newBlockedBy) {
    log.info(`Skipping write — no change`, { task: task.name, status: toStatus, actor });
    return { ok: true, skipped: true };
  }

  // Build properties
  const properties = {
    Status: { select: { name: toStatus } },
  };

  if (typeof blockedBy === 'string') {
    properties['BlockedBy'] = { rich_text: richText(blockedBy) };
  }

  // Clear BlockedBy when unblocking
  if (toStatus === 'Active' && task.status === 'Blocked') {
    properties['BlockedBy'] = { rich_text: [] };
  }

  await notion.updatePage(task.id, properties, `updateTask:${task.id.slice(0,8)}`);

  log.info(`Task updated`, {
    task: task.name,
    from: task.status,
    to:   toStatus,
    blockedBy: blockedBy || '',
    actor,
  });

  return { ok: true, skipped: false };
}
