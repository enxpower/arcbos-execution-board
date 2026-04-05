// src/core/board-renderer-v3.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Operational board renderer (v3).
// Goal: make the board usable for daily team collaboration, not just display.
// Safe upgrade: static HTML + lightweight client-side filtering only.
// ─────────────────────────────────────────────────────────────────────────────

import { cfg } from '../lib/config.mjs';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
  } catch {
    return d;
  }
}

function toDateOnly(d) {
  if (!d) return null;
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  x.setHours(0, 0, 0, 0);
  return x;
}

function daysUntil(d) {
  const due = toDateOnly(d);
  if (!due) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000);
}

function statusCls(s) {
  return { done:'done', active:'active', blocked:'blocked', draft:'draft' }[(s || '').toLowerCase()] || 'pending';
}

function statusLabel(s) {
  const labels = {
    Draft: 'Draft（草案）',
    Active: 'Active（进行中）',
    Done: 'Done（已完成）',
    Blocked: 'Blocked（阻塞）',
    Pending: 'Pending（未开始）',
  };
  return labels[s] || `${s || 'Pending'}`;
}

function badge(s) {
  const cls = statusCls(s);
  return `<span class="badge badge--${cls}">${esc(statusLabel(s))}</span>`;
}

function notionUrl(pageId) {
  return `https://notion.so/${pageId.replace(/-/g, '')}`;
}

function enrichTasks(board) {
  const all = [];
  for (const ph of board) {
    for (const t of ph.tasks) {
      const dueDays = daysUntil(t.due);
      const overdue = t.status !== 'Done' && dueDays !== null && dueDays < 0;
      const dueSoon = t.status !== 'Done' && dueDays !== null && dueDays >= 0 && dueDays <= 3;
      const unassigned = !t.owner;
      let risk = 'normal';
      if (t.status === 'Blocked') risk = 'blocked';
      else if (overdue) risk = 'overdue';
      else if (dueSoon || unassigned) risk = 'atrisk';
      else if (t.status === 'Active') risk = 'active';
      else if (t.status === 'Done') risk = 'done';
      all.push({ ...t, _overdue: overdue, _dueSoon: dueSoon, _unassigned: unassigned, _dueDays: dueDays, _risk: risk, _phaseName: ph.name });
    }
  }
  return all;
}

function riskBadge(task) {
  const map = {
    blocked: ['🔴', 'Blocked（阻塞）'],
    overdue: ['🟠', 'Overdue（逾期）'],
    atrisk: ['🟡', 'At Risk（风险）'],
    active: ['🔵', 'Active（进行中）'],
    done: ['🟢', 'Done（已完成）'],
    normal: ['⚪', 'Normal（正常）'],
  };
  const [icon, label] = map[task._risk] || map.normal;
  return `<span class="risk risk--${task._risk}">${icon} ${esc(label)}</span>`;
}

function dueLabel(task) {
  if (!task.due) return '<span class="muted">—</span>';
  if (task._overdue) return `<span class="due due--overdue">${esc(fmtDate(task.due))}</span>`;
  if (task._dueSoon) return `<span class="due due--soon">${esc(fmtDate(task.due))}</span>`;
  return `<span class="due">${esc(fmtDate(task.due))}</span>`;
}

function problemText(task) {
  if (task.status === 'Blocked') return task.blockedBy || 'Blocked but no reason';
  if (task._overdue) return `已逾期 ${Math.abs(task._dueDays)} 天`;
  if (task._dueSoon) return `即将到期（${task._dueDays} 天内）`;
  if (task._unassigned) return '未指派负责人';
  return '—';
}

function safePhaseProgress(ph) {
  const pct = ph.total ? Math.round((ph.done / ph.total) * 100) : 0;
  if (ph.status === 'Done') return 100;
  if (ph.status === 'Active' && pct >= 100) return 99;
  return pct;
}

