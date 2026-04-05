// src/core/task-matcher.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Task matching engine.
//
// Match priority:
//   1. TaskCode exact match (if field exists)
//   2. Name exact match (case-insensitive)
//   3. Name contains match
//
// Ambiguity: if multiple tasks match at the same priority level,
// returns all candidates so the caller can prompt the user.
// ─────────────────────────────────────────────────────────────────────────────

import { notion, propText, propSelect, propDate, propNumber } from '../lib/notion-client.mjs';
import { cfg } from '../lib/config.mjs';
import { createLogger } from '../lib/logger.mjs';

const log = createLogger('task-matcher');

// Fetch all tasks from Notion (Type = Task only)
export async function fetchAllTasks() {
  const rows = await notion.queryAll(cfg.boardDbId(), {
    filter: { property: 'Type', select: { equals: 'Task' } },
    sorts:  [{ property: 'SortOrder', direction: 'ascending' }],
  });

  return rows.map(pageToTask);
}

export function pageToTask(page) {
  const p = page.properties;
  return {
    id:        page.id,
    name:      propText(p, 'Name'),
    taskCode:  propText(p, 'TaskCode'),   // optional — empty string if not present
    status:    propSelect(p, 'Status'),
    owner:     propText(p, 'Owner'),
    phase:     propText(p, 'Phase'),
    module:    propText(p, 'Module'),
    due:       propDate(p, 'Due'),
    output:    propText(p, 'Output'),
    blockedBy: propText(p, 'BlockedBy'),
    sortOrder: propNumber(p, 'SortOrder'),
  };
}

// ── Match result types ─────────────────────────────────────────────────────

export const MATCH = {
  EXACT_CODE:  'exact_code',
  EXACT_NAME:  'exact_name',
  CONTAINS:    'contains',
  NONE:        'none',
  AMBIGUOUS:   'ambiguous',
};

// Returns { type, task, candidates }
// type: MATCH.*
// task: single matched task (or null if none/ambiguous)
// candidates: array for ambiguous case
export async function matchTask(query) {
  const q = query.trim();
  const tasks = await fetchAllTasks();

  log.debug(`Matching query`, { query: q, totalTasks: tasks.length });

  // 1. TaskCode exact match (e.g. "T-001" or "MECH-01")
  const byCode = tasks.filter(t => t.taskCode && t.taskCode.toLowerCase() === q.toLowerCase());
  if (byCode.length === 1) {
    log.info(`Matched by TaskCode`, { code: byCode[0].taskCode, name: byCode[0].name });
    return { type: MATCH.EXACT_CODE, task: byCode[0], candidates: byCode };
  }
  if (byCode.length > 1) {
    log.warn(`Ambiguous TaskCode match`, { count: byCode.length });
    return { type: MATCH.AMBIGUOUS, task: null, candidates: byCode };
  }

  // 2. Name exact match
  const byExact = tasks.filter(t => t.name.toLowerCase() === q.toLowerCase());
  if (byExact.length === 1) {
    log.info(`Matched by exact name`, { name: byExact[0].name });
    return { type: MATCH.EXACT_NAME, task: byExact[0], candidates: byExact };
  }
  if (byExact.length > 1) {
    return { type: MATCH.AMBIGUOUS, task: null, candidates: byExact };
  }

  // 3. Name contains match
  const byContains = tasks.filter(t => t.name.toLowerCase().includes(q.toLowerCase()));
  if (byContains.length === 1) {
    log.info(`Matched by contains`, { name: byContains[0].name });
    return { type: MATCH.CONTAINS, task: byContains[0], candidates: byContains };
  }
  if (byContains.length > 1) {
    return { type: MATCH.AMBIGUOUS, task: null, candidates: byContains };
  }

  log.info(`No match found`, { query: q });
  return { type: MATCH.NONE, task: null, candidates: [] };
}

// Format candidates list for Telegram reply
export function formatCandidates(candidates) {
  return candidates
    .slice(0, 6)
    .map((t, i) => {
      const code = t.taskCode ? ` [${t.taskCode}]` : '';
      return `${i + 1}. ${t.name}${code} (${t.status || 'Unknown'})`;
    })
    .join('\n');
}
