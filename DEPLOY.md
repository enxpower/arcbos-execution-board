# ARCBOS Board v2 — Deployment Guide
# From zero to live. Follow steps in order. No prior setup assumed.
# ─────────────────────────────────────────────────────────────────────────────


## What you're deploying

```
board.arcbos.com          Static project board (GitHub Pages, rebuilt daily)
Telegram Bot              Engineers update task status via chat messages
GitHub Actions            Automation glue — no server required
Notion                    Single source of truth (database)
```

## Project structure

```
arcbos-board/
├── src/
│   ├── lib/
│   │   ├── config.mjs          All environment variables, defaults, validation
│   │   ├── logger.mjs          Structured, token-safe logger
│   │   ├── notion-client.mjs   Unified Notion API layer (retry, rate-limit, pagination)
│   │   ├── state.mjs           Bot state persistence (last_update_id, debounce)
│   │   └── telegram-client.mjs Telegram getUpdates + sendMessage
│   └── core/
│       ├── board-builder.mjs   Reads Notion → structured board data
│       ├── board-renderer.mjs  Board data → HTML page (pure function)
│       ├── command-parser.mjs  Parses Telegram message text → command objects
│       ├── task-matcher.mjs    Finds tasks by TaskCode / name (with ambiguity detection)
│       └── task-updater.mjs    State transitions + write deduplication
├── scripts/
│   ├── build-board.mjs         Entry point: build + write board HTML
│   ├── poll-telegram.mjs       Entry point: poll + process Telegram messages
│   └── prepare.mjs             Entry point: schema validation (read-only)
├── .github/workflows/
│   ├── board-publish.yml       Daily board rebuild + deploy
│   ├── tg-bot.yml              Every-5-min Telegram polling
│   └── prepare.yml             Weekly schema check (manual or scheduled)
├── .env.example                All variable names with comments
├── package.json
├── DEPLOY.md                   This file
└── UPGRADE_NOTES.md            What changed from v1
```


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — Create the Telegram Bot (5 min)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Open Telegram, search @BotFather
2. Send: /newbot
3. Name: ARCBOS Board
4. Username: arcbos_board_bot  (must end in _bot, pick any available)
5. BotFather replies with your token:
     7412369854:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
6. Save this token — used as TG_BOT_TOKEN secret


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — Set up Notion
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

2a. Create Notion integration:
    https://www.notion.so/my-integrations → New integration
    Name: ARCBOS Board
    Capabilities: Read content, Update content, Insert content
    Copy the "Internal Integration Secret" → NOTION_TOKEN

2b. Create the Board database:
    Notion → New page → Database (full page)
    Name: ARCBOS Project Board

    Required properties (exact names, exact types):

    Property Name  │ Type    │ Notes
    ───────────────┼─────────┼──────────────────────────────────────────
    Name           │ Title   │ (exists by default)
    Type           │ Select  │ Options: Phase, Milestone, Task
    Phase          │ Text    │ Phase name this row belongs to
    Status         │ Select  │ Phase/Milestone: Pending, Active, Done
                   │         │ Task: Draft, Active, Done, Blocked
    Owner          │ Text    │ Responsible person
    Module         │ Text    │ Engineering module (Mechanical, Software…)
    Due            │ Date    │ Target date
    StartDate      │ Date    │ Phase start date (optional)
    Output         │ Text    │ Deliverable description (Tasks)
    BlockedBy      │ Text    │ Blocker reason (Tasks — leave empty if not blocked)
    SortOrder      │ Number  │ Display order — use 10, 20, 30…
    TaskCode       │ Text    │ Optional short code e.g. "MECH-01" for precise bot matching

    Note: TaskCode is optional. System works fine without it.

2c. Share database with integration:
    Open database → ··· → Connections → Add connection → ARCBOS Board

2d. Get BOARD_DB_ID:
    Open database as full page in browser.
    URL: https://notion.so/workspace/XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX?v=...
    Copy the 32-char hex string before the ?
    This is your BOARD_DB_ID.

2e. Add initial test data:

    Type=Phase   Name="Phase 1 — Prototype"   Status=Active   SortOrder=10
                 StartDate=2025-03-01   Due=2025-05-31

    Type=Milestone  Name="Chassis design"   Phase="Phase 1 — Prototype"
                    Status=Done   Due=2025-04-05   SortOrder=10

    Type=Task   Name="Motor torque validation"   Phase="Phase 1 — Prototype"
                Status=Active   Owner="Li Wei"   Module=Mechanical
                Due=2025-04-12   Output="Validated torque spec"
                TaskCode="MECH-01"   SortOrder=10


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — Create GitHub repository
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. github.com/enxpower → New repository
   Name: board-arcbos
   Visibility: Public  (required for free GitHub Pages)
   Initialize with README: yes

2. Push this project to that repo:

   git clone https://github.com/enxpower/board-arcbos.git
   cd board-arcbos

   # Copy all files from the ZIP into this folder (overwrite README if needed)
   # Then:
   git add .
   git commit -m "chore: initial board v2 setup"
   git push origin main

