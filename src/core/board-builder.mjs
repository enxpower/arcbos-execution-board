// src/core/board-builder.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Fetches all board data from Notion and structures it into
// a hierarchy of Phase → Milestone → Task.
// Pure read — no writes.
// ─────────────────────────────────────────────────────────────────────────────

import { notion, propText, propSelect, propDate, propNumber } from '../lib/notion-client.mjs';
import { cfg } from '../lib/config.mjs';
import { createLogger } from '../lib/logger.mjs';

const log = createLogger('board-builder');

function rowToBase(page) {
  const p = page.properties;
  return {
    id:        page.id,
    name:      propText(p, 'Name'),
    type:      propSelect(p, 'Type'),
    phase:     propText(p, 'Phase'),
    status:    propSelect(p, 'Status'),
    owner:     propText(p, 'Owner'),
    due:       propDate(p, 'Due'),
    sortOrder: propNumber(p, 'SortOrder'),
  };
}

export async function fetchBoardData() {
  log.info('Fetching board data from Notion...');

  const rows = await notion.queryAll(cfg.boardDbId(), {
    sorts: [{ property: 'SortOrder', direction: 'ascending' }],
  });

  const phases = [], milestones = [], tasks = [];

  for (const row of rows) {
    const base = rowToBase(row);
    const p    = row.properties;
    if (!base.name) continue;

    if (base.type === 'Phase') {
      phases.push({ ...base, startDate: propDate(p, 'StartDate') });
    } else if (base.type === 'Milestone') {
      milestones.push(base);
    } else if (base.type === 'Task') {
      tasks.push({
        ...base,
        taskCode:  propText(p, 'TaskCode'),
        module:    propText(p, 'Module'),
        output:    propText(p, 'Output'),
        blockedBy: propText(p, 'BlockedBy'),
      });
    }
  }

  phases.sort((a,b) => a.sortOrder - b.sortOrder);
  milestones.sort((a,b) => a.sortOrder - b.sortOrder);
  tasks.sort((a,b) => a.sortOrder - b.sortOrder);

  // Attach milestones and tasks to phases
  const board = phases.map(ph => {
    const phKey = ph.name.toLowerCase();
    const ms    = milestones.filter(m => m.phase.toLowerCase() === phKey);
    const ts    = tasks.filter(t => t.phase.toLowerCase() === phKey);

    const done    = ts.filter(t => t.status === 'Done').length;
    const active  = ts.filter(t => t.status === 'Active').length;
    const blocked = ts.filter(t => t.status === 'Blocked').length;
    const draft   = ts.filter(t => t.status === 'Draft').length;
    const pct     = ts.length ? Math.round((done / ts.length) * 100) : 0;

    return { ...ph, milestones: ms, tasks: ts, pct, done, active, blocked, draft, total: ts.length };
  });

  const allBlocked = tasks.filter(t => t.status === 'Blocked');
  const totalDone  = tasks.filter(t => t.status === 'Done').length;
  const totalActive = tasks.filter(t => t.status === 'Active').length;

  const summary = {
    totalTasks: tasks.length,
    totalDone,
    totalActive,
    totalBlocked: allBlocked.length,
    totalDraft: tasks.filter(t => t.status === 'Draft').length,
    rowsFetched: rows.length,
  };

  log.info('Board data fetched', summary);

  return { board, allBlocked, summary };
}