function summaryCards(summary, allTasks) {
  const overdue = allTasks.filter(t => t._overdue).length;
  const atrisk = allTasks.filter(t => t._risk === 'atrisk').length;
  return `
<section class="hero-grid">
  <div class="hero-card hero-card--blocked"><div class="hero-num">${summary.totalBlocked}</div><div class="hero-lbl">Blocked<br><span>阻塞任务</span></div></div>
  <div class="hero-card hero-card--overdue"><div class="hero-num">${overdue}</div><div class="hero-lbl">Overdue<br><span>逾期任务</span></div></div>
  <div class="hero-card hero-card--risk"><div class="hero-num">${atrisk}</div><div class="hero-lbl">At Risk<br><span>风险任务</span></div></div>
  <div class="hero-card hero-card--active"><div class="hero-num">${summary.totalActive}</div><div class="hero-lbl">Active<br><span>进行中</span></div></div>
  <div class="hero-card hero-card--done"><div class="hero-num">${summary.totalDone}</div><div class="hero-lbl">Done<br><span>已完成</span></div></div>
  <div class="hero-card hero-card--total"><div class="hero-num">${summary.totalTasks}</div><div class="hero-lbl">Total<br><span>总任务</span></div></div>
</section>`;
}

function renderAttentionZone(allTasks) {
  const items = allTasks
    .filter(t => t._risk === 'blocked' || t._risk === 'overdue' || t._risk === 'atrisk')
    .sort((a, b) => {
      const order = { blocked: 0, overdue: 1, atrisk: 2, active: 3, done: 4, normal: 5 };
      return order[a._risk] - order[b._risk] || (a._dueDays ?? 999) - (b._dueDays ?? 999);
    });

  const content = items.length
    ? items.map(t => `
      <a class="attention-item attention-item--${t._risk}" href="${esc(notionUrl(t.id))}" target="_blank" rel="noopener">
        <div class="attention-main">
          <div class="attention-title">${esc(t.name)} ${t.taskCode ? `<span class="task-code">${esc(t.taskCode)}</span>` : ''}</div>
          <div class="attention-meta">${badge(t.status)} ${riskBadge(t)} ${t.owner ? `<span class="meta-tag">👤 ${esc(t.owner)}</span>` : '<span class="meta-tag meta-tag--warn">👤 未指派</span>'} <span class="meta-tag">📁 ${esc(t._phaseName)}</span> ${t.due ? `<span class="meta-tag">📅 ${esc(fmtDate(t.due))}</span>` : ''}</div>
        </div>
        <div class="attention-problem">${esc(problemText(t))}</div>
      </a>`).join('')
    : `<div class="empty-box">✅ 当前没有阻塞、逾期或高风险任务</div>`;

  return `
<section class="section section--attention">
  <div class="section-hd"><div><h2>🚨 Needs Attention</h2><p>先看问题，再看进度。团队先处理阻塞、逾期、风险项。</p></div><div class="section-count">${items.length}</div></div>
  <div class="attention-list">${content}</div>
</section>`;
}

function renderControls() {
  return `
<section class="section controls-section">
  <div class="section-hd compact"><div><h2>📋 Action Board</h2><p>点击筛选，团队快速定位“谁该做什么、哪里有问题”。</p></div></div>
  <div class="controls-bar">
    <div class="filter-group">
      <button class="filter-btn is-active" data-filter="all">全部 All</button>
      <button class="filter-btn" data-filter="attention">需关注</button>
      <button class="filter-btn" data-filter="active">进行中</button>
      <button class="filter-btn" data-filter="blocked">阻塞</button>
      <button class="filter-btn" data-filter="overdue">逾期</button>
      <button class="filter-btn" data-filter="atrisk">风险</button>
      <button class="filter-btn" data-filter="done">已完成</button>
    </div>
    <input id="taskSearch" class="search-input" type="search" placeholder="搜索任务 / TaskCode / Owner / Phase">
  </div>
</section>`;
}