3. Enable GitHub Pages:
   Repo → Settings → Pages
   Source: Deploy from a branch
   Branch: gh-pages  /  (root)
   Save


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — Configure GitHub Secrets and Variables
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Go to: enxpower/board-arcbos → Settings → Secrets and variables → Actions

SECRETS (click "New repository secret"):

  Name              Value
  ──────────────    ──────────────────────────────────────────
  NOTION_TOKEN      secret_xxx... (from Step 2a)
  TG_BOT_TOKEN      1234567890:AAFxxx... (from Step 1)

VARIABLES (click "New repository variable"):

  Name                        Value           Notes
  ──────────────────────────  ──────────────  ────────────────────────
  BOARD_DB_ID                 32-char hex     From Step 2d
  NOTION_GAP_MS               600             Safe default, increase if 429s occur
  BOARD_REFRESH_DEBOUNCE_SEC  300             Seconds between bot-triggered rebuilds


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 5 — DNS configuration
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

In your DNS provider for arcbos.com:

Add CNAME record:
  Host:  board
  Value: enxpower.github.io
  TTL:   3600

The CNAME file is written automatically by build-board.mjs.
GitHub Pages handles HTTPS automatically.
DNS propagation: usually 5–30 minutes.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 6 — First run
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Run schema check first:
  Actions → "Board — Prepare (Schema Check)" → Run workflow
  Review the output — should show no errors.

Run board build:
  Actions → "Board — Publish" → Run workflow
  Wait ~1 minute.
  Open https://board.arcbos.com — should show your test data.

Run bot poll:
  Actions → "Bot — Telegram Poll" → Run workflow
  Check logs — should show "Updates fetched, count: 0" with no errors.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 7 — Set up Telegram group
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Create group: "ARCBOS SnowBot Team"
2. Add bot: Group Settings → Add Members → @arcbos_board_bot
3. Test (wait up to 5 minutes for bot cron to run):
   Send in group: 帮助
   Bot should reply with command list.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 8 — Share with team
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Send this to engineers:

  ─────────────────────────────────────────
  ARCBOS 项目看板

  看板地址：https://board.arcbos.com
  （每天早上自动更新，有写操作后5分钟内刷新）

  任务更新方式：Telegram 发消息给 @arcbos_board_bot
  或在群里直接发：

    完成 任务名称
    阻塞 任务名称 原因：具体原因
    激活 任务名称        ← 解除阻塞
    进度 任务名称        ← 查询状态
    搜索 关键词          ← 搜索任务
    帮助

  可用 TaskCode 精确指定任务（如 MECH-01）
  发送后约5分钟内收到确认回复
  ─────────────────────────────────────────


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Ongoing operations
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Automatic schedule:
  Board rebuild:      weekdays 09:00 UTC (board-publish.yml)
  Telegram polling:   every 5 minutes, 24/7 (tg-bot.yml)
  Schema check:       every Monday 08:00 UTC (prepare.yml)

Board refresh timing:
  Notion writes → reflected in bot replies immediately
  Board page → refreshed within 5 min of any write (debounced)
  Board page → always current after morning rebuild

Founder workflow (Notion only):
  - Add/edit Phase and Milestone rows
  - Review Draft tasks → change Status to Active to approve
  - Nothing else required

Force board rebuild immediately:
  Actions → "Board — Publish" → Run workflow

Increase rate limit protection (if seeing 429 errors):
  Settings → Variables → NOTION_GAP_MS → increase to 800 or 1000


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
State machine rules (for reference)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Via Telegram bot:
  Active  → Done      ✓  完成 task
  Active  → Blocked   ✓  阻塞 task 原因：reason
  Blocked → Active    ✓  激活 task
  Blocked → Done      ✓  完成 task

Blocked by bot (Founder must use Notion):
  Draft   → Active    ✗  Founder only (change in Notion)
  Done    → anything  ✗  Terminal state, no changes allowed
  Draft   → Done      ✗  Must be approved first


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Troubleshooting
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Bot not responding?
  1. Actions → "Bot — Telegram Poll" → latest run → view logs
  2. Check TG_BOT_TOKEN secret is set correctly
  3. Make sure bot is added to the group
  4. Wait up to 5 minutes for next cron cycle

Board not updating?
  1. Actions → "Board — Publish" → latest run → view logs
  2. Verify NOTION_TOKEN and BOARD_DB_ID are correct
  3. Confirm integration is shared with database (Step 2c)

Seeing 429 rate-limit errors?
  Increase NOTION_GAP_MS variable to 800 or 1000.
  The system retries automatically but higher gap prevents the issue.

Task not found by bot?
  - Bot uses multi-level matching: TaskCode → exact name → contains
  - Send 搜索 keyword to see what matches
  - Check exact Name in Notion
  - If multiple tasks match, bot will list candidates and ask you to be specific

GitHub Pages 404?
  - Wait 5 min after first deploy for Pages to activate
  - Settings → Pages → confirm source is gh-pages branch
  - DNS CNAME must point to enxpower.github.io

Schema errors in prepare run?
  - Check the prepare workflow logs for specific row IDs and issues
  - Common: Phase field in Task doesn't match any Phase row Name (case sensitive)
  - Common: Invalid Status value not in allowed list
