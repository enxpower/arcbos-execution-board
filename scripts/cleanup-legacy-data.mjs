// scripts/cleanup-legacy-data.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Legacy data cleanup — manual maintenance only.
// Cleans historical rows where Status=Done but BlockedBy is still not empty.
// Supports dry-run mode.
// ─────────────────────────────────────────────────────────────────────────────

import { requireBoardConfig, cfg } from '../src/lib/config.mjs';
import { createLogger } from '../src/lib/logger.mjs';
import { notion, propText, propSelect } from '../src/lib/notion-client.mjs';

const log = createLogger('cleanup-legacy-data');
requireBoardConfig();

const DRY_RUN = cfg.dryRun || process.env.DRY_RUN === '1';
console.log('\n' + '═'.repeat(60));
console.log(` ARCBOS Board · Legacy Data Cleanup`);
console.log(` Mode: ${DRY_RUN ? 'DRY RUN（仅检查，不写入）' : 'LIVE（将写入 Notion）'}`);
console.log('═'.repeat(60) + '\n');

const rows = await notion.queryAll(cfg.boardDbId(), {
  filter: { property: 'Type', select: { equals: 'Task' } },
  sorts: [{ property: 'SortOrder', direction: 'ascending' }],
});

const dirty = [];
for (const row of rows) {
  const p = row.properties;
  const name = propText(p, 'Name');
  const status = propSelect(p, 'Status');
  const blockedBy = propText(p, 'BlockedBy');
  if (status === 'Done' && blockedBy) {
    dirty.push({ id: row.id, name, blockedBy });
  }
}

console.log(`Scanned: ${rows.length} task rows`);
console.log(`Dirty rows: ${dirty.length}\n`);

if (!dirty.length) {
  console.log('✔ 没有发现历史脏数据，无需清理。\n');
  process.exit(0);
}

for (const item of dirty) {
  console.log(`- ${item.name}`);
  console.log(`  BlockedBy: "${item.blockedBy}"`);
  console.log(`  Action: ${DRY_RUN ? 'would clear BlockedBy' : 'clearing BlockedBy'}`);
}

if (DRY_RUN) {
  console.log(`\n[DRY RUN] 仅检查完成，未写入 Notion。`);
  process.exit(0);
}

let ok = 0;
let failed = 0;
for (const item of dirty) {
  try {
    await notion.updatePage(item.id, { BlockedBy: { rich_text: [] } }, `legacy-clean:${item.id.slice(0, 8)}`);
    log.info('Cleared legacy BlockedBy', { task: item.name });
    ok += 1;
  } catch (e) {
    log.error('Failed clearing legacy BlockedBy', { task: item.name, error: e.message });
    failed += 1;
  }
}

console.log(`\nCleanup complete · fixed=${ok} failed=${failed}`);
if (failed > 0) process.exit(1);
