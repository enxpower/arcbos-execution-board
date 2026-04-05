// scripts/build-board.mjs
// Board build script. Pure read + render. No writes to Notion.
// Uses operational renderer v5.

import fs from 'fs-extra';
import path from 'node:path';

import { requireBoardConfig, cfg } from '../src/lib/config.mjs';
import { createLogger } from '../src/lib/logger.mjs';
import { fetchBoardData } from '../src/core/board-builder.mjs';
import { renderBoard } from '../src/core/board-renderer-v5.mjs';

const log = createLogger('build-board');

requireBoardConfig();

const runId = Date.now().toString(36).toUpperCase();
log.info('Build started', { runId, dryRun: cfg.dryRun });

const { board, allBlocked, summary } = await fetchBoardData();
const lastSync = new Date().toISOString();
const html = renderBoard({ board, allBlocked, summary, lastSync });
const outDir = cfg.boardOutDir;

if (!cfg.dryRun) {
  await fs.ensureDir(outDir);
  const tmp = path.join(outDir, `.index.tmp.${runId}`);
  await fs.writeFile(tmp, html, 'utf8');
  await fs.move(tmp, path.join(outDir, 'index.html'), { overwrite: true });

  if (cfg.boardCname) {
    await fs.writeFile(path.join(outDir, 'CNAME'), `${cfg.boardCname}\n`, 'utf8');
  }

  await fs.writeFile(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');
  log.info('Board written', { outDir, bytes: html.length });
} else {
  log.info(`[DRY RUN] Would write ${html.length} bytes to ${outDir}/index.html`);
}

log.info('Build complete', {
  runId,
  phases: board.length,
  blocked: allBlocked.length,
  ...summary,
});
