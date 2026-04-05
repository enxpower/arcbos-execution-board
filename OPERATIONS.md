# ARCBOS Board v2 — Operations Guide

## Daily rhythm

| Time (UTC) | What happens                                          |
|------------|-------------------------------------------------------|
| 08:00 Mon  | prepare.yml: schema check runs automatically          |
| 09:00 weekdays | board-publish.yml: board rebuilds from Notion    |
| Every 5min | tg-bot.yml: Telegram messages polled and processed   |
| On write   | board-publish triggered (if debounce passed)          |

## Checking system health

**Board publish — last run:**
  GitHub → enxpower/board-arcbos → Actions → Board — Publish
  Look for green checkmark and "Board written" in logs.

**Bot — last run:**
  GitHub → Actions → Bot — Telegram Poll
  Look for "Bot poll complete" with processed count.

**Schema health:**
  GitHub → Actions → Board — Prepare → Run workflow
  Review output for warnings and errors.

## Reading the bot logs

Each poll run logs:
```
INFO  [tg-bot] Bot poll started { runId: 'ABC123', dryRun: false }
INFO  [notion] queryAll complete { db: '12345678', total: 28, pages: 1 }
INFO  [tg-bot] Updates fetched { count: 2, offset: 12345 }
INFO  [tg-bot] Processing message { updateId: 12346, chatId: -100..., from: 'Li Wei', cmd: 'done' }
INFO  [task-matcher] Matched by exact name { name: 'Motor torque validation' }
INFO  [task-updater] Task updated { task: 'Motor torque validation', from: 'Active', to: 'Done', actor: 'Li Wei' }
INFO  [tg-bot] Bot poll complete { runId: 'ABC123', processed: 1, maxId: 12346, boardDirty: true }
```

## Tuning rate limit settings

Start conservative. Increase speed only if builds are too slow.

| NOTION_GAP_MS | Behavior                                          |
|---------------|---------------------------------------------------|
| 300           | Fast — risk of 429 on large databases             |
| 500           | Default — balanced                                |
| 600           | GitHub Actions default — safe for most cases      |
| 800–1000      | Conservative — use if you see frequent 429 errors |

If you see 429 in logs:
```
WARN  [notion] 429 rate-limited { op: 'queryAll:...', retryAfter: 60, waitMs: 61000 }
```
The system handles it automatically. But to prevent it: increase `NOTION_GAP_MS`.

## Forcing immediate actions

**Force board rebuild now:**
  Actions → Board — Publish → Run workflow (click Run workflow button)

**Force bot poll now:**
  Actions → Bot — Telegram Poll → Run workflow

**Run schema check:**
  Actions → Board — Prepare → Run workflow

**Dry run (test without writing):**
  Set `DRY_RUN=1` as a GitHub Variable temporarily, run any workflow, then remove it.

## Managing the state file

The bot state file tracks `last_update_id` to avoid reprocessing messages.
It's stored in GitHub Actions cache with key prefix `tg-bot-state-`.

**If the bot starts reprocessing old messages:**
  This means the cache was cleared. It will self-correct — old messages that
  have already been applied will be rejected by the state machine (e.g., trying
  to mark an already-Done task as Done again just returns a "already done" reply).

**If you want to reset the offset (start fresh):**
  Go to: Actions → Caches (in left sidebar) → delete entries starting with `tg-bot-state-`
  Next run will start from current offset (skipping historical messages).

## Board refresh debounce

`BOARD_REFRESH_DEBOUNCE_SEC` controls the minimum time between bot-triggered
board rebuilds. Default is 300 seconds (5 minutes).

If 3 engineers update tasks within 2 minutes:
- First update: triggers board rebuild
- Second and third: skipped (debounce active)
- Result: one rebuild covers all three changes

Set to 0 if you want every write to trigger a rebuild (not recommended —
GitHub Actions has a limit of ~2000 minutes/month on free plan).

## GitHub Actions usage estimate

| Workflow       | Frequency      | Duration | Monthly cost   |
|----------------|----------------|----------|----------------|
| board-publish  | ~22 runs/month | ~1 min   | ~22 min        |
| tg-bot         | ~8640 runs/mo  | ~20 sec  | ~2880 min      |
| prepare        | ~4 runs/month  | ~1 min   | ~4 min         |
| **Total**      |                |          | **~2906 min**  |

GitHub free plan: 2000 min/month. This slightly exceeds free tier.

**To stay within free tier:**
  Change tg-bot cron to `*/10 * * * *` (every 10 min instead of 5).
  This halves Actions usage to ~1450 min/month, well within free tier.
  10-minute response time is still acceptable for task updates.

## Adding a new team member

Nothing to configure. Engineers use Telegram and refer to task names.
Owner field in Notion is informational only — the bot does not use it
for authentication.

If you add TaskCodes: share the code with the responsible engineer.
Task names work fine without codes.

## Updating board appearance

Edit `src/core/board-renderer.mjs`. The CSS is embedded in the HTML output.
Changes take effect on next board rebuild.
No JavaScript framework. No build step for CSS. Plain HTML + inline CSS.

## Adding a new Notion field to the board

1. Add the property to your Notion database
2. In `src/core/board-builder.mjs`, add extraction in `rowToBase()` or the
   type-specific section
3. In `src/core/board-renderer.mjs`, add it to the relevant render function
4. In `scripts/prepare.mjs`, optionally add a validation check
5. Push to main — board rebuilds automatically
