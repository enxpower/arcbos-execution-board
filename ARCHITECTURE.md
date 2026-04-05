# ARCBOS Board v2 — Architecture

## System overview

```
┌─────────────────────────────────────────────────────────┐
│                      Notion DB                          │
│   Single source of truth. Founder edits directly.       │
│   Phase → Milestone → Task hierarchy (flat table,       │
│   Type field distinguishes row kind).                   │
└───────────────────┬─────────────────────────────────────┘
                    │ read / write
        ┌───────────┴───────────┐
        │                       │
┌───────▼───────┐     ┌─────────▼────────┐
│  board-build  │     │   poll-telegram   │
│  (read-only)  │     │   (read + write)  │
│               │     │                  │
│  Runs daily   │     │  Runs every 5min │
│  + on-demand  │     │  + on write:     │
│               │     │  triggers build  │
└───────┬───────┘     └─────────┬────────┘
        │                       │
        │ HTML                  │ replies
        ▼                       ▼
┌───────────────┐     ┌─────────────────┐
│  GitHub Pages │     │  Telegram Bot   │
│ board.arcbos  │     │  @arcbos_bot    │
│    .com       │     │                 │
└───────────────┘     └─────────────────┘
        ▲                       ▲
        │ view                  │ commands
        └───────────┬───────────┘
                    │
              Team members
```

## Layer responsibilities

### `src/lib/` — Infrastructure

These modules have no business logic. They know about APIs and system concerns,
not about tasks or boards.

**`config.mjs`** — single place where all env vars are read, given defaults,
and validated. Scripts never call `process.env` directly.

**`logger.mjs`** — structured log output with level filtering and automatic
token scrubbing. All log output goes through here.

**`notion-client.mjs`** — the only place Notion API calls are made.
Implements the rate-limit governance contract: gap, 429 retry, 5xx backoff,
pagination. Callers never see raw HTTP.

**`state.mjs`** — reads and writes the JSON state file that persists between
GitHub Actions runs (via actions/cache). Handles corrupt/missing file gracefully.

**`telegram-client.mjs`** — thin wrapper: getUpdates and sendMessage only.
Token never appears in logs.

### `src/core/` — Business logic

These modules know about the ARCBOS domain (tasks, phases, commands) but not
about infrastructure details.

**`command-parser.mjs`** — pure function: string → command object. No I/O.
Handles @mention stripping, slash commands, all keyword variations.

**`task-matcher.mjs`** — fetches tasks from Notion, applies the three-tier
match priority (TaskCode → exact name → contains), returns match type and
candidates. Returns AMBIGUOUS when multiple tasks match at the same tier.

**`task-updater.mjs`** — enforces the state machine. Validates that a
transition is allowed before calling Notion. Skips write if value is unchanged
(dedup). Logs every transition with actor identity.

**`board-builder.mjs`** — fetches all board rows from Notion, organises into
Phase → Milestone → Task hierarchy, computes aggregate stats. Pure read.

**`board-renderer.mjs`** — pure function: board data → HTML string. No I/O,
no Notion, no file system. Fully deterministic given the same input.

### `scripts/` — Entry points

Thin orchestrators. Each script:
1. Calls `requireXxxConfig()` to validate env vars (fail fast)
2. Calls lib and core modules
3. Handles top-level logging and error reporting

Scripts never contain business logic. They are the wiring layer.

## Data flow: Telegram command

```
Engineer sends: "完成 Motor torque validation"
         │
         ▼
getUpdates()            ← telegram-client.mjs
         │
         ▼
parseCommand(text)      ← command-parser.mjs
→ { cmd: 'done', query: 'Motor torque validation' }
         │
         ▼
matchTask(query)        ← task-matcher.mjs
→ notion.queryAll()     ← notion-client.mjs (with retry/gap)
→ { type: EXACT_NAME, task: { id, name, status: 'Active', ... } }
         │
         ▼
updateTaskStatus(       ← task-updater.mjs
  task, 'Done',
  undefined, actor)
→ canTransition('Active', 'Done') → true
→ dedup check: status changed → proceed
→ notion.updatePage()  ← notion-client.mjs
         │
         ▼
sendMessage(chatId,     ← telegram-client.mjs
  "✅ 已完成：Motor torque validation")
         │
         ▼
state.board.last_refresh_triggered = now
→ if debounce passed → trigger board-publish workflow
```

## Data flow: Board build

```
GitHub Actions cron / workflow_call
         │
         ▼
fetchBoardData()        ← board-builder.mjs
→ notion.queryAll()     ← notion-client.mjs (all rows, paginated)
→ { board, allBlocked, summary }
         │
         ▼
renderBoard(data)       ← board-renderer.mjs
→ HTML string (pure function)
         │
         ▼
fs.writeFile(out/index.html)
+ CNAME, robots.txt
         │
         ▼
peaceiris/actions-gh-pages → gh-pages branch → GitHub Pages
```

## State file schema

```json
{
  "bot": {
    "last_update_id": 12345,
    "last_run": "2025-04-05T09:00:00.000Z",
    "processed_count": 42
  },
  "board": {
    "last_build": null,
    "last_refresh_triggered": "2025-04-05T09:01:23.000Z",
    "rows_fetched": 0
  }
}
```

Stored at `BOT_STATE_FILE` (default `/tmp/tg-bot-state.json`).
Persisted between GitHub Actions runs via `actions/cache`.
If missing or corrupt: system starts with safe defaults (no crash).

## Notion state machine

```
            ┌─── Founder only (Notion UI) ───┐
            │                                │
  [Draft] ──┘                                │
            ╔══════════════╗                 │
            ║   [Active]   ║ ◄───────────────┘
            ╚══════╤═══════╝
                   │
         ┌─────────┴──────────┐
         │                    │
    [Done] ✓            [Blocked]
    (terminal)               │
                             │ 激活
                             ▼
                        [Active] ✓
```

Done is terminal. No bot command can change a Done task.
Draft→Active requires Founder action in Notion directly.

## Concurrency design

| Workflow      | Concurrency group  | cancel-in-progress |
|---------------|--------------------|--------------------|
| board-publish | board-publish      | true (safe: pure read) |
| tg-bot        | tg-bot             | false (unsafe: mid-write) |
| prepare       | board-prepare      | true (safe: read-only) |

`tg-bot` is never cancelled mid-run to prevent partial Notion writes.
`board-publish` can be cancelled because it is purely read+render.