function renderTaskList(allTasks) {
  const sorted = [...allTasks].sort((a, b) => {
    const order = { blocked: 0, overdue: 1, atrisk: 2, active: 3, normal: 4, done: 5 };
    return order[a._risk] - order[b._risk] || (a._dueDays ?? 999) - (b._dueDays ?? 999) || a.name.localeCompare(b.name);
  });

  const rows = sorted.map(t => `
<tr class="task-row" data-status="${esc((t.status || '').toLowerCase())}" data-risk="${esc(t._risk)}" data-owner="${esc((t.owner || '未指派').toLowerCase())}" data-search="${esc(`${t.name} ${t.taskCode || ''} ${t.owner || ''} ${t._phaseName || ''}`.toLowerCase())}">
  <td class="col-task"><a href="${esc(notionUrl(t.id))}" target="_blank" rel="noopener">${esc(t.name)}</a>${t.taskCode ? `<span class="task-code">${esc(t.taskCode)}</span>` : ''}</td>
  <td>${badge(t.status)}</td>
  <td><button class="owner-link" data-owner-filter="${esc((t.owner || '未指派').toLowerCase())}">${esc(t.owner || '未指派')}</button></td>
  <td>${esc(t._phaseName)}</td>
  <td>${dueLabel(t)}</td>
  <td>${riskBadge(t)}</td>
  <td class="problem-cell">${esc(problemText(t))}</td>
</tr>`).join('');

  return `
<section class="section">
  <div class="section-hd"><div><h2>🧩 Task List</h2><p>任务是主视图。默认把问题任务排在最前面。</p></div><div class="section-count" id="taskCount">${sorted.length}</div></div>
  <div class="table-wrap">
    <table class="task-table">
      <thead><tr><th>任务</th><th>状态</th><th>负责人</th><th>阶段</th><th>截止</th><th>风险</th><th>问题说明</th></tr></thead>
      <tbody id="taskTableBody">${rows}</tbody>
    </table>
  </div>
</section>`;
}

function renderOwnerView(allTasks) {
  const activeSet = allTasks.filter(t => t.status !== 'Draft' && t.status !== 'Done');
  const map = new Map();
  for (const t of activeSet) {
    const owner = t.owner || '未指派';
    if (!map.has(owner)) map.set(owner, { active: 0, blocked: 0, overdue: 0, atrisk: 0 });
    const v = map.get(owner);
    if (t.status === 'Blocked') v.blocked += 1;
    else if (t._overdue) v.overdue += 1;
    else if (t._risk === 'atrisk') v.atrisk += 1;
    else v.active += 1;
  }
  const cards = [...map.entries()].sort((a, b) => (b[1].blocked + b[1].overdue + b[1].atrisk) - (a[1].blocked + a[1].overdue + a[1].atrisk)).map(([owner, v]) => `
<button class="owner-card" data-owner-filter="${esc(owner.toLowerCase())}">
  <div class="owner-name">👤 ${esc(owner)}</div>
  <div class="owner-stats">
    <span class="ostat ostat--active">${v.active} 进行中</span>
    <span class="ostat ostat--blocked">${v.blocked} 阻塞</span>
    <span class="ostat ostat--overdue">${v.overdue} 逾期</span>
    <span class="ostat ostat--risk">${v.atrisk} 风险</span>
  </div>
</button>`).join('');

  return `
<section class="section">
  <div class="section-hd"><div><h2>👤 By Owner</h2><p>按负责人看工作负荷与异常，点击卡片直接筛选任务。</p></div></div>
  <div class="owner-grid">${cards || '<div class="empty-box">当前没有进行中任务</div>'}</div>
</section>`;
}

