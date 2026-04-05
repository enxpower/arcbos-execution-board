// scripts/cleanup-legacy-data.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Legacy data cleanup — one-off, manual trigger only.
//
// Finds tasks where Status=Done but BlockedBy is not empty.
// Clears BlockedBy on those rows.
//
// Required env: NOTION_TOKEN, BOARD_DB_ID
// Optional env: DRY_RUN=1 (default: 0 — will write)
// ─────────────────────────────────────────────────────────────────────────────

import { requireBoardConfig, cfg } from '../src/lib/config.mjs';
import { createLogger } from '../src/lib/logger.mjs';
import { notion, propText, propSelect } from '../src/lib/notion-client.mjs';

const log = createLogger('cleanup');

requireBoardConfig();

const DRY_RUN = cfg.dryRun || process.env.DRY_RUN === '1';

console.log('\n' + '═'.repeat(56));
console.log(`  ARCBOS Board — Legacy Data Cleanup`);
console.log(`  Mode: ${DRY_RUN ? '🔍 DRY RUN (no writes)' : '✏️  LIVE (will write to Notion)'}`);
console.log('═'.repeat(56) + '\n');

// Fetch all Task rows
const rows = await notion.queryAll(cfg.boardDbId(), {
  filter: { property: 'Type', select: { equals: 'Task' } },
});

log.info(`Scanned ${rows.length} task rows`);

const dirty = [];

for (const row of rows) {
  const p         = row.properties;
  const name      = propText(p, 'Name');
  const status    = propSelect(p, 'Status');
  const blockedBy = propText(p, 'BlockedBy');

  // Rule: Status=Done must have empty BlockedBy
  if (status === 'Done' && blockedBy) {
    dirty.push({ id: row.id, name, status, blockedBy });
  }
}

console.log(`Found ${dirty.length} dirty row(s):\n`);

if (!dirty.length) {
  console.log('  ✔ No dirty data found. Nothing to clean.\n');
  console.log('═'.repeat(56) + '\n');
  process.exit(0);
}

// Print what will be changed
for (const row of dirty) {
  console.log(`  Row: ${row.name}`);
  console.log(`    Status:    ${row.status}`);
  console.log(`    BlockedBy: "${row.blockedBy}"`);
  console.log(`    Action:    ${DRY_RUN ? '[DRY RUN] would clear BlockedBy' : 'clearing BlockedBy'}`);
  console.log('');
}

if (DRY_RUN) {
  console.log(`[DRY RUN] Would clean ${dirty.length} row(s). No writes made.`);
  console.log('═'.repeat(56) + '\n');
  process.exit(0);
}

// Apply fixes
let fixed = 0, failed = 0;

for (const row of dirty) {
  try {
    await notion.updatePage(row.id, {
      BlockedBy: { rich_text: [] },
    }, `cleanup:${row.id.slice(0,8)}`);
    log.info(`Cleared BlockedBy`, { name: row.name, was: row.blockedBy });
    fixed++;
  } catch (e) {
    log.error(`Failed to clear BlockedBy`, { name: row.name, error: e.message });
    failed++;
  }
}

console.log('═'.repeat(56));
console.log(`  Cleanup complete`);
console.log(`  Fixed: ${fixed}  Failed: ${failed}`);
console.log('═'.repeat(56) + '\n');

if (failed > 0) process.exit(1);
