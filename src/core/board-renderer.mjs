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
</script>`;
}

// ── Full page ─────────────────────────────────────────────────────────────────

export function renderBoard({ board, allBlocked, summary, lastSync }) {
  const title    = cfg.boardTitle;
  const domain   = cfg.boardDomain;
  const allTasks = enrichTasks(board);

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
  --bg:#f6f7fb; --card:#fff; --line:#e8ebf2; --text:#172033; --muted:#6b7280;
  --blue:#2563eb; --green:#16a34a; --red:#dc2626; --orange:#f97316; --amber:#d97706;
  --shadow:0 2px 12px rgba(16,24,40,.07);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:15px;-webkit-font-smoothing:antialiased}
body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  background:var(--bg);color:var(--text);line-height:1.55;min-height:100vh}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1280px;margin:0 auto;padding:28px 18px 56px}

/* ── header ── */
.header{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;margin-bottom:20px;flex-wrap:wrap}
.title h1{font-size:26px;font-weight:800;margin-bottom:4px;letter-spacing:-.02em}
.title p{color:var(--muted);font-size:13px}
.sync{color:var(--muted);font-size:12px;text-align:right;line-height:1.6}

/* ── hero grid ── */
.hero-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:18px}
.hero-card{background:var(--card);border:1px solid var(--line);border-radius:16px;
  padding:16px 14px;box-shadow:var(--shadow)}
.hero-num{font-size:28px;font-weight:800;line-height:1}
.hero-lbl{margin-top:8px;font-size:12px;color:var(--muted);line-height:1.4}
.hero-lbl span{color:var(--text);font-weight:500}
.hero-card--blocked .hero-num{color:var(--red)}
.hero-card--overdue .hero-num{color:var(--orange)}
.hero-card--risk .hero-num{color:var(--amber)}
.hero-card--active .hero-num{color:var(--blue)}
.hero-card--done .hero-num{color:var(--green)}

/* ── section ── */
.section{background:var(--card);border:1px solid var(--line);border-radius:18px;
  padding:18px;margin-bottom:16px;box-shadow:var(--shadow)}
.section--attention{border-color:#fecaca}
.section-hd{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:14px}
.section-hd.compact{margin-bottom:10px}
.section-hd h2{margin:0 0 3px;font-size:18px;font-weight:700}
.section-hd p{margin:0;color:var(--muted);font-size:13px}
.section-count{min-width:44px;height:44px;border-radius:12px;background:#eef2ff;
  color:var(--blue);display:flex;align-items:center;justify-content:center;
  font-weight:800;font-size:16px;flex-shrink:0}

/* ── attention zone ── */
.attention-list{display:grid;gap:10px}
.attention-item{display:flex;justify-content:space-between;gap:14px;
  border:1px solid var(--line);border-left:4px solid;border-radius:14px;
  padding:13px 14px;background:#fcfcfe;cursor:pointer}
.attention-item:hover{background:#fafaff}
.attention-item--blocked{border-left-color:var(--red)}
.attention-item--overdue{border-left-color:var(--orange)}
.attention-item--atrisk{border-left-color:var(--amber)}
.attention-title{font-weight:700;margin-bottom:7px;font-size:14px}
.attention-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.attention-problem{min-width:180px;max-width:280px;color:#7c2d12;font-weight:600;font-size:13px;flex-shrink:0}
.meta-tag{background:#f3f4f6;border-radius:999px;padding:3px 8px;font-size:12px;color:#374151}
.meta-tag--warn{background:#fff7ed;color:#9a3412}

/* ── controls ── */
.controls-bar{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.filter-group{display:flex;gap:6px;flex-wrap:wrap}
.filter-btn{background:#f3f4f6;color:#374151;padding:8px 13px;border-radius:999px;
  font-weight:600;font-size:13px;border:none;cursor:pointer;transition:background .15s}
.filter-btn:hover{background:#e5e7eb}
.filter-btn.is-active{background:#111827;color:#fff}
.search-input{min-width:240px;max-width:320px;width:100%;padding:9px 13px;
  border:1px solid var(--line);border-radius:12px;background:#fff;font-size:13px}
.search-input:focus{outline:none;border-color:#c7d2fe}

/* ── task table ── */
.table-wrap{overflow:auto}
.task-table{width:100%;border-collapse:collapse;min-width:860px}
.task-table th{text-align:left;font-size:11px;letter-spacing:.04em;color:var(--muted);
  padding:10px 10px;border-bottom:1px solid var(--line);text-transform:uppercase;white-space:nowrap}
.task-table td{padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:top;font-size:13px}
.task-table tbody tr:hover{background:#fafbff}
.task-link{font-weight:600;color:var(--text)}
.task-link:hover{color:var(--blue);text-decoration:underline}
.task-code{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;
  background:#eef2ff;color:#3730a3;font-family:ui-monospace,monospace;font-size:11px}
.col-task{min-width:200px}
.col-phase{color:var(--muted);font-size:12px}
.due--overdue{color:var(--red);font-weight:700}
.due--soon{color:var(--orange);font-weight:700}
.problem-cell{max-width:220px;color:#7c2d12;font-weight:600;font-size:12px}
.muted{color:var(--muted)}
.owner-btn{background:none;border:none;cursor:pointer;color:var(--blue);font-weight:600;
  font-size:13px;padding:0;text-align:left}
.owner-btn:hover{text-decoration:underline}

/* ── badges & risk ── */
.badge,.risk{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;
  font-size:12px;font-weight:700;white-space:nowrap}
.badge--done{background:#dcfce7;color:#166534}
.badge--active{background:#dbeafe;color:#1d4ed8}
.badge--blocked{background:#fee2e2;color:#991b1b}
.badge--draft,.badge--pending{background:#f3f4f6;color:#4b5563}
.risk--blocked{background:#fee2e2;color:#991b1b}
.risk--overdue{background:#ffedd5;color:#9a3412}
.risk--atrisk{background:#fef3c7;color:#92400e}
.risk--active{background:#dbeafe;color:#1d4ed8}
.risk--done{background:#dcfce7;color:#166534}
.risk--normal{background:#f3f4f6;color:#6b7280}

/* ── owner grid ── */
.owner-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.owner-card{padding:14px;border-radius:14px;background:#fafbff;border:1px solid var(--line);
  text-align:left;cursor:pointer;transition:border-color .15s,background .15s}
.owner-card:hover{border-color:#c7d2fe;background:#eef2ff}
.owner-name{font-weight:800;margin-bottom:9px;font-size:14px}
.owner-stats{display:flex;flex-wrap:wrap;gap:6px}
.ostat{display:inline-flex;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:700}
.ostat--active{background:#dbeafe;color:#1d4ed8}
.ostat--blocked{background:#fee2e2;color:#991b1b}
.ostat--overdue{background:#ffedd5;color:#9a3412}
.ostat--risk{background:#fef3c7;color:#92400e}

/* ── phase section ── */
.phase-stack{display:grid;gap:10px}
.phase-card{border:1px solid var(--line);border-radius:16px;padding:0 16px;background:#fcfcfe}
.phase-card summary{list-style:none;padding:14px 0;cursor:pointer;user-select:none}
.phase-card summary::-webkit-details-marker{display:none}
.phase-top{display:flex;justify-content:space-between;gap:16px;align-items:center}
.phase-name{font-size:16px;font-weight:800;margin-bottom:5px}
.phase-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}
.phase-stats{min-width:240px;flex-shrink:0}
.phase-percent{text-align:right;font-size:20px;font-weight:800}
.prog-track{margin-top:6px;height:8px;background:#e5e7eb;border-radius:999px;overflow:hidden}
.prog-fill{height:100%;border-radius:999px;transition:width .3s}
.prog-fill--done{background:linear-gradient(90deg,#34d399,#10b981)}
.prog-fill--active{background:linear-gradient(90deg,#60a5fa,#2563eb)}
.prog-fill--blocked{background:linear-gradient(90deg,#fca5a5,#dc2626)}
.prog-fill--draft,.prog-fill--pending{background:#cbd5e1}
.phase-counts{margin-top:5px;text-align:right;color:var(--muted);font-size:12px}
.phase-body{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:4px 0 14px}
.phase-col h4{margin:0 0 7px;font-size:13px;font-weight:700;color:var(--muted)}
.phase-list{margin:0;padding-left:16px}
.phase-list li{margin:6px 0;font-size:13px}

/* ── timeline ── */
.timeline-wrap .tl-track{position:relative;height:68px;margin-top:8px}
.tl-line{position:absolute;top:28px;left:0;right:0;height:2px;background:#e5e7eb;border-radius:1px}
.tl-marker{position:absolute;top:0;transform:translateX(-50%);text-align:center}
.tl-dot{width:11px;height:11px;border-radius:50%;margin:22px auto 5px;background:#4f46e5;border:2px solid #fff}
.tl-phase .tl-dot{width:14px;height:14px;margin-top:21px;background:#1e1b4b}
.tl-lbl{font-size:11px;color:var(--muted);max-width:82px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2}
.tl-today{position:absolute;top:0;transform:translateX(-50%)}
.tl-today-line{width:2px;height:44px;background:#111827;margin:0 auto;border-radius:1px}
.tl-today-lbl{font-size:11px;font-weight:800;text-align:center;margin-top:4px}

/* ── misc ── */
.empty-box{padding:14px 16px;border:1px dashed var(--line);border-radius:14px;
  background:#fafbff;color:var(--muted);font-size:14px}
.footer{text-align:center;font-size:12px;color:var(--muted);margin-top:28px;
  padding-top:12px;border-top:1px solid var(--line)}

/* ── responsive ── */
@media(max-width:1080px){
  .hero-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .phase-top{flex-direction:column;align-items:flex-start}
  .phase-stats{min-width:auto;width:100%}
  .phase-counts,.phase-percent{text-align:left}
  .phase-body{grid-template-columns:1fr}
}
@media(max-width:720px){
  .wrap{padding:16px 12px 40px}
  .header{flex-direction:column;align-items:flex-start}
  .hero-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .attention-item{flex-direction:column}
  .attention-problem{max-width:none;min-width:0}
  .search-input{min-width:0;width:100%}
  .section-hd{flex-direction:column}
  .section-count{width:44px}
  .filter-group{width:100%}
  .tl-lbl{display:none}
}
</style>
<body>
<div class="wrap">
  <header class="header">
    <div class="title">
      <h1>${esc(title)}</h1>
      <p>Operational Board · 先看问题，再看任务，再看阶段。打开即知道"谁该做什么"。</p>
    </div>
    <div class="sync">
      Last sync: ${esc(syncTime)}<br>
      <span style="opacity:.7">${esc(domain)}</span>
    </div>
  </header>

  ${renderHeroGrid(summary, allTasks)}
  ${renderAttentionZone(allTasks)}
  ${renderControls()}
  ${renderTaskList(allTasks)}
  ${renderOwnerView(allTasks)}
  ${renderPhaseSection(board)}
  ${renderTimeline(board)}

  <div class="footer">
    ${esc(domain)} &nbsp;·&nbsp; © ${new Date().getFullYear()} ARCBOS &nbsp;·&nbsp;
    Auto-published from Notion
  </div>
</div>
${renderScript()}
</body></html>`;
}
