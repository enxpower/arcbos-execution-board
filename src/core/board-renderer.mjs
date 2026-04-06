// src/core/board-renderer.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Operational board renderer — unified final version.
//
// Architecture: our v2 (Notion pipeline, correct data contract)
// UI/UX: best of ChatGPT v3 (hero cards, filter bar, <details> phases,
//         daysUntil, dueSoon, problemText, client-side filter+search)
//
// Data contract (from board-builder.mjs):
//   board[]     — Phase objects each with .milestones[], .tasks[], .pct etc.
//   allBlocked  — Task[] where status === 'Blocked'
//   summary     — { totalTasks, totalDone, totalActive, totalBlocked, totalDraft }
//   lastSync    — ISO string
//
// Pure function — no Notion calls, no file I/O.
// ─────────────────────────────────────────────────────────────────────────────

import { cfg } from '../lib/config.mjs';

// ── Escape & format ───────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
  } catch { return String(d); }
}

// ── Date utilities ────────────────────────────────────────────────────────────

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysUntil(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const t = todayStart();
  dt.setHours(0, 0, 0, 0);
  return Math.round((dt - t) / 86400000);
}

// ── Risk classification ───────────────────────────────────────────────────────

function computeRisk(task) {
  const s  = (task.status || '').toLowerCase();
  const dd = daysUntil(task.due);

  if (s === 'blocked')                              return 'blocked';
  if (s !== 'done' && dd !== null && dd < 0)        return 'overdue';
  if (s === 'active' && dd !== null && dd <= 3)     return 'atrisk';
  if (s === 'done')                                 return 'done';
  if (s === 'active')                               return 'active';
  return 'normal';
}

const RISK_ORDER = { blocked:0, overdue:1, atrisk:2, active:3, normal:4, done:5 };

function compareTasks(a, b) {
  const ra = RISK_ORDER[a._risk] ?? 99;
  const rb = RISK_ORDER[b._risk] ?? 99;
  if (ra !== rb) return ra - rb;
  const da = a._dueDays, db = b._dueDays;
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  }
  return (a.name || '').localeCompare(b.name || '');
}

// ── Enrich tasks with computed fields ─────────────────────────────────────────

function enrichTasks(board) {
  const all = [];
  for (const ph of board) {
    for (const t of ph.tasks) {
      const dd = daysUntil(t.due);
      all.push({
        ...t,
        _phaseName: ph.name,
        _dueDays:   dd,
        _risk:      computeRisk(t),
      });
    }
  }
  return all;
}

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_ZH = {
  Done:'已完成', Active:'进行中', Blocked:'阻塞',
  Draft:'待审批', Pending:'未开始',
};

function statusCls(s) {
  return { done:'done', active:'active', blocked:'blocked', draft:'draft' }[(s||'').toLowerCase()] || 'pending';
}

function badge(s) {
  const cls = statusCls(s);
  const zh  = STATUS_ZH[s] || s || 'Pending';
  return `<span class="badge badge--${cls}">${esc(s)}（${esc(zh)}）</span>`;
}

// ── Risk badge ────────────────────────────────────────────────────────────────

const RISK_META = {
  blocked: { emoji:'🔴', label:'Blocked（阻塞）' },
  overdue:  { emoji:'🟠', label:'Overdue（逾期）' },
  atrisk:   { emoji:'🟡', label:'At Risk（风险）' },
  active:   { emoji:'🔵', label:'Active（进行中）' },
  done:     { emoji:'🟢', label:'Done（已完成）' },
  normal:   { emoji:'⚪', label:'Normal（正常）' },
};

function riskBadge(task) {
  const m = RISK_META[task._risk] || RISK_META.normal;
  return `<span class="risk risk--${task._risk}">${m.emoji} ${esc(m.label)}</span>`;
}

// ── Problem summary ───────────────────────────────────────────────────────────

function problemText(task) {
  if (task.status === 'Blocked') return task.blockedBy || 'Blocked — 原因未填写';
  if (task._risk === 'overdue')  return `已逾期 ${Math.abs(task._dueDays)} 天`;
  if (task._risk === 'atrisk')   return `即将到期（${task._dueDays} 天内）`;
  if (!task.owner)               return '未指派负责人';
  return '';
}

// ── Notion link ───────────────────────────────────────────────────────────────

