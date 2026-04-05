// scripts/prepare.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Prepare script — schema validation and pre-flight checks.
// Run manually or on low-frequency schedule.
// Does NOT modify task statuses. Safe to run at any time.
//
// Checks:
//   - All Type values are valid (Phase / Milestone / Task)
//   - All Status values are valid
//   - Tasks have Phase, Owner, Due set
//   - SortOrder is set (warns if missing)
//   - Orphaned Milestones/Tasks (Phase name doesn't match any Phase row)
//
// Required env: NOTION_TOKEN, BOARD_DB_ID
// ─────────────────────────────────────────────────────────────────────────────

import { requireBoardConfig, cfg } from '../src/lib/config.mjs';
import { createLogger } from '../src/lib/logger.mjs';
import { notion, propText, propSelect, propDate, propNumber } from '../src/lib/notion-client.mjs';

const log = createLogger('prepare');

requireBoardConfig();

log.info('Running prepare checks...');

const rows = await notion.queryAll(cfg.boardDbId(), {
  sorts: [{ property: 'SortOrder', direction: 'ascending' }],
});

const VALID_TYPES   = new Set(['Phase', 'Milestone', 'Task']);
const VALID_STATUSES = new Set(['Pending', 'Active', 'Done', 'Blocked', 'Draft']);

const phases = new Set();
const warnings = [];
const errors   = [];

let phaseCount = 0, msCount = 0, taskCount = 0;

for (const row of rows) {
  const p      = row.properties;
  const name   = propText(p, 'Name');
  const type   = propSelect(p, 'Type');
  const status = propSelect(p, 'Status');
  const phase  = propText(p, 'Phase');
  const owner  = propText(p, 'Owner');
  const due    = propDate(p, 'Due');
  const sort   = propNumber(p, 'SortOrder');
  const id     = row.id.slice(0, 8);

  if (!name) { warnings.push(`[${id}] Row has no Name — skipped`); continue; }

  if (!VALID_TYPES.has(type)) {
    errors.push(`[${id}] "${name}": invalid Type "${type}" (expected Phase/Milestone/Task)`);
    continue;
  }

  if (status && !VALID_STATUSES.has(status)) {
    errors.push(`[${id}] "${name}": invalid Status "${status}"`);
  }

  if (sort === 9999) {
    warnings.push(`[${id}] "${name}": SortOrder not set — will sort last`);
  }

  if (type === 'Phase') {
    phases.add(name.toLowerCase());
    phaseCount++;
  } else if (type === 'Milestone') {
    msCount++;
    if (!phase) warnings.push(`[${id}] Milestone "${name}": Phase field is empty`);
  } else if (type === 'Task') {
    taskCount++;
    if (!phase)  warnings.push(`[${id}] Task "${name}": Phase field is empty`);
    if (!owner)  warnings.push(`[${id}] Task "${name}": Owner field is empty`);
    if (!due)    warnings.push(`[${id}] Task "${name}": Due date not set`);
  }
}

// Check for orphaned rows (Phase name not found)
for (const row of rows) {
  const p     = row.properties;
  const type  = propSelect(p, 'Type');
  const phase = propText(p, 'Phase');
  const name  = propText(p, 'Name');
  const id    = row.id.slice(0, 8);

  if ((type === 'Milestone' || type === 'Task') && phase && !phases.has(phase.toLowerCase())) {
    errors.push(`[${id}] "${name}": Phase "${phase}" not found in any Phase row`);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(56));
console.log(`  ARCBOS Board — Prepare Report`);
console.log('═'.repeat(56));
console.log(`  Rows scanned: ${rows.length}`);
console.log(`  Phases: ${phaseCount}  Milestones: ${msCount}  Tasks: ${taskCount}`);
console.log('');

if (warnings.length) {
  console.log(`  ⚠ Warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`    ${w}`);
  console.log('');
}

if (errors.length) {
  console.log(`  ✖ Errors (${errors.length}):`);
  for (const e of errors) console.log(`    ${e}`);
  console.log('');
} else {
  console.log(`  ✔ No errors found`);
}

console.log('═'.repeat(56) + '\n');

if (errors.length > 0 && process.env.PREPARE_FAIL_ON_ERROR === '1') {
  log.error(`Prepare failed with ${errors.length} error(s)`);
  process.exit(1);
}
