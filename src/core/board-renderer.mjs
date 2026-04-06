// src/core/board-renderer.mjs
// v1.1.0 — redesigned hero, task list hides Done by default, cleaner layout
// Pure function — no Notion calls, no file I/O.

import { cfg } from '../lib/config.mjs';

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

function computeRisk(task) {
  const s  = (task.status || '').toLowerCase();
  const dd = daysUntil(task.due);
  if (s === 'blocked')                          return 'blocked';
  if (s !== 'done' && dd !== null && dd < 0)   return 'overdue';
  if (s === 'active' && dd !== null && dd <= 3) return 'atrisk';
  if (s === 'done')                             return 'done';
  if (s === 'active')                           return 'active';
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

function enrichTasks(board) {
  const all = [];
  for (const ph of board) {
    for (const t of ph.tasks) {
      const dd = daysUntil(t.due);
      all.push({ ...t, _phaseName: ph.name, _dueDays: dd, _risk: computeRisk(t) });
    }
  }
  return all;
}

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

function problemText(task) {
  if (task.status === 'Blocked') return task.blockedBy || 'Blocked — 原因未填写';
  if (task._risk === 'overdue')  return `已逾期 ${Math.abs(task._dueDays)} 天`;
  if (task._risk === 'atrisk')   return `即将到期（${task._dueDays} 天内）`;
  if (!task.owner)               return '未指派负责人';
  return '';
}

function notionUrl(pageId) {
  return `https://notion.so/${String(pageId).replace(/-/g, '')}`;
}

function linkTask(task) {
  const name = esc(task.name || 'Untitled');
  const code = task.taskCode ? `<span class="task-code">${esc(task.taskCode)}</span>` : '';
  return `<a class="task-link" href="${esc(notionUrl(task.id))}" target="_blank" rel="noopener">${name}${code}</a>`;
}

function safePhaseProgress(ph) {
  if (ph.status === 'Done') return 100;
  const pct = ph.total ? Math.round((ph.done / ph.total) * 100) : 0;
  if (ph.status === 'Active' && pct >= 100) return 99;
  return pct;
}

// ── Section: Two-tier hero ────────────────────────────────────────────────────
// Top row: issues (large, colored) — what needs action TODAY
// Bottom row: background stats (small, muted)

function renderHeroGrid(summary, allTasks) {
  const overdue = allTasks.filter(t => t._risk === 'overdue').length;
  const atrisk  = allTasks.filter(t => t._risk === 'atrisk').length;
  const hasIssue = summary.totalBlocked > 0 || overdue > 0 || atrisk > 0;

  return `
<div class="hero-wrap">
  <div class="hero-primary">
    <div class="hero-primary-label">需要今日处理</div>
    <div class="hero-primary-cards">
      <div class="hpc hpc--blocked ${summary.totalBlocked === 0 ? 'hpc--zero' : ''}">
        <div class="hpc-num">${summary.totalBlocked}</div>
        <div class="hpc-lbl">🔴 阻塞</div>
      </div>
      <div class="hpc hpc--overdue ${overdue === 0 ? 'hpc--zero' : ''}">
        <div class="hpc-num">${overdue}</div>
        <div class="hpc-lbl">🟠 逾期</div>
      </div>
      <div class="hpc hpc--risk ${atrisk === 0 ? 'hpc--zero' : ''}">
        <div class="hpc-num">${atrisk}</div>
        <div class="hpc-lbl">🟡 风险</div>
      </div>
    </div>
    ${hasIssue ? '' : '<div class="hero-all-clear">✅ 当前执行正常，无需立即处理</div>'}
  </div>
  <div class="hero-secondary">
    <span class="hsc"><span class="hsc-num">${summary.totalActive}</span><span class="hsc-lbl">进行中</span></span>
    <span class="hsc-sep">·</span>
    <span class="hsc"><span class="hsc-num">${summary.totalDone}</span><span class="hsc-lbl">已完成</span></span>
    <span class="hsc-sep">·</span>
    <span class="hsc"><span class="hsc-num">${summary.totalTasks}</span><span class="hsc-lbl">总计</span></span>
    ${summary.totalDraft ? `<span class="hsc-sep">·</span><span class="hsc"><span class="hsc-num">${summary.totalDraft}</span><span class="hsc-lbl">待审批</span></span>` : ''}
  </div>
</div>`;
}

// ── Section: Attention Zone ───────────────────────────────────────────────────

function renderAttentionZone(allTasks) {
  const items = allTasks
    .filter(t => t._risk === 'blocked' || t._risk === 'overdue' || t._risk === 'atrisk')
    .sort(compareTasks);

  if (!items.length) return '';

  const content = items.map(t => `
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
</a>`).join('');

  return `
<section class="section section--attention">
  <div class="section-hd">
    <div><h2>🚨 Needs Attention</h2><p>先处理这里，再看下方任务列表。</p></div>
    <div class="section-count section-count--red">${items.length}</div>
  </div>
  <div class="attention-list">${content}</div>
</section>`;
}

// ── Section: Task List (Done hidden by default) ───────────────────────────────

function renderTaskList(allTasks) {
  const sorted = [...allTasks].sort(compareTasks);
  const active = sorted.filter(t => t.status !== 'Done' && t.status !== 'Draft');
  const done   = sorted.filter(t => t.status === 'Done');

  function row(t) {
    const problem = problemText(t);
    const dueCls  = t._risk === 'overdue' ? 'due--overdue'
                  : t._risk === 'atrisk'  ? 'due--soon' : '';
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
  <td class="${problem ? 'problem-cell' : 'muted'}">${problem || '—'}</td>
</tr>`;
  }

  const doneSection = done.length ? `
<tr class="done-toggle-row" id="doneToggleRow">
  <td colspan="7">
    <button class="done-toggle" id="doneToggleBtn" onclick="toggleDone()">
      ▶ 显示已完成任务（${done.length} 项）
    </button>
  </td>
</tr>
${done.map(t => `<tr class="task-row done-row" data-status="done" data-risk="done" data-owner="${esc((t.owner||'未指派').toLowerCase())}" data-search="${esc(`${t.name} ${t.taskCode||''} ${t.owner||''} ${t._phaseName||''}`.toLowerCase())}" style="display:none">${`
  <td class="col-task">${linkTask(t)}</td>
  <td>${badge(t.status)}</td>
  <td><button class="owner-btn" data-owner-filter="${esc((t.owner||'未指派').toLowerCase())}">${esc(t.owner||'未指派')}</button></td>
  <td class="col-phase">${esc(t._phaseName)}</td>
  <td>${esc(fmtDate(t.due)) || '—'}</td>
  <td>${riskBadge(t)}</td>
  <td class="muted">—</td>`}
</tr>`).join('')}` : '';

  return `
<section class="section">
  <div class="section-hd">
    <div><h2>📋 Task List</h2><p>问题任务排在最前，点击负责人过滤。已完成默认折叠。</p></div>
    <div class="section-count" id="taskCount">${active.length}</div>
  </div>
  <div class="controls-bar" style="margin-bottom:10px">
    <div class="filter-group">
      <button class="filter-btn is-active" data-filter="all">全部活跃</button>
      <button class="filter-btn" data-filter="attention">需关注</button>
      <button class="filter-btn" data-filter="active">进行中</button>
      <button class="filter-btn" data-filter="blocked">阻塞</button>
      <button class="filter-btn" data-filter="overdue">逾期</button>
      <button class="filter-btn" data-filter="atrisk">风险</button>
    </div>
    <input id="taskSearch" class="search-input" type="search" placeholder="搜索任务 / TaskCode / 负责人">
  </div>
  <div class="table-wrap">
    <table class="task-table">
      <thead>
        <tr>
          <th>任务</th><th>状态</th><th>负责人</th>
          <th>阶段</th><th>截止日期</th><th>风险</th><th>问题说明</th>
        </tr>
      </thead>
      <tbody id="taskTableBody">
        ${active.map(row).join('')}
        ${doneSection}
      </tbody>
    </table>
  </div>
</section>`;
}

// ── Section: By Owner ─────────────────────────────────────────────────────────

function renderOwnerView(allTasks) {
  const active = allTasks.filter(t => t.status !== 'Draft' && t.status !== 'Done');
  if (!active.length) return '';

  const map = new Map();
  for (const t of active) {
    const owner = t.owner || '未指派';
    if (!map.has(owner)) map.set(owner, { blocked:0, overdue:0, atrisk:0, active:0, tasks:[] });
    const v = map.get(owner);
    v.tasks.push(t);
    if      (t._risk === 'blocked') v.blocked++;
    else if (t._risk === 'overdue') v.overdue++;
    else if (t._risk === 'atrisk')  v.atrisk++;
    else                            v.active++;
  }

  const cards = [...map.entries()]
    .sort((a,b) => (b[1].blocked+b[1].overdue+b[1].atrisk) - (a[1].blocked+a[1].overdue+a[1].atrisk))
    .map(([owner, v]) => {
      const hasIssue = v.blocked > 0 || v.overdue > 0 || v.atrisk > 0;
      const total = v.tasks.length;
      return `
<button class="owner-card ${hasIssue ? 'owner-card--issue' : ''}" data-owner-filter="${esc(owner.toLowerCase())}">
  <div class="owner-name">👤 ${esc(owner)}</div>
  <div class="owner-load">${total} 项活跃任务</div>
  <div class="owner-stats">
    ${v.active  ? `<span class="ostat ostat--active">${v.active} 进行中</span>` : ''}
    ${v.blocked ? `<span class="ostat ostat--blocked">${v.blocked} 阻塞</span>` : ''}
    ${v.overdue ? `<span class="ostat ostat--overdue">${v.overdue} 逾期</span>` : ''}
    ${v.atrisk  ? `<span class="ostat ostat--risk">${v.atrisk} 风险</span>` : ''}
  </div>
</button>`;
    }).join('');

  return `
<section class="section">
  <div class="section-hd">
    <div><h2>👤 By Owner</h2><p>点击负责人卡片过滤任务列表。有问题的负责人排在前面。</p></div>
  </div>
  <div class="owner-grid">${cards}</div>
</section>`;
}

// ── Section: Phase View ───────────────────────────────────────────────────────

function renderPhaseSection(board) {
  if (!board.length) return '';

  const items = board.map(ph => {
    const pct       = safePhaseProgress(ph);
    const cls       = statusCls(ph.status);
    const dateRange = [fmtDate(ph.startDate), fmtDate(ph.due)].filter(Boolean).join(' — ');
    const isOpen    = ph.status === 'Active' || ph.blocked > 0;
    const daysLeft  = daysUntil(ph.due);
    const daysNote  = daysLeft !== null && ph.status === 'Active'
      ? (daysLeft < 0 ? `<span class="phase-overdue">已逾期 ${Math.abs(daysLeft)} 天</span>`
        : daysLeft <= 14 ? `<span class="phase-urgent">${daysLeft} 天后截止</span>`
        : `<span class="muted">${daysLeft} 天后截止</span>`)
      : '';

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
      <div class="phase-left">
        <div class="phase-name">${esc(ph.name)}</div>
        <div class="phase-meta">
          ${badge(ph.status)}
          ${dateRange ? `<span class="muted">${esc(dateRange)}</span>` : ''}
          ${daysNote}
        </div>
        <div class="phase-task-summary">${ph.done}/${ph.total} 完成 · ${ph.blocked ? `<span style="color:var(--red)">${ph.blocked} 阻塞</span> · ` : ''}${ph.active} 进行中</div>
      </div>
      <div class="phase-right">
        <div class="phase-percent">${pct}%</div>
        <div class="prog-track">
          <div class="prog-fill prog-fill--${cls}" style="width:${pct}%"></div>
        </div>
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
    <div><h2>🗂 Phase View</h2><p>阶段进度总览，参考视图。</p></div>
  </div>
  <div class="phase-stack">${items}</div>
</section>`;
}

// ── Section: Timeline ─────────────────────────────────────────────────────────

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
      <div class="tl-dot"></div><div class="tl-lbl">${esc(label)}</div>
    </div>`;
  }).join('');

  return `
<section class="section timeline-wrap">
  <div class="section-hd compact">
    <div><h2>🕒 Timeline</h2><p>时间轴辅助查看。</p></div>
  </div>
  <div class="tl-track">
    <div class="tl-line"></div>${markers}
    <div class="tl-today" style="left:${todayPct}%">
      <div class="tl-today-line"></div>
      <div class="tl-today-lbl">Today</div>
    </div>
  </div>
</section>`;
}


function renderScript() {
  const tag = 'script';
  const open  = '<'  + tag + '>';
  const close = '</' + tag + '>';
  const js = `
let _doneVisible = false;
function toggleDone() {
  _doneVisible = !_doneVisible;
  const rows = document.querySelectorAll('.done-row');
  const btn  = document.getElementById('doneToggleBtn');
  rows.forEach(r => r.style.display = _doneVisible ? '' : 'none');
  if (btn) btn.textContent = _doneVisible
    ? '▼ 隐藏已完成任务'
    : '▶ 显示已完成任务（' + rows.length + ' 项）';
  applyFilters();
}

(() => {
  const filterBtns = Array.from(document.querySelectorAll('.filter-btn'));
  const ownerBtns  = Array.from(document.querySelectorAll('[data-owner-filter]'));
  const search     = document.getElementById('taskSearch');
  const counter    = document.getElementById('taskCount');
  let activeFilter = 'all';
  let ownerFilter  = '';

  function getRows() {
    return Array.from(document.querySelectorAll('.task-row'));
  }

  function matchFilter(row) {
    if (row.classList.contains('done-row') && !_doneVisible) return false;
    if (ownerFilter && row.dataset.owner !== ownerFilter) return false;
    if (activeFilter === 'all')       return row.dataset.status !== 'done' || _doneVisible;
    if (activeFilter === 'attention') return ['blocked','overdue','atrisk'].includes(row.dataset.risk);
    if (activeFilter === 'active')    return row.dataset.status === 'active';
    if (activeFilter === 'blocked')   return row.dataset.risk === 'blocked';
    if (activeFilter === 'overdue')   return row.dataset.risk === 'overdue';
    if (activeFilter === 'atrisk')    return row.dataset.risk === 'atrisk';
    return false;
  }

  window.applyFilters = function() {
    const q = (search ? search.value : '').trim().toLowerCase();
    let visible = 0;
    getRows().forEach(row => {
      const show = matchFilter(row) && (!q || row.dataset.search.includes(q));
      if (!row.classList.contains('done-row')) {
        row.style.display = show ? '' : 'none';
      }
      if (show && !row.classList.contains('done-row')) visible++;
    });
    const dtr = document.getElementById('doneToggleRow');
    if (dtr) dtr.style.display = '';
    if (counter) counter.textContent = visible;
  }

  filterBtns.forEach(btn => btn.addEventListener('click', () => {
    filterBtns.forEach(x => x.classList.remove('is-active'));
    btn.classList.add('is-active');
    activeFilter = btn.dataset.filter;
    ownerFilter  = '';
    window.applyFilters();
  }));

  ownerBtns.forEach(btn => btn.addEventListener('click', () => {
    const f = btn.dataset.ownerFilter || '';
    ownerFilter  = ownerFilter === f ? '' : f;
    activeFilter = 'all';
    filterBtns.forEach(x => x.classList.remove('is-active'));
    const allBtn = filterBtns.find(x => x.dataset.filter === 'all');
    if (allBtn) allBtn.classList.add('is-active');
    window.applyFilters();
    document.querySelector('.task-table')?.scrollIntoView({ behavior:'smooth', block:'start' });
  }));

  if (search) search.addEventListener('input', window.applyFilters);
  window.applyFilters();
})();
`;
  return open + js + close;
}


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
  --card:#fff;
  --line:#e4e7ed;
  --line-soft:#eef0f4;
  --text:#111827;
  --text-2:#374151;
  --muted:#6b7280;
  --muted-l:#9ca3af;
  --blue:#1d4ed8;
  --blue-l:#dbeafe;
  --green:#15803d;
  --green-l:#dcfce7;
  --red:#b91c1c;
  --red-l:#fee2e2;
  --orange:#c2410c;
  --orange-l:#ffedd5;
  --amber:#92400e;
  --amber-l:#fef3c7;
  --r:10px; --rl:14px; --rs:6px;
  --sh:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:14px;-webkit-font-smoothing:antialiased}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  background:var(--bg);color:var(--text);line-height:1.6;min-height:100vh}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline}
button{font-family:inherit}
.wrap{max-width:1200px;margin:0 auto;padding:24px 16px 48px}

/* header */
.header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;
  margin-bottom:20px;padding-bottom:16px;border-bottom:2px solid var(--line);flex-wrap:wrap}
.title h1{font-size:19px;font-weight:700;margin-bottom:3px;letter-spacing:-.025em}
.title p{color:var(--muted);font-size:11.5px}
.sync{color:var(--muted-l);font-size:11px;text-align:right;line-height:1.7;flex-shrink:0}
.sync strong{color:var(--muted);font-weight:500}

/* hero — two-tier */
.hero-wrap{margin-bottom:16px}
.hero-primary{background:var(--card);border:1px solid var(--line);border-radius:var(--rl);
  padding:18px 20px 14px;box-shadow:var(--sh);margin-bottom:8px}
.hero-primary-label{font-size:10.5px;font-weight:600;color:var(--muted);text-transform:uppercase;
  letter-spacing:.06em;margin-bottom:12px}
.hero-primary-cards{display:flex;gap:12px;flex-wrap:wrap}
.hpc{display:flex;flex-direction:column;align-items:center;min-width:88px;
  padding:12px 16px;border-radius:var(--r);border:1px solid var(--line);background:var(--bg)}
.hpc-num{font-size:32px;font-weight:800;line-height:1;letter-spacing:-.04em}
.hpc-lbl{font-size:12px;font-weight:500;margin-top:5px;color:var(--text-2)}
.hpc--blocked .hpc-num{color:var(--red)}
.hpc--blocked:not(.hpc--zero){background:var(--red-l);border-color:#fca5a5}
.hpc--overdue .hpc-num{color:var(--orange)}
.hpc--overdue:not(.hpc--zero){background:var(--orange-l);border-color:#fed7aa}
.hpc--risk .hpc-num{color:var(--amber)}
.hpc--risk:not(.hpc--zero){background:var(--amber-l);border-color:#fde68a}
.hpc--zero .hpc-num{color:var(--muted-l)}
.hpc--zero .hpc-lbl{color:var(--muted-l)}
.hero-all-clear{margin-top:10px;font-size:13px;color:var(--green);font-weight:500}
.hero-secondary{display:flex;align-items:center;gap:8px;padding:0 4px;flex-wrap:wrap}
.hsc{display:flex;align-items:baseline;gap:4px}
.hsc-num{font-size:15px;font-weight:700;color:var(--text-2)}
.hsc-lbl{font-size:11px;color:var(--muted)}
.hsc-sep{color:var(--line);font-size:13px}

/* section */
.section{background:var(--card);border:1px solid var(--line);border-radius:var(--rl);
  padding:16px;margin-bottom:12px;box-shadow:var(--sh)}
.section--attention{border-color:#fca5a5;border-left:3px solid var(--red)}
.section-hd{display:flex;justify-content:space-between;align-items:flex-start;
  gap:12px;margin-bottom:12px}
.section-hd.compact{margin-bottom:8px}
.section-hd h2{font-size:14px;font-weight:700;margin-bottom:2px}
.section-hd p{margin:0;color:var(--muted);font-size:11.5px}
.section-count{min-width:28px;height:28px;border-radius:var(--rs);background:var(--blue-l);
  color:var(--blue);display:flex;align-items:center;justify-content:center;
  font-weight:700;font-size:12px;flex-shrink:0}
.section-count--red{background:var(--red-l);color:var(--red)}

/* attention */
.attention-list{display:flex;flex-direction:column;gap:7px}
.attention-item{display:flex;justify-content:space-between;gap:12px;
  border:1px solid var(--line);border-left:3px solid;border-radius:var(--r);
  padding:10px 12px;background:#fefefe;cursor:pointer;transition:background .1s}
.attention-item:hover{background:#fafaff}
.attention-item--blocked{border-left-color:var(--red);background:#fff8f8}
.attention-item--overdue{border-left-color:var(--orange);background:#fffaf7}
.attention-item--atrisk{border-left-color:var(--amber);background:#fffdf5}
.attention-main{flex:1;min-width:0}
.attention-title{font-weight:600;margin-bottom:4px;font-size:13px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.attention-meta{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.attention-problem{min-width:120px;max-width:220px;color:#7c2d12;
  font-weight:600;font-size:11.5px;flex-shrink:0;text-align:right;padding-left:8px}
.meta-tag{background:#f3f4f6;border-radius:4px;padding:2px 5px;font-size:10.5px;
  color:#374151;white-space:nowrap}
.meta-tag--warn{background:#fff7ed;color:#9a3412}

/* controls */
.controls-bar{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center}
.filter-group{display:flex;gap:4px;flex-wrap:wrap}
.filter-btn{background:#f3f4f6;color:#374151;padding:5px 10px;border-radius:5px;
  font-weight:500;font-size:11.5px;border:1px solid transparent;cursor:pointer;
  transition:background .1s}
.filter-btn:hover{background:#e5e7eb}
.filter-btn.is-active{background:var(--text);color:#fff}
.search-input{min-width:180px;max-width:260px;width:100%;padding:5px 9px;
  border:1px solid var(--line);border-radius:5px;background:var(--card);
  font-size:12px;color:var(--text)}
.search-input:focus{outline:none;border-color:#93c5fd}

/* task table */
.table-wrap{overflow-x:auto}
.task-table{width:100%;border-collapse:collapse;min-width:720px;font-size:12.5px}
.task-table th{text-align:left;font-size:10px;letter-spacing:.05em;color:var(--muted);
  padding:7px 9px;border-bottom:2px solid var(--line);text-transform:uppercase;
  white-space:nowrap;font-weight:600}
.task-table td{padding:8px 9px;border-bottom:1px solid var(--line-soft);
  vertical-align:middle;color:var(--text-2)}
.task-table tbody tr:last-child td{border-bottom:none}
.task-table tbody tr:hover td{background:#f8faff}
.task-link{font-weight:600;color:var(--text);font-size:12.5px}
.task-link:hover{color:var(--blue)}
.task-code{display:inline-block;margin-left:5px;padding:1px 4px;border-radius:3px;
  background:#eef2ff;color:#3730a3;font-family:ui-monospace,monospace;
  font-size:10px;font-weight:600}
.col-task{min-width:160px}
.col-phase{color:var(--muted);font-size:11.5px;white-space:nowrap}
.due--overdue{color:var(--red);font-weight:600}
.due--soon{color:var(--orange);font-weight:600}
.problem-cell{max-width:180px;color:#7c2d12;font-size:11.5px;font-weight:500}
.muted{color:var(--muted-l);font-size:11.5px}
.owner-btn{background:none;border:none;cursor:pointer;color:var(--text-2);
  font-size:12.5px;padding:0;font-weight:500}
.owner-btn:hover{color:var(--blue);text-decoration:underline}
.done-toggle-row td{padding:6px 9px;background:#f9fafb;border-top:1px dashed var(--line)}
.done-toggle{background:none;border:none;cursor:pointer;color:var(--muted);
  font-size:11.5px;font-weight:500;padding:0}
.done-toggle:hover{color:var(--blue)}

/* badges */
.badge{display:inline-flex;align-items:center;padding:2px 6px;border-radius:4px;
  font-size:10.5px;font-weight:600;white-space:nowrap}
.badge--done{background:var(--green-l);color:var(--green)}
.badge--active{background:var(--blue-l);color:var(--blue)}
.badge--blocked{background:var(--red-l);color:var(--red)}
.badge--draft,.badge--pending{background:#f3f4f6;color:#4b5563}

/* risk */
.risk{display:inline-flex;align-items:center;padding:2px 6px;border-radius:4px;
  font-size:10.5px;font-weight:600;white-space:nowrap}
.risk--blocked{background:var(--red-l);color:var(--red)}
.risk--overdue{background:var(--orange-l);color:var(--orange)}
.risk--atrisk{background:var(--amber-l);color:var(--amber)}
.risk--active{background:var(--blue-l);color:var(--blue)}
.risk--done{background:var(--green-l);color:var(--green)}
.risk--normal{background:#f3f4f6;color:var(--muted)}

/* owner */
.owner-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}
.owner-card{padding:12px 14px;border-radius:var(--r);background:#fafbff;
  border:1px solid var(--line);text-align:left;cursor:pointer;
  transition:border-color .1s,background .1s;width:100%}
.owner-card:hover{border-color:#93c5fd;background:#eff6ff}
.owner-card--issue{border-color:#fca5a5;background:#fff8f8}
.owner-card--issue:hover{border-color:var(--red);background:#fee2e2}
.owner-name{font-weight:700;margin-bottom:3px;font-size:13px}
.owner-load{font-size:11px;color:var(--muted);margin-bottom:7px}
.owner-stats{display:flex;flex-wrap:wrap;gap:4px}
.ostat{display:inline-flex;padding:2px 6px;border-radius:4px;font-size:10.5px;font-weight:600}
.ostat--active{background:var(--blue-l);color:var(--blue)}
.ostat--blocked{background:var(--red-l);color:var(--red)}
.ostat--overdue{background:var(--orange-l);color:var(--orange)}
.ostat--risk{background:var(--amber-l);color:var(--amber)}

/* phase */
.phase-stack{display:grid;gap:8px}
.phase-card{border:1px solid var(--line);border-radius:var(--rl);padding:0 14px;background:var(--card)}
.phase-card[open]{border-color:#bfdbfe}
.phase-card summary{list-style:none;padding:12px 0;cursor:pointer;user-select:none}
.phase-card summary::-webkit-details-marker{display:none}
.phase-top{display:flex;justify-content:space-between;gap:12px;align-items:center}
.phase-left{flex:1;min-width:0}
.phase-name{font-size:14px;font-weight:700;margin-bottom:4px}
.phase-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center;font-size:12px;margin-bottom:3px}
.phase-task-summary{font-size:11.5px;color:var(--muted)}
.phase-overdue{color:var(--red);font-weight:600}
.phase-urgent{color:var(--orange);font-weight:600}
.phase-right{min-width:160px;text-align:right;flex-shrink:0}
.phase-percent{font-size:20px;font-weight:800;letter-spacing:-.02em;margin-bottom:4px}
.prog-track{height:6px;background:#e5e7eb;border-radius:999px;overflow:hidden}
.prog-fill{height:100%;border-radius:999px;transition:width .3s}
.prog-fill--done{background:var(--green)}
.prog-fill--active{background:var(--blue)}
.prog-fill--blocked{background:var(--red)}
.prog-fill--draft,.prog-fill--pending{background:#d1d5db}
.phase-body{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:4px 0 12px}
.phase-col h4{margin:0 0 6px;font-size:10.5px;font-weight:700;color:var(--muted);
  text-transform:uppercase;letter-spacing:.05em}
.phase-list{margin:0;padding-left:14px}
.phase-list li{margin:5px 0;font-size:12px;color:var(--text-2)}

/* timeline */
.timeline-wrap .tl-track{position:relative;height:60px;margin-top:6px}
.tl-line{position:absolute;top:22px;left:0;right:0;height:2px;background:var(--line);border-radius:1px}
.tl-marker{position:absolute;top:0;transform:translateX(-50%);text-align:center}
.tl-dot{width:10px;height:10px;border-radius:50%;margin:17px auto 4px;
  background:#6366f1;border:2px solid var(--card)}
.tl-phase .tl-dot{width:12px;height:12px;margin-top:16px;background:#1e1b4b}
.tl-lbl{font-size:10px;color:var(--muted);max-width:78px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;line-height:1.2}
.tl-today{position:absolute;top:0;transform:translateX(-50%)}
.tl-today-line{width:2px;height:36px;background:var(--red);margin:0 auto;opacity:.7}
.tl-today-lbl{font-size:10px;font-weight:700;text-align:center;margin-top:3px;color:var(--red)}

/* footer */
.footer{margin-top:28px;padding:16px 0 6px;border-top:1px solid var(--line);text-align:center}
.footer-brand{font-size:13px;font-weight:700;color:var(--text-2);letter-spacing:.04em;margin-bottom:3px}
.footer-tagline{font-size:11px;color:var(--muted-l);letter-spacing:.03em;margin-bottom:3px}
.footer-copy{font-size:11px;color:var(--muted-l)}

/* misc */
.empty-box{padding:11px 14px;border:1px dashed var(--line);border-radius:var(--r);
  background:#f9fafb;color:var(--muted);font-size:13px}

@media(max-width:960px){
  .phase-top{flex-direction:column;align-items:flex-start}
  .phase-right{text-align:left;min-width:auto;width:100%}
  .phase-body{grid-template-columns:1fr}
}
@media(max-width:720px){
  .wrap{padding:14px 12px 36px}
  .header{flex-direction:column;align-items:flex-start}
  .hero-primary-cards{gap:8px}
  .hpc{min-width:72px;padding:10px 12px}
  .hpc-num{font-size:26px}
  .attention-item{flex-direction:column}
  .attention-problem{max-width:none;min-width:0;text-align:left;padding-left:0}
  .search-input{min-width:0;width:100%}
  .section-hd{flex-direction:column}
  .tl-lbl{display:none}
}
@media(max-width:480px){
  .hpc--zero{display:none}
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
      <strong>Last sync</strong><br>${esc(syncTime)}<br>
      <span style="opacity:.6;font-size:10px">${esc(domain)}</span>
    </div>
  </header>

  ${renderHeroGrid(summary, allTasks)}
  ${renderAttentionZone(allTasks)}
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