function notionUrl(pageId) {
  return `https://notion.so/${String(pageId).replace(/-/g, '')}`;
}

function linkTask(task) {
  const name = esc(task.name || 'Untitled');
  const code = task.taskCode
    ? `<span class="task-code">${esc(task.taskCode)}</span>` : '';
  return `<a class="task-link" href="${esc(notionUrl(task.id))}" target="_blank" rel="noopener">${name}${code}</a>`;
}

// ── Phase progress — cap Active at 99% ───────────────────────────────────────

function safePhaseProgress(ph) {
  if (ph.status === 'Done')   return 100;
  const pct = ph.total ? Math.round((ph.done / ph.total) * 100) : 0;
  if (ph.status === 'Active' && pct >= 100) return 99;
  return pct;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderHeroGrid(summary, allTasks) {
  const overdue = allTasks.filter(t => t._risk === 'overdue').length;
  const atrisk  = allTasks.filter(t => t._risk === 'atrisk').length;
  return `
<div class="hero-grid">
  <div class="hero-card hero-card--blocked">
    <div class="hero-num">${summary.totalBlocked}</div>
    <div class="hero-lbl">Blocked<br><span>阻塞任务</span></div>
  </div>
  <div class="hero-card hero-card--overdue">
    <div class="hero-num">${overdue}</div>
    <div class="hero-lbl">Overdue<br><span>逾期任务</span></div>
  </div>
  <div class="hero-card hero-card--risk">
    <div class="hero-num">${atrisk}</div>
    <div class="hero-lbl">At Risk<br><span>风险任务</span></div>
  </div>
  <div class="hero-card hero-card--active">
    <div class="hero-num">${summary.totalActive}</div>
    <div class="hero-lbl">Active<br><span>进行中</span></div>
  </div>
  <div class="hero-card hero-card--done">
    <div class="hero-num">${summary.totalDone}</div>
    <div class="hero-lbl">Done<br><span>已完成</span></div>
  </div>
  <div class="hero-card hero-card--total">
    <div class="hero-num">${summary.totalTasks}</div>
    <div class="hero-lbl">Total<br><span>全部任务</span></div>
  </div>
</div>`;
}

function renderAttentionZone(allTasks) {
  const items = allTasks
    .filter(t => t._risk === 'blocked' || t._risk === 'overdue' || t._risk === 'atrisk')
    .sort(compareTasks);

  const content = items.length
    ? items.map(t => `
<a class="attention-item attention-item--${t._risk}" href="${esc(notionUrl(t.id))}" target="_blank" rel="noopener">
  <div class="attention-main">
    <div class="attention-title">${esc(t.name)}${t.taskCode ? ` <span class="task-code">${esc(t.taskCode)}</span>` : ''}</div>
    <div class="attention-meta">
      ${badge(t.status)} ${riskBadge(t)}
      ${t.owner ? `<span class="meta-tag">👤 ${esc(t.owner)}</span>` : '<span class="meta-tag meta-tag--warn">👤 未指派</span>'}
      <span class="meta-tag">📁 ${esc(t._phaseName)}</span>
      ${t.due ? `<span class="meta-tag">📅 ${esc(fmtDate(t.due))}</span>` : ''}
    </div>
  </div>
  <div class="attention-problem">${esc(problemText(t))}</div>
</a>`).join('')
    : `<div class="empty-box">✅ 当前没有阻塞、逾期或高风险任务</div>`;

  return `
<section class="section section--attention">
  <div class="section-hd">
    <div>
      <h2>🚨 Needs Attention</h2>
      <p>先看问题，再看进度。团队先处理阻塞、逾期、风险项。</p>
    </div>
    <div class="section-count">${items.length}</div>
  </div>
  <div class="attention-list">${content}</div>
</section>`;
}

function renderControls() {
  return `
<section class="section controls-section">
  <div class="section-hd compact">
    <div><h2>📋 Action Board</h2><p>点击筛选，快速定位"谁该做什么、哪里有问题"。</p></div>
  </div>
  <div class="controls-bar">
    <div class="filter-group">
      <button class="filter-btn is-active" data-filter="all">全部</button>
      <button class="filter-btn" data-filter="attention">需关注</button>
      <button class="filter-btn" data-filter="active">进行中</button>
      <button class="filter-btn" data-filter="blocked">阻塞</button>
      <button class="filter-btn" data-filter="overdue">逾期</button>
      <button class="filter-btn" data-filter="atrisk">风险</button>
      <button class="filter-btn" data-filter="done">已完成</button>
    </div>
    <input id="taskSearch" class="search-input" type="search" placeholder="搜索任务 / TaskCode / 负责人 / 阶段">
  </div>
</section>`;
}

function renderTaskList(allTasks) {
  const sorted = [...allTasks].sort(compareTasks);

  const rows = sorted.map(t => {
    const problem = problemText(t);
    const dueCls = t._risk === 'overdue' ? 'due--overdue'
                 : t._risk === 'atrisk'  ? 'due--soon'
                 : '';
    return `
<tr class="task-row"
  data-status="${esc((t.status||'').toLowerCase())}"
  data-risk="${esc(t._risk)}"
  data-owner="${esc((t.owner||'未指派').toLowerCase())}"
  data-search="${esc(`${t.name} ${t.taskCode||''} ${t.owner||''} ${t._phaseName||''}`.toLowerCase())}">
  <td class="col-task">${linkTask(t)}</td>
  <td>${badge(t.status)}</td>
  <td><button class="owner-btn" data-owner-filter="${esc((t.owner||'未指派').toLowerCase())}">${esc(t.owner||'未指派')}</button></td>
  <td class="col-phase">${esc(t._phaseName)}</td>
  <td class="${dueCls}">${esc(fmtDate(t.due)) || '—'}</td>
  <td>${riskBadge(t)}</td>
  ${problem ? `<td class="problem-cell">${esc(problem)}</td>` : '<td class="muted">—</td>'}
</tr>`;
  }).join('');

  return `
<section class="section">
  <div class="section-hd">
    <div><h2>🧩 Task List</h2><p>问题任务排在最前面，点击负责人可过滤。</p></div>
    <div class="section-count" id="taskCount">${sorted.length}</div>
  </div>
  <div class="table-wrap">
    <table class="task-table">
      <thead>
        <tr>
          <th>任务</th><th>状态</th><th>负责人</th>
          <th>阶段</th><th>截止日期</th><th>风险</th><th>问题说明</th>
        </tr>
      </thead>
      <tbody id="taskTableBody">${rows}</tbody>
    </table>
  </div>
</section>`;
}

function renderOwnerView(allTasks) {
  const active = allTasks.filter(t => t.status !== 'Draft' && t.status !== 'Done');
  if (!active.length) return '';

  const map = new Map();
  for (const t of active) {
    const owner = t.owner || '未指派';
    if (!map.has(owner)) map.set(owner, { blocked:0, overdue:0, atrisk:0, active:0 });
    const v = map.get(owner);
    if      (t._risk === 'blocked') v.blocked++;
    else if (t._risk === 'overdue') v.overdue++;
    else if (t._risk === 'atrisk')  v.atrisk++;
    else                            v.active++;
  }

  const cards = [...map.entries()]
    .sort((a,b) => (b[1].blocked+b[1].overdue+b[1].atrisk) - (a[1].blocked+a[1].overdue+a[1].atrisk))
    .map(([owner, v]) => `
<button class="owner-card" data-owner-filter="${esc(owner.toLowerCase())}">
  <div class="owner-name">👤 ${esc(owner)}</div>
  <div class="owner-stats">
    ${v.active  ? `<span class="ostat ostat--active">${v.active} 进行中</span>` : ''}
    ${v.blocked ? `<span class="ostat ostat--blocked">${v.blocked} 阻塞</span>` : ''}
    ${v.overdue ? `<span class="ostat ostat--overdue">${v.overdue} 逾期</span>` : ''}
    ${v.atrisk  ? `<span class="ostat ostat--risk">${v.atrisk} 风险</span>` : ''}
  </div>
</button>`).join('');

  return `
<section class="section">
  <div class="section-hd">
    <div><h2>👤 By Owner</h2><p>按负责人看工作负荷与异常，点击卡片过滤任务列表。</p></div>
  </div>
  <div class="owner-grid">${cards}</div>
</section>`;
}

function renderPhaseSection(board) {
  if (!board.length) return '';

  const items = board.map(ph => {
    const pct = safePhaseProgress(ph);
    const cls = statusCls(ph.status);
    const dateRange = [fmtDate(ph.startDate), fmtDate(ph.due)].filter(Boolean).join(' — ');
    const isOpen = ph.status === 'Active' || ph.blocked > 0;

    const msRows = ph.milestones.length
      ? ph.milestones.map(m => `<li>${badge(m.status)} ${esc(m.name)}${m.due ? ` <span class="muted">${esc(fmtDate(m.due))}</span>` : ''}</li>`).join('')
      : '<li class="muted">暂无里程碑</li>';

    const taskRows = ph.tasks.length
      ? ph.tasks.map(t => `<li>${badge(t.status)} <a href="${esc(notionUrl(t.id))}" target="_blank" rel="noopener">${esc(t.name)}</a></li>`).join('')
      : '<li class="muted">暂无任务</li>';

    return `
<details class="phase-card"${isOpen ? ' open' : ''}>
  <summary>
    <div class="phase-top">
      <div>
        <div class="phase-name">${esc(ph.name)}</div>
        <div class="phase-meta">
          ${badge(ph.status)}
          ${dateRange ? `<span class="muted">${esc(dateRange)}</span>` : ''}
        </div>
      </div>
      <div class="phase-stats">
        <div class="phase-percent">${pct}%</div>
        <div class="prog-track">
          <div class="prog-fill prog-fill--${cls}" style="width:${pct}%"></div>
        </div>
        <div class="phase-counts">${ph.done}/${ph.total} 完成 · ${ph.blocked} 阻塞 · ${ph.active} 进行中</div>
      </div>
    </div>
  </summary>
  <div class="phase-body">
    <div class="phase-col"><h4>Milestones</h4><ul class="phase-list">${msRows}</ul></div>
    <div class="phase-col"><h4>Tasks</h4><ul class="phase-list">${taskRows}</ul></div>
  </div>
</details>`;
  }).join('');

  return `
<section class="section">
  <div class="section-hd">
    <div><h2>🗂 Phase View</h2><p>阶段视图作为参考视图，用来复盘，不作为第一工作入口。</p></div>
  </div>
  <div class="phase-stack">${items}</div>
</section>`;
}

function renderTimeline(board) {
  const items = [];
  for (const ph of board) {
    if (ph.due) items.push({ name: ph.name, date: ph.due, type: 'phase' });
    for (const m of ph.milestones)
      if (m.due) items.push({ name: m.name, date: m.due, type: 'ms', status: m.status });
  }
  if (!items.length) return '';

  items.sort((a,b) => a.date.localeCompare(b.date));
  const first = new Date(items[0].date);
  const last  = new Date(items[items.length-1].date);
  const today = new Date();
  const span  = Math.max(1, last - first);
  const pct   = d => Math.min(97, Math.max(3, ((new Date(d)-first)/span)*94+3));
  const todayPct = Math.min(97, Math.max(3, ((today-first)/span)*94+3));

  const markers = items.map(it => {
    const label = it.name.length > 14 ? it.name.slice(0,12)+'…' : it.name;
    const cls   = it.type === 'phase' ? 'tl-phase' : `tl-ms tl-ms--${statusCls(it.status||'pending')}`;
    return `<div class="tl-marker ${cls}" style="left:${pct(it.date)}%" title="${esc(it.name)} — ${esc(fmtDate(it.date))}">
      <div class="tl-dot"></div>
      <div class="tl-lbl">${esc(label)}</div>
    </div>`;
  }).join('');

  return `
<section class="section timeline-wrap">
  <div class="section-hd compact">
    <div><h2>🕒 Timeline</h2><p>时间轴仅作辅助查看。</p></div>
  </div>
  <div class="tl-track">
    <div class="tl-line"></div>
    ${markers}
    <div class="tl-today" style="left:${todayPct}%">
      <div class="tl-today-line"></div>
      <div class="tl-today-lbl">Today</div>
    </div>
  </div>
</section>`;
}

// ── Client-side filter + search script ───────────────────────────────────────

function renderScript() {
  return `
<script>
(() => {
  const filterBtns = Array.from(document.querySelectorAll('.filter-btn'));
  const ownerBtns  = Array.from(document.querySelectorAll('[data-owner-filter]'));
  const rows       = Array.from(document.querySelectorAll('.task-row'));
  const search     = document.getElementById('taskSearch');
  const counter    = document.getElementById('taskCount');
  let activeFilter = 'all';
  let ownerFilter  = '';

  function matchFilter(row) {
    if (ownerFilter && row.dataset.owner !== ownerFilter) return false;
    if (activeFilter === 'all')       return true;
    if (activeFilter === 'attention') return ['blocked','overdue','atrisk'].includes(row.dataset.risk);
    if (activeFilter === 'active')    return row.dataset.status === 'active';
    if (activeFilter === 'done')      return row.dataset.status === 'done';
    return row.dataset.risk === activeFilter;
  }

  function apply() {
    const q = (search ? search.value : '').trim().toLowerCase();
    let visible = 0;
    rows.forEach(row => {
// ── Client-side filter + search script ───────────────────────────────────────

function renderScript() {
  return `
<script>
(() => {
  const filterBtns = Array.from(document.querySelectorAll('.filter-btn'));
  const ownerBtns  = Array.from(document.querySelectorAll('[data-owner-filter]'));
  const rows       = Array.from(document.querySelectorAll('.task-row'));
  const search     = document.getElementById('taskSearch');
  const counter    = document.getElementById('taskCount');
  let activeFilter = 'all';
  let ownerFilter  = '';

  function matchFilter(row) {
    if (ownerFilter && row.dataset.owner !== ownerFilter) return false;
    if (activeFilter === 'all')       return true;
    if (activeFilter === 'attention') return ['blocked','overdue','atrisk'].includes(row.dataset.risk);
    if (activeFilter === 'active')    return row.dataset.status === 'active';
    if (activeFilter === 'done')      return row.dataset.status === 'done';
    return row.dataset.risk === activeFilter;
  }

  function apply() {
    const q = (search ? search.value : '').trim().toLowerCase();
    let visible = 0;
    rows.forEach(row => {
      const show = matchFilter(row) && (!q || row.dataset.search.includes(q));
      row.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    if (counter) counter.textContent = visible;
  }

  filterBtns.forEach(btn => btn.addEventListener('click', () => {
    filterBtns.forEach(x => x.classList.remove('is-active'));
    btn.classList.add('is-active');
    activeFilter = btn.dataset.filter;
    ownerFilter  = '';
    apply();
  }));

  ownerBtns.forEach(btn => btn.addEventListener('click', () => {
    const f = btn.dataset.ownerFilter || '';
    ownerFilter  = ownerFilter === f ? '' : f;
    activeFilter = 'all';
    filterBtns.forEach(x => x.classList.remove('is-active'));
    const allBtn = filterBtns.find(x => x.dataset.filter === 'all');
    if (allBtn) allBtn.classList.add('is-active');
    apply();
    document.querySelector('.task-table')?.scrollIntoView({ behavior:'smooth', block:'start' });
  }));

  if (search) search.addEventListener('input', apply);
  apply();
})();
<\/script>\`;
}

// ── Full page ─────────────────────────────────────────────────────────────────

export function renderBoard({ board, allBlocked, summary, lastSync }) {
  const title    = cfg.boardTitle;
  const domain   = cfg.boardDomain;
  const allTasks = enrichTasks(board);
  const year     = new Date().getFullYear();

  const syncTime = new Date(lastSync).toLocaleString('zh-CN', {
    weekday:'short', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit',
  });

  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex,nofollow">
<style>
:root {
  --bg:#f4f5f7;
  --card:#ffffff;
  --line:#e4e7ed;
  --line-soft:#eef0f4;
  --text:#111827;
  --text-secondary:#374151;
  --muted:#6b7280;
  --muted-light:#9ca3af;
  --blue:#1d4ed8;
  --blue-light:#dbeafe;
  --green:#15803d;
  --green-light:#dcfce7;
  --red:#b91c1c;
  --red-light:#fee2e2;
  --orange:#c2410c;
  --orange-light:#ffedd5;
  --amber:#92400e;
  --amber-light:#fef3c7;
  --radius-sm:6px;
  --radius:10px;
  --radius-lg:14px;
  --shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);
  --shadow-md:0 2px 8px rgba(0,0,0,.07),0 1px 3px rgba(0,0,0,.05);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:14px;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Inter",sans-serif;
  background:var(--bg);color:var(--text);line-height:1.6;min-height:100vh}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline}
button{font-family:inherit}
.wrap{max-width:1200px;margin:0 auto;padding:24px 16px 48px}

/* ── header ── */
.header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;
  margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.title h1{font-size:20px;font-weight:700;margin-bottom:3px;letter-spacing:-.025em;color:var(--text)}
.title p{color:var(--muted);font-size:12px;letter-spacing:.01em}
.sync{color:var(--muted-light);font-size:11px;text-align:right;line-height:1.7;flex-shrink:0}
.sync strong{color:var(--muted);font-weight:500}

/* ── hero grid ── */
.hero-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-bottom:16px}
.hero-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  padding:14px 12px;box-shadow:var(--shadow)}
.hero-num{font-size:24px;font-weight:800;line-height:1;letter-spacing:-.03em}
.hero-lbl{margin-top:6px;font-size:11px;color:var(--muted);line-height:1.45;font-weight:500}
.hero-lbl span{display:block;color:var(--text-secondary);font-size:10px;font-weight:400;margin-top:1px}
.hero-card--blocked .hero-num{color:var(--red)}
.hero-card--overdue .hero-num{color:var(--orange)}
.hero-card--risk .hero-num{color:var(--amber)}
.hero-card--active .hero-num{color:var(--blue)}
.hero-card--done .hero-num{color:var(--green)}
.hero-card--total .hero-num{color:var(--text)}

/* ── section ── */
.section{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-lg);
  padding:16px;margin-bottom:12px;box-shadow:var(--shadow)}
.section--attention{border-color:#fca5a5;border-left:3px solid var(--red)}
.section-hd{display:flex;justify-content:space-between;align-items:flex-start;
  gap:12px;margin-bottom:12px}
.section-hd.compact{margin-bottom:8px}
.section-hd h2{font-size:15px;font-weight:700;margin-bottom:2px;color:var(--text)}
.section-hd p{margin:0;color:var(--muted);font-size:12px}
.section-count{min-width:32px;height:32px;border-radius:var(--radius-sm);background:var(--blue-light);
  color:var(--blue);display:flex;align-items:center;justify-content:center;
  font-weight:700;font-size:13px;flex-shrink:0}

/* ── attention zone ── */
.attention-list{display:flex;flex-direction:column;gap:8px}
.attention-item{display:flex;justify-content:space-between;gap:12px;
  border:1px solid var(--line);border-left:3px solid;border-radius:var(--radius);
  padding:11px 12px;background:#fefefe;cursor:pointer;transition:background .12s}
.attention-item:hover{background:#fafbff}
.attention-item--blocked{border-left-color:var(--red);background:#fff8f8}
.attention-item--overdue{border-left-color:var(--orange);background:#fffaf7}
.attention-item--atrisk{border-left-color:var(--amber);background:#fffdf5}
.attention-main{flex:1;min-width:0}
.attention-title{font-weight:600;margin-bottom:5px;font-size:13px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.attention-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.attention-problem{min-width:140px;max-width:240px;color:#7c2d12;
  font-weight:600;font-size:12px;flex-shrink:0;text-align:right;padding-left:8px}
.meta-tag{background:#f3f4f6;border-radius:4px;padding:2px 6px;font-size:11px;color:#374151;
  white-space:nowrap}
.meta-tag--warn{background:#fff7ed;color:#9a3412}
.empty-attention{padding:12px 14px;border:1px dashed var(--line);border-radius:var(--radius);
  background:#f9fafb;color:var(--muted);font-size:13px;text-align:center}

/* ── controls ── */
.controls-bar{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center}
.filter-group{display:flex;gap:5px;flex-wrap:wrap}
.filter-btn{background:#f3f4f6;color:#374151;padding:6px 11px;border-radius:6px;
  font-weight:500;font-size:12px;border:1px solid transparent;cursor:pointer;
  transition:background .12s,border-color .12s}
.filter-btn:hover{background:#e9eaec;border-color:var(--line)}
.filter-btn.is-active{background:var(--text);color:#fff;border-color:var(--text)}
.search-input{min-width:200px;max-width:280px;width:100%;padding:6px 10px;
  border:1px solid var(--line);border-radius:6px;background:var(--card);
  font-size:12px;color:var(--text)}
.search-input:focus{outline:none;border-color:#93c5fd;box-shadow:0 0 0 3px rgba(59,130,246,.1)}

/* ── task table ── */
.table-wrap{overflow-x:auto;margin:0 -2px}
.task-table{width:100%;border-collapse:collapse;min-width:780px;font-size:13px}
.task-table th{text-align:left;font-size:10.5px;letter-spacing:.05em;color:var(--muted);
  padding:8px 10px;border-bottom:2px solid var(--line);text-transform:uppercase;
  white-space:nowrap;font-weight:600;background:var(--card)}
.task-table td{padding:9px 10px;border-bottom:1px solid var(--line-soft);
  vertical-align:middle;color:var(--text-secondary)}
.task-table tbody tr:last-child td{border-bottom:none}
.task-table tbody tr:hover td{background:#f8faff}
.task-link{font-weight:600;color:var(--text);font-size:13px}
.task-link:hover{color:var(--blue)}
.task-code{display:inline-block;margin-left:5px;padding:1px 5px;border-radius:4px;
  background:#eef2ff;color:#3730a3;font-family:ui-monospace,monospace;
  font-size:10.5px;font-weight:600;letter-spacing:.02em}
.col-task{min-width:180px}
.col-owner{white-space:nowrap}
.col-phase{color:var(--muted);font-size:12px;white-space:nowrap}
.due--overdue{color:var(--red);font-weight:600}
.due--soon{color:var(--orange);font-weight:600}
.due--normal{color:var(--muted)}
.problem-cell{max-width:200px;color:#7c2d12;font-size:12px;font-weight:500}
.muted-cell{color:var(--muted-light);font-size:12px}
.owner-btn{background:none;border:none;cursor:pointer;color:var(--text-secondary);
  font-size:13px;padding:0;text-align:left;font-weight:500}
.owner-btn:hover{color:var(--blue);text-decoration:underline}

/* ── badges ── */
.badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:4px;
  font-size:11px;font-weight:600;white-space:nowrap;letter-spacing:.01em}
.badge--done{background:var(--green-light);color:var(--green)}
.badge--active{background:var(--blue-light);color:var(--blue)}
.badge--blocked{background:var(--red-light);color:var(--red)}
.badge--draft,.badge--pending{background:#f3f4f6;color:#4b5563}

/* ── risk tags ── */
.risk{display:inline-flex;align-items:center;padding:2px 7px;border-radius:4px;
  font-size:11px;font-weight:600;white-space:nowrap}
.risk--blocked{background:var(--red-light);color:var(--red)}
.risk--overdue{background:var(--orange-light);color:var(--orange)}
.risk--atrisk{background:var(--amber-light);color:var(--amber)}
.risk--active{background:var(--blue-light);color:var(--blue)}
.risk--done{background:var(--green-light);color:var(--green)}
.risk--normal{background:#f3f4f6;color:var(--muted)}

/* ── owner grid ── */
.owner-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
.owner-card{padding:12px 14px;border-radius:var(--radius);background:#fafbff;
  border:1px solid var(--line);text-align:left;cursor:pointer;
  transition:border-color .12s,background .12s}
.owner-card:hover{border-color:#93c5fd;background:#eff6ff}
.owner-name{font-weight:700;margin-bottom:8px;font-size:13px;color:var(--text)}
.owner-stats{display:flex;flex-wrap:wrap;gap:5px}
.ostat{display:inline-flex;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600}
.ostat--active{background:var(--blue-light);color:var(--blue)}
.ostat--blocked{background:var(--red-light);color:var(--red)}
.ostat--overdue{background:var(--orange-light);color:var(--orange)}
.ostat--risk{background:var(--amber-light);color:var(--amber)}

/* ── phase section ── */
.phase-stack{display:grid;gap:8px}
.phase-card{border:1px solid var(--line);border-radius:var(--radius-lg);padding:0 14px;
  background:var(--card)}
.phase-card[open]{border-color:#bfdbfe}
.phase-card summary{list-style:none;padding:12px 0;cursor:pointer;user-select:none}
.phase-card summary::-webkit-details-marker{display:none}
.phase-top{display:flex;justify-content:space-between;gap:12px;align-items:center}
.phase-name{font-size:14px;font-weight:700;margin-bottom:4px;color:var(--text)}
.phase-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center;font-size:12px}
.phase-stats{min-width:200px;flex-shrink:0}
.phase-percent{text-align:right;font-size:18px;font-weight:800;color:var(--text);letter-spacing:-.02em}
.prog-track{margin-top:5px;height:6px;background:#e5e7eb;border-radius:999px;overflow:hidden}
.prog-fill{height:100%;border-radius:999px;transition:width .4s ease}
.prog-fill--done{background:var(--green)}
.prog-fill--active{background:var(--blue)}
.prog-fill--blocked{background:var(--red)}
.prog-fill--draft,.prog-fill--pending{background:#d1d5db}
.phase-counts{margin-top:4px;text-align:right;color:var(--muted);font-size:11px}
.phase-body{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:4px 0 12px}
.phase-col h4{margin:0 0 6px;font-size:11px;font-weight:700;color:var(--muted);
  text-transform:uppercase;letter-spacing:.05em}
.phase-list{margin:0;padding-left:14px}
.phase-list li{margin:5px 0;font-size:12px;color:var(--text-secondary)}

/* ── timeline ── */
.timeline-wrap .tl-track{position:relative;height:62px;margin-top:6px}
.tl-line{position:absolute;top:24px;left:0;right:0;height:2px;background:var(--line);border-radius:1px}
.tl-marker{position:absolute;top:0;transform:translateX(-50%);text-align:center}
.tl-dot{width:10px;height:10px;border-radius:50%;margin:19px auto 4px;
  background:#6366f1;border:2px solid var(--card)}
.tl-phase .tl-dot{width:12px;height:12px;margin-top:18px;background:#1e1b4b}
.tl-lbl{font-size:10.5px;color:var(--muted);max-width:80px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;line-height:1.3}
.tl-today{position:absolute;top:0;transform:translateX(-50%)}
.tl-today-line{width:2px;height:40px;background:var(--red);margin:0 auto;
  border-radius:1px;opacity:.7}
.tl-today-lbl{font-size:10px;font-weight:700;text-align:center;margin-top:3px;
  color:var(--red)}

/* ── footer ── */
.footer{margin-top:32px;padding:18px 0 8px;border-top:1px solid var(--line);
  text-align:center}
.footer-brand{font-size:13px;font-weight:700;color:var(--text-secondary);
  letter-spacing:.04em;margin-bottom:4px}
.footer-tagline{font-size:11px;color:var(--muted-light);letter-spacing:.03em;
  margin-bottom:4px}
.footer-copy{font-size:11px;color:var(--muted-light)}

/* ── misc ── */
.empty-box{padding:12px 14px;border:1px dashed var(--line);border-radius:var(--radius);
  background:#f9fafb;color:var(--muted);font-size:13px}

/* ── responsive ── */
@media(max-width:1080px){
  .hero-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .phase-top{flex-direction:column;align-items:flex-start}
  .phase-stats{min-width:auto;width:100%}
  .phase-counts,.phase-percent{text-align:left}
  .phase-body{grid-template-columns:1fr}
}
@media(max-width:720px){
  .wrap{padding:14px 12px 36px}
  .header{flex-direction:column;align-items:flex-start}
  .hero-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .attention-item{flex-direction:column}
  .attention-problem{max-width:none;min-width:0;text-align:left;padding-left:0}
  .search-input{min-width:0;width:100%}
  .section-hd{flex-direction:column}
  .section-count{width:32px}
  .filter-group{width:100%}
  .tl-lbl{display:none}
  .hero-card--total{display:none}
}
@media(max-width:460px){
  .hero-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .hero-card--risk,.hero-card--total{display:none}
}
</style>
<body>
<div class="wrap">
  <header class="header">
    <div class="title">
      <h1>ARCBOS Execution Board</h1>
      <p>${esc(title)} &nbsp;·&nbsp; Notion → GitHub Pages</p>
    </div>
    <div class="sync">
      <strong>Last sync</strong><br>
      ${esc(syncTime)}<br>
      <span style="opacity:.7;font-size:10px">${esc(domain)}</span>
    </div>
  </header>

  ${renderHeroGrid(summary, allTasks)}
  ${renderAttentionZone(allTasks)}
  ${renderControls()}
  ${renderTaskList(allTasks)}
  ${renderOwnerView(allTasks)}
  ${renderPhaseSection(board)}
  ${renderTimeline(board)}

  <footer class="footer">
    <div class="footer-brand">ARCBOS</div>
    <div class="footer-tagline">Engineered for Extreme Conditions</div>
    <div class="footer-copy">© ${year} ARCBOS. All rights reserved. &nbsp;·&nbsp; Auto-published from Notion</div>
  </footer>
</div>
${renderScript()}
</body></html>`;
}