function renderPhaseSection(board) {
  const items = board.map(ph => {
    const pct = safePhaseProgress(ph);
    const dateRange = [fmtDate(ph.startDate), fmtDate(ph.due)].filter(Boolean).join(' — ');
    const taskRows = ph.tasks.length ? ph.tasks.map(t => `<li>${badge(t.status)} <a href="${esc(notionUrl(t.id))}" target="_blank" rel="noopener">${esc(t.name)}</a></li>`).join('') : '<li class="muted">暂无任务</li>';
    const msRows = ph.milestones.length ? ph.milestones.map(m => `<li>${badge(m.status)} ${esc(m.name)} ${m.due ? `<span class="muted">${esc(fmtDate(m.due))}</span>` : ''}</li>`).join('') : '<li class="muted">暂无里程碑</li>';
    return `
<details class="phase-card" ${ph.active || ph.blocked ? 'open' : ''}>
  <summary>
    <div class="phase-top">
      <div>
        <div class="phase-name">${esc(ph.name)}</div>
        <div class="phase-meta">${badge(ph.status)} ${dateRange ? `<span>${esc(dateRange)}</span>` : ''}</div>
      </div>
      <div class="phase-stats">
        <div class="phase-percent">${pct}%</div>
        <div class="prog-track"><div class="prog-fill prog-fill--${statusCls(ph.status)}" style="width:${pct}%"></div></div>
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
  <div class="section-hd"><div><h2>🗂 Phase View</h2><p>阶段视图降级为参考视图，用来复盘，不作为第一工作入口。</p></div></div>
  <div class="phase-stack">${items}</div>
</section>`;
}

function renderTimeline(board) {
  const items = [];
  for (const ph of board) {
    if (ph.due) items.push({ name: ph.name, date: ph.due, type: 'phase' });
    for (const m of ph.milestones) if (m.due) items.push({ name: m.name, date: m.due, type: 'ms', status: m.status });
  }
  if (!items.length) return '';
  items.sort((a, b) => a.date.localeCompare(b.date));
  const first = new Date(items[0].date);
  const last = new Date(items[items.length - 1].date);
  const today = new Date();
  const span = Math.max(1, last - first);
  const pct = d => Math.min(97, Math.max(3, ((new Date(d) - first) / span) * 94 + 3));
  const todayPct = Math.min(97, Math.max(3, ((today - first) / span) * 94 + 3));
  const markers = items.map(it => `<div class="tl-marker tl-${it.type}" style="left:${pct(it.date)}%"><div class="tl-dot"></div><div class="tl-lbl">${esc(it.name.length > 14 ? it.name.slice(0, 12) + '…' : it.name)}</div></div>`).join('');
  return `
<section class="section timeline-wrap">
  <div class="section-hd compact"><div><h2>🕒 Timeline</h2><p>时间轴仅作辅助查看，不作为主工作入口。</p></div></div>
  <div class="tl-track"><div class="tl-line"></div>${markers}<div class="tl-today" style="left:${todayPct}%"><div class="tl-today-line"></div><div class="tl-today-lbl">Today</div></div></div>
</section>`;
}

function renderScript() {
  return `
<script>
(() => {
  const buttons = Array.from(document.querySelectorAll('.filter-btn'));
  const ownerButtons = Array.from(document.querySelectorAll('[data-owner-filter]'));
  const rows = Array.from(document.querySelectorAll('.task-row'));
  const search = document.getElementById('taskSearch');
  const count = document.getElementById('taskCount');
  let activeFilter = 'all';
  let ownerFilter = '';

  function matchesFilter(row) {
    if (ownerFilter && row.dataset.owner !== ownerFilter) return false;
    if (activeFilter === 'all') return true;
    if (activeFilter === 'attention') return ['blocked','overdue','atrisk'].includes(row.dataset.risk);
    if (activeFilter === 'active') return row.dataset.status === 'active';
    if (activeFilter === 'done') return row.dataset.status === 'done';
    return row.dataset.risk === activeFilter;
  }

  function apply() {
    const q = (search.value || '').trim().toLowerCase();
    let visible = 0;
    rows.forEach(row => {
      const okFilter = matchesFilter(row);
      const okSearch = !q || row.dataset.search.includes(q);
      const show = okFilter && okSearch;
      row.style.display = show ? '' : 'none';
      if (show) visible += 1;
    });
    count.textContent = visible;
  }

  buttons.forEach(btn => btn.addEventListener('click', () => {
    buttons.forEach(x => x.classList.remove('is-active'));
    btn.classList.add('is-active');
    activeFilter = btn.dataset.filter;
    if (activeFilter !== 'all') ownerFilter = '';
    apply();
  }));

  ownerButtons.forEach(btn => btn.addEventListener('click', () => {
    ownerFilter = btn.dataset.ownerFilter || '';
    buttons.forEach(x => x.classList.remove('is-active'));
    activeFilter = 'all';
    const allBtn = buttons.find(x => x.dataset.filter === 'all');
    if (allBtn) allBtn.classList.add('is-active');
    apply();
    document.querySelector('.task-table')?.scrollIntoView({behavior:'smooth', block:'start'});
  }));

  search?.addEventListener('input', apply);
  apply();
})();
</script>`;
}

export function renderBoard({ board, allBlocked, summary, lastSync }) {
  const title = cfg.boardTitle;
  const allTasks = enrichTasks(board);
  const syncTime = new Date(lastSync).toLocaleString('zh-CN', {
    weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });

  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex,nofollow">
<style>
:root{--bg:#f6f7fb;--card:#fff;--line:#e8ebf2;--text:#172033;--muted:#6b7280;--blue:#2563eb;--green:#16a34a;--red:#dc2626;--orange:#f97316;--amber:#d97706;--shadow:0 10px 30px rgba(16,24,40,.06)}
*{box-sizing:border-box}html{font-size:15px}body{margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
a{color:inherit;text-decoration:none}.wrap{max-width:1280px;margin:0 auto;padding:28px 18px 56px}
.header{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;margin-bottom:20px}.title h1{margin:0 0 6px;font-size:30px;line-height:1.1}.title p{margin:0;color:var(--muted)}.sync{color:var(--muted);font-size:13px;text-align:right}
.hero-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:18px}.hero-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:var(--shadow)}.hero-num{font-size:30px;font-weight:800;line-height:1}.hero-lbl{margin-top:8px;font-size:13px;color:var(--muted)}.hero-lbl span{color:var(--text)}.hero-card--blocked .hero-num{color:var(--red)}.hero-card--overdue .hero-num{color:var(--orange)}.hero-card--risk .hero-num{color:var(--amber)}.hero-card--active .hero-num{color:var(--blue)}.hero-card--done .hero-num{color:var(--green)}
.section{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;margin-bottom:16px;box-shadow:var(--shadow)}.section-hd{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:14px}.section-hd.compact{margin-bottom:10px}.section-hd h2{margin:0 0 4px;font-size:20px}.section-hd p{margin:0;color:var(--muted);font-size:13px}.section-count{min-width:48px;height:48px;border-radius:12px;background:#eef2ff;color:var(--blue);display:flex;align-items:center;justify-content:center;font-weight:800}
.attention-list{display:grid;gap:12px}.attention-item{display:flex;justify-content:space-between;gap:14px;border:1px solid var(--line);border-left-width:4px;border-radius:14px;padding:14px;background:#fcfcfe}.attention-item--blocked{border-left-color:var(--red)}.attention-item--overdue{border-left-color:var(--orange)}.attention-item--atrisk{border-left-color:var(--amber)}.attention-title{font-weight:700;margin-bottom:8px}.attention-meta{display:flex;flex-wrap:wrap;gap:8px}.attention-problem{min-width:210px;max-width:320px;color:#7c2d12;font-weight:600;font-size:13px}.meta-tag{background:#f3f4f6;border-radius:999px;padding:4px 8px;font-size:12px;color:#374151}.meta-tag--warn{background:#fff7ed;color:#9a3412}
.controls-bar{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.filter-group{display:flex;gap:8px;flex-wrap:wrap}.filter-btn,.owner-card,.owner-link{cursor:pointer;border:none}.filter-btn{background:#f3f4f6;color:#374151;padding:9px 12px;border-radius:999px;font-weight:700}.filter-btn.is-active{background:#111827;color:#fff}.search-input{min-width:260px;max-width:340px;width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:12px;background:#fff}
.table-wrap{overflow:auto}.task-table{width:100%;border-collapse:collapse;min-width:980px}.task-table th{text-align:left;font-size:12px;letter-spacing:.03em;color:var(--muted);padding:11px 10px;border-bottom:1px solid var(--line);text-transform:uppercase}.task-table td{padding:13px 10px;border-bottom:1px solid var(--line);vertical-align:top}.task-table tbody tr:hover{background:#fafbff}.col-task a{font-weight:700}.task-code{display:inline-block;margin-left:8px;padding:2px 7px;border-radius:999px;background:#eef2ff;color:#3730a3;font-family:ui-monospace,monospace;font-size:12px}.problem-cell{max-width:240px;color:#7c2d12;font-weight:600;font-size:13px}
.badge,.risk{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:999px;font-size:12px;font-weight:700}.badge--done{background:#dcfce7;color:#166534}.badge--active{background:#dbeafe;color:#1d4ed8}.badge--blocked{background:#fee2e2;color:#991b1b}.badge--draft,.badge--pending{background:#f3f4f6;color:#4b5563}.risk--blocked{background:#fee2e2;color:#991b1b}.risk--overdue{background:#ffedd5;color:#9a3412}.risk--atrisk{background:#fef3c7;color:#92400e}.risk--active{background:#dbeafe;color:#1d4ed8}.risk--done{background:#dcfce7;color:#166534}.risk--normal{background:#f3f4f6;color:#4b5563}
.due--overdue{color:var(--red);font-weight:800}.due--soon{color:var(--orange);font-weight:800}.muted{color:var(--muted)}
.owner-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.owner-card{padding:16px;border-radius:16px;background:#fafbff;border:1px solid var(--line);text-align:left}.owner-card:hover{border-color:#c7d2fe;background:#eef2ff}.owner-name{font-weight:800;margin-bottom:10px}.owner-stats{display:flex;flex-wrap:wrap;gap:8px}.ostat{display:inline-flex;padding:4px 9px;border-radius:999px;font-size:12px;font-weight:700}.ostat--active{background:#dbeafe;color:#1d4ed8}.ostat--blocked{background:#fee2e2;color:#991b1b}.ostat--overdue{background:#ffedd5;color:#9a3412}.ostat--risk{background:#fef3c7;color:#92400e}.owner-link{background:none;padding:0;color:#1d4ed8;font-weight:700}
.phase-stack{display:grid;gap:12px}.phase-card{border:1px solid var(--line);border-radius:16px;padding:0 14px;background:#fcfcfe}.phase-card summary{list-style:none;padding:16px 0;cursor:pointer}.phase-card summary::-webkit-details-marker{display:none}.phase-top{display:flex;justify-content:space-between;gap:16px;align-items:center}.phase-name{font-size:18px;font-weight:800;margin-bottom:6px}.phase-meta{display:flex;flex-wrap:wrap;gap:8px;color:var(--muted);font-size:13px}.phase-stats{min-width:260px}.phase-percent{text-align:right;font-size:22px;font-weight:800}.prog-track{margin-top:8px;height:10px;background:#edf2f7;border-radius:999px;overflow:hidden}.prog-fill{height:100%}.prog-fill--done{background:linear-gradient(90deg,#34d399,#10b981)}.prog-fill--active{background:linear-gradient(90deg,#60a5fa,#2563eb)}.prog-fill--blocked{background:linear-gradient(90deg,#fca5a5,#dc2626)}.prog-fill--draft,.prog-fill--pending{background:#cbd5e1}.phase-counts{margin-top:8px;text-align:right;color:var(--muted);font-size:12px}.phase-body{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:0 0 16px}.phase-list{margin:0;padding-left:18px}.phase-list li{margin:8px 0}.phase-col h4{margin:0 0 8px}
.timeline-wrap .tl-track{position:relative;height:72px}.tl-line{position:absolute;top:30px;left:0;right:0;height:3px;background:#e5e7eb;border-radius:999px}.tl-marker{position:absolute;top:0;transform:translateX(-50%);text-align:center}.tl-dot{width:12px;height:12px;border-radius:50%;margin:24px auto 6px;background:#4f46e5}.tl-lbl{max-width:90px;font-size:12px;color:var(--muted)}.tl-today{position:absolute;top:0;transform:translateX(-50%)}.tl-today-line{width:2px;height:48px;background:#111827;margin:0 auto}.tl-today-lbl{font-size:12px;font-weight:800;margin-top:6px}
.empty-box{padding:14px 16px;border:1px dashed var(--line);border-radius:14px;background:#fafbff;color:var(--muted)}
@media (max-width:1080px){.hero-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.phase-top{flex-direction:column;align-items:flex-start}.phase-stats{min-width:auto;width:100%}.phase-counts,.phase-percent{text-align:left}.phase-body{grid-template-columns:1fr}}
@media (max-width:720px){.wrap{padding:18px 14px 44px}.header{flex-direction:column;align-items:flex-start}.hero-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.attention-item{flex-direction:column}.attention-problem{max-width:none;min-width:0}.search-input{min-width:0}.section-hd{flex-direction:column}.section-count{width:48px}.filter-group{width:100%}}
</style>
<div class="wrap">
  <header class="header">
    <div class="title">
      <h1>${esc(title)}</h1>
      <p>Operational Board · 先看问题，再看任务，再看阶段。团队打开页面就知道“谁该做什么”。</p>
    </div>
    <div class="sync">Last sync · ${esc(syncTime)}<br>${esc(cfg.boardDomain)}</div>
  </header>
  ${summaryCards(summary, allTasks)}
  ${renderAttentionZone(allTasks)}
  ${renderControls()}
  ${renderTaskList(allTasks)}
  ${renderOwnerView(allTasks)}
  ${renderPhaseSection(board)}
  ${renderTimeline(board)}
</div>
${renderScript()}
</html>`;
}
