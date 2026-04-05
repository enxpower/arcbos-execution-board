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
    return `「${task.name}」仍为 <b>草案 Draft</b>，等待 Founder 审批。\n审批前无法更改状态。`;
  }
  if (s === 'Done') {
    return `「${task.name}」已完成 <b>Done</b>，不允许再次修改状态。`;
  }
  return `「${task.name}」当前状态为 <b>${s}</b>，无法变更为 <b>${toStatus}</b>。`;
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

  // ── Invariant enforcement ──────────────────────────────────────────────
  // Invariant 1: Done tasks MUST have empty BlockedBy
  if (toStatus === 'Done') {
    properties['BlockedBy'] = { rich_text: [] };
    if (task.blockedBy) {
      log.info(`Clearing BlockedBy on Done transition`, { task: task.name });
    }
  }
  // Invariant 2: Active tasks MUST have empty BlockedBy
  else if (toStatus === 'Active') {
    properties['BlockedBy'] = { rich_text: [] };
  }
  // Invariant 3: Blocked MUST have a non-empty reason
  else if (toStatus === 'Blocked') {
    const reason = typeof blockedBy === 'string' ? blockedBy.trim() : '';
    if (!reason) {
      log.warn(`Block attempted without reason`, { task: task.name });
      return { ok: false, reason: 'missing_block_reason' };
    }
    properties['BlockedBy'] = { rich_text: richText(reason) };
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
