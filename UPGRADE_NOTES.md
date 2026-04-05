# ARCBOS Board v2 — Upgrade Notes

## What changed from v1

v1 was two flat scripts (`board.mjs`, `tg-bot.mjs`) that worked but had no
separation of concerns, no rate-limit governance, and no ambiguity handling.
v2 is a structured, layered system built to the same "lightweight, no-server"
philosophy — but professionally engineered.

---

## Architecture changes

### v1 structure
```
scripts/
  board.mjs         ← everything: fetch + render + write
  tg-bot.mjs        ← everything: poll + parse + match + write + reply
```

### v2 structure
```
src/lib/            ← infrastructure (config, logging, API clients, state)
src/core/           ← business logic (matching, transitions, rendering)
scripts/            ← thin entry points that wire lib + core together
```

Every layer is independently testable. Nothing is hardwired.

---

## What's new — by category

### Notion rate-limit governance (most important)

v1 had no retry logic. One 429 would crash the run.

v2 introduces a unified Notion client (`src/lib/notion-client.mjs`) that all
code must use. It handles:

- **Global request gap** — configurable via `NOTION_GAP_MS` (default 500ms).
  Every request waits this long after completing, regardless of success.
- **429 handling** — reads the `Retry-After` header and waits exactly that long
  plus a 1-second buffer. Never guesses.
- **5xx exponential backoff** — doubles wait time per attempt, adds ±30% jitter,
  caps at 30 seconds. Up to `NOTION_MAX_RETRIES` attempts (default 8).
- **Automatic pagination** — `notion.queryAll()` fetches every page with gap
  between pages. Callers never need to think about cursors.
- **Write deduplication** — `task-updater.mjs` skips PATCH if status and
  blockedBy are already identical. Prevents redundant writes on hot path.
- **Token-safe logging** — tokens are scrubbed from all log output at the
  logger level. A leaked log cannot expose credentials.

### Task matching (second most important)

v1 matched tasks by name-contains only. Ambiguity was silently resolved by
picking the first result, which caused wrong task updates with no warning.

v2 has a proper match priority chain:
1. TaskCode exact match (new optional field)
2. Name exact match (case-insensitive)
3. Name contains match

If multiple tasks match at the same priority level, the bot returns all
candidates and asks the user to be more specific. No silent mis-updates.

### State machine enforcement

v1 allowed any status change from the bot. Engineers could mark Draft tasks
done, re-open Done tasks, etc.

v2 enforces explicit transition rules:

| From    | To      | Bot allowed | Note                       |
|---------|---------|-------------|----------------------------|
| Draft   | Active  | No          | Founder only, via Notion   |
| Active  | Done    | Yes         | `完成`                      |
| Active  | Blocked | Yes         | `阻塞` (reason required)   |
| Blocked | Active  | Yes         | `激活`                      |
| Blocked | Done    | Yes         | `完成`                      |
| Done    | any     | No          | Terminal state              |

Attempting an invalid transition returns a clear error message.

### New bot commands

v1: 完成, 阻塞, 进度, 帮助
v2 adds:
- `激活` / `解除阻塞` — unblock and reactivate a task
- `搜索` — search tasks by keyword without changing anything

All v1 commands work identically in v2. No breaking change.

### Board enhancements

- **Summary bar** in header: total / done / active / blocked counts at a glance
- **Draft count** shown in task chips (tasks awaiting Founder approval)
- **TaskCode** displayed in blocked table if present
- **Horizontal scroll** on blocked table for mobile
- Phase status badge and progress bar visible at a glance

### Workflow architecture

v1: 2 workflows (publish, bot)
v2: 3 workflows with clear separation:

| Workflow          | Trigger            | What it does                    |
|-------------------|--------------------|---------------------------------|
| `board-publish`   | Daily + on-demand  | Pure read + render + deploy     |
| `tg-bot`          | Every 5 min        | Poll + write + conditional refresh |
| `prepare`         | Weekly + manual    | Schema validation, no writes    |

Key improvement: `board-publish` is now `workflow_call`-able. The bot workflow
calls it automatically after writing to Notion, subject to debounce. This means
the board can update within minutes of a status change, not just daily.

### Debounce / board refresh

v1: board only updated daily.
v2: after any successful Notion write, the bot checks if the debounce period
has elapsed (`BOARD_REFRESH_DEBOUNCE_SEC`, default 300s). If yes, it triggers
`board-publish`. Board now reflects changes within ~5 minutes of an engineer
updating a task.

### Schema validation

New `prepare.mjs` script (and `prepare.yml` workflow) runs schema checks:
- All Type values valid
- All Status values valid
- Tasks have Phase, Owner, Due
- No orphaned Milestone/Task rows (Phase field doesn't match any Phase row)
- SortOrder warnings for unset rows

Run manually anytime: `Actions → Board — Prepare → Run workflow`

### Structured logging

v1: console.log scattered everywhere.
v2: `createLogger(namespace)` with levels debug/info/warn/error, configurable
via `LOG_LEVEL`. All log lines include timestamp, level, namespace, and scrubbed
message. Token patterns are automatically redacted.

---

## What's backward compatible

Everything. If you have an existing Notion database from v1:

- All existing fields (`Name`, `Type`, `Phase`, `Status`, `Owner`, `Module`,
  `Due`, `StartDate`, `Output`, `BlockedBy`, `SortOrder`) work identically.
- `TaskCode` is a new optional field. Board and bot work without it.
- All existing Telegram commands work unchanged.
- GitHub secrets `NOTION_TOKEN`, `TG_BOT_TOKEN` are the same names.
- `BOARD_DB_ID` variable is the same name.

---

## New optional Notion field

**TaskCode** (Text property) — short identifier for precise bot targeting.

Examples: `MECH-01`, `SW-03`, `T-042`

Usage: instead of `完成 Motor torque validation phase 1`
you can send: `完成 MECH-01`

Add this field to your Notion database at any time. Rows without it work fine.

---

## New GitHub Variables (optional but recommended)

| Variable                    | Default | Purpose                                  |
|-----------------------------|---------|------------------------------------------|
| `NOTION_GAP_MS`             | 600     | Ms between Notion requests               |
| `BOARD_REFRESH_DEBOUNCE_SEC`| 300     | Min seconds between bot-triggered rebuilds |

Both have safe defaults. The system runs without them.

---

## Minimum migration path (existing v1 users)

If you want the smallest possible change from v1:

1. Replace repo contents with this ZIP
2. `npm install` (same dependencies)
3. Keep all existing GitHub Secrets and Variables — names unchanged
4. Add new Variables if desired: `NOTION_GAP_MS`, `BOARD_REFRESH_DEBOUNCE_SEC`
5. Run `Actions → Board — Prepare` to validate your existing data
6. Run `Actions → Board — Publish` to rebuild with new renderer

That's it. No Notion schema changes required to get the core upgrade.

---

## Why it's more stable

The primary failure mode of v1 was Notion API instability (429 rate limits,
transient 5xx errors) causing silent failures with no retry. v2 treats all
Notion calls as potentially failing and retries with proper backoff. In
production, a single 429 that would have crashed v1 is invisible in v2 — the
system waits, retries, and succeeds.

The secondary failure mode was wrong task updates due to ambiguous name
matching. v2 surfaces ambiguity explicitly and refuses to guess.
