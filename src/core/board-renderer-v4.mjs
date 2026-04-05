// src/core/board-renderer-v4.mjs
// Operational HTML renderer v4.
// Focus: issue-first dashboard, actionable task list, owner view, safer phase/timeline UX.

import { cfg } from '../lib/config.mjs';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).replace(/\//g, '/');
  } catch {
    return String(d);
  }
}

function parseDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysUntil(d) {
  const dt = parseDate(d);
  if (!dt) return null;
  const t = todayStart();
  dt.setHours(0, 0, 0, 0);
  return Math.round((dt - t) / 86400000);
}

function statusKey(s) {
  return String(s || 'Pending').trim().toLowerCase();
}

function statusZh(s) {
  const map = {
    done: '已完成',
    active: '进行中',
    blocked: '阻塞',
    pending: '未开始',
    draft: '待审批',
  };
  return map[statusKey(s)] || String(s || '未开始');
}

function riskInfo(task) {
  const status = statusKey(task.status);
  const dd = daysUntil(task.due);
  if (status === 'blocked') {
    return { key: 'blocked', label: 'Blocked 阻塞', zh: '阻塞', emoji: '🔴' };
  }
  if (status !== 'done' && dd !== null && dd < 0) {
    return { key: 'overdue', label: 'Overdue 逾期', zh: '逾期', emoji: '🟠' };
  }
  if (status === 'active' && dd !== null && dd <= 3) {
    return { key: 'atrisk', label: 'At Risk 风险', zh: '风险', emoji: '🟡' };
  }
  if (status === 'done') {
    return { key: 'done', label: 'Done 已完成', zh: '已完成', emoji: '🟢' };
  }
  return { key: status || 'pending', label: `${task.status || 'Pending'} ${statusZh(task.status)}`, zh: statusZh(task.status), emoji: '🟢' };
}

function taskUrl(task) {
  return task.url || task.notionUrl || task.href || '';
}

function badge(status) {
  const k = statusKey(status);
  return `<span class="badge badge--${k}">${esc(status || 'Pending')}（${esc(statusZh(status))}）</span>`;
}

function riskBadge(task) {
  const r = riskInfo(task);
  return `<span class="risk risk--${r.key}">${esc(r.label)}</span>`;
}

function linkTaskName(task) {
  const name = esc(task.name || 'Untitled');
  const code = task.taskCode ? `<span class="task-code">${esc(task.taskCode)}</span>` : '';
  const label = `${name}${code}`;
  const url = taskUrl(task);
  return url
    ? `<a class="task-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : `<span class="task-link task-link--plain">${label}</span>`;
}

function flattenBoard(board) {
  const tasks = [];
  for (const ph of board || []) {
    const phaseName = ph.name || '';
    for (const t of (ph.tasks || [])) {
      tasks.push({
        ...t,
        phase: t.phase || phaseName,
        _risk: riskInfo(t),
      });
    }
  }
  return tasks;
}

function compareTasks(a, b) {
  const rank = { blocked: 0, overdue: 1, atrisk: 2, active: 3, pending: 4, draft: 5, done: 6 };
  const ra = rank[a._risk.key] ?? 99;
  const rb = rank[b._risk.key] ?? 99;
  if (ra !== rb) return ra - rb;
  const ddA = daysUntil(a.due);
  const ddB = daysUntil(b.due);
  if (ddA !== ddB) {
    if (ddA === null) return 1;
    if (ddB === null) return -1;
    return ddA - ddB;
  }
  return String(a.name || '').localeCompare(String(b.name || ''));
}

function buildOwnerStats(tasks) {
  const map = new Map();
  for (const t of tasks) {
    const owner = (t.owner || 'Unassigned').trim() || 'Unassigned';
    if (!map.has(owner)) map.set(owner, { owner, active: 0, blocked: 0, overdue: 0, atrisk: 0, total: 0 });
    const row = map.get(owner);
    row.total += 1;
    const s = statusKey(t.status);
    if (s === 'active') row.active += 1;
    if (t._risk.key === 'blocked') row.blocked += 1;
    if (t._risk.key === 'overdue') row.overdue += 1;
    if (t._risk.key === 'atrisk') row.atrisk += 1;
  }
  return [...map.values()].sort((a, b) =>
    (b.blocked - a.blocked) || (b.overdue - a.overdue) || (b.atrisk - a.atrisk) || (b.active - a.active) || a.owner.localeCompare(b.owner)
  );
}

function phaseProgress(phase) {
  const total = phase.total || 0;
  const done = phase.done || 0;
  const status = statusKey(phase.status);
  const base = total > 0 ? Math.round((done / total) * 100) : 0;
  if (status === 'done') return 100;
  if (status === 'active') return Math.min(base || 0, 99);
  return base;
}

function summaryCards(summary, tasks) {
  const counts = {
    blocked: tasks.filter(t => t._risk.key === 'blocked').length,
    overdue: tasks.filter(t => t._risk.key === 'overdue').length,
    atrisk: tasks.filter(t => t._risk.key === 'atrisk').length,
    active: summary?.totalActive ?? tasks.filter(t => statusKey(t.status) === 'active').length,
    done: summary?.totalDone ?? tasks.filter(t => statusKey(t.status) === 'done').length,
    total: summary?.totalTasks ?? tasks.length,
  };
  return `
<section class="top-metrics">
  ${metricCard('Blocked', '阻塞任务', counts.blocked, 'blocked')}
  ${metricCard('Overdue', '逾期任务', counts.overdue, 'overdue')}
  ${metricCard('At Risk', '风险任务', counts.atrisk, 'atrisk')}
  ${metricCard('Active', '进行中', counts.active, 'active')}
  ${metricCard('Done', '已完成', counts.done, 'done')}
  ${metricCard('Total', '总任务', counts.total, 'total')}
</section>`;
}

function metricCard(en, zh, num, cls) {
  return `<div class="metric metric--${cls}">
    <div class="metric-num">${num}</div>
    <div class="metric-en">${esc(en)}</div>
    <div class="metric-zh">${esc(zh)}</div>
  </div>`;
}

function renderAttentionZone(tasks) {
  const hot = tasks.filter(t => ['blocked', 'overdue', 'atrisk'].includes(t._risk.key)).sort(compareTasks);
  const body = hot.length
    ? hot.map(t => `<a class="attention-item attention-item--${t._risk.key}" href="${esc(taskUrl(t) || '#')}" ${taskUrl(t) ? 'target="_blank" rel="noopener noreferrer"' : ''}>
        <div class="att-left">
          <div class="att-title">${esc(t._risk.emoji)} ${esc(t.name)}</div>
          <div class="att-meta">${t.taskCode ? esc(t.taskCode) + ' · ' : ''}${esc(t.owner || 'Unassigned')} · ${esc(t.phase || '—')} · 截止 ${esc(fmtDate(t.due))}</div>
        </div>
        <div class="att-right">
          <span class="risk-pill risk-pill--${t._risk.key}">${esc(t._risk.zh)}</span>
          <span class="att-reason">${esc(t.blockedBy || (t._risk.key === 'overdue' ? '已逾期' : '临近截止'))}</span>
        </div>
      </a>`).join('')
    : `<div class="empty-state">✅ 当前没有阻塞、逾期或高风险任务</div>`;

  return `<section class="panel">
    <div class="section-hd">
      <div>
        <h2>🚨 Needs Attention</h2>
        <p>先看问题，再看进度。团队优先处理阻塞、逾期、风险项。</p>
      </div>
      <div class="section-count">${hot.length}</div>
    </div>
    <div class="attention-list">${body}</div>
  </section>`;
}

function renderActionBoard() {
  return `<section class="panel">
    <div class="section-hd compact">
      <div>
        <h2>📋 Action Board</h2>
        <p>点击筛选，团队快速定位“谁该做什么、哪里有问题”。</p>
      </div>
    </div>
    <div class="toolbar">
      <div class="filters">
        <button class="filter-btn is-active" data-filter="all">全部 All</button>
        <button class="filter-btn" data-filter="attention">需关注</button>
        <button class="filter-btn" data-filter="active">进行中</button>
        <button class="filter-btn" data-filter="blocked">阻塞</button>
        <button class="filter-btn" data-filter="overdue">逾期</button>
        <button class="filter-btn" data-filter="atrisk">风险</button>
        <button class="filter-btn" data-filter="done">已完成</button>
      </div>
      <div class="search-wrap">
        <input id="task-search" class="task-search" type="search" placeholder="搜索任务 / TaskCode / Owner / Phase">
      </div>
    </div>
  </section>`;
}

function renderTaskList(tasks) {
  const rows = tasks.sort(compareTasks).map(t => {
    const issue = t.blockedBy ? esc(t.blockedBy) : '—';
    return `<tr data-filter="${esc(filterTokens(t).join(' '))}">
      <td class="col-task">${linkTaskName(t)}</td>
      <td>${badge(t.status)}</td>
      <td><button class="owner-link" data-owner="${esc(t.owner || 'Unassigned')}">${esc(t.owner || 'Unassigned')}</button></td>
      <td>${esc(t.phase || '—')}</td>
      <td>${esc(fmtDate(t.due))}</td>
      <td>${riskBadge(t)}</td>
      <td class="issue">${issue}</td>
    </tr>`;
  }).join('');

  return `<section class="panel">
    <div class="section-hd">
      <div>
        <h2>🧩 Task List</h2>
        <p>任务是主视图。默认把问题任务排在最前面。</p>
      </div>
      <div class="section-count">${tasks.length}</div>
    </div>
    <div class="table-wrap">
      <table class="task-table">
        <thead>
          <tr>
            <th>任务</th><th>状态</th><th>负责人</th><th>阶段</th><th>截止</th><th>风险</th><th>问题说明</th>
          </tr>
        </thead>
        <tbody id="task-table-body">${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function filterTokens(t) {
  const s = statusKey(t.status);
  const tokens = ['all', s, t._risk.key];
  if (['blocked', 'overdue', 'atrisk'].includes(t._risk.key)) tokens.push('attention');
  if (s === 'done') tokens.push('done');
  return [...new Set(tokens)];
}

function renderOwnerView(tasks) {
  const owners = buildOwnerStats(tasks.filter(t => statusKey(t.status) !== 'done' || ['blocked', 'overdue', 'atrisk'].includes(t._risk.key)));
  const body = owners.length
    ? owners.map(o => `<button class="owner-card" data-owner="${esc(o.owner)}">
        <div class="owner-name">${esc(o.owner)}</div>
        <div class="owner-stats">
          <span>${o.active} 进行中</span>
          <span>${o.blocked} 阻塞</span>
          <span>${o.overdue} 逾期</span>
          <span>${o.atrisk} 风险</span>
        </div>
      </button>`).join('')
    : `<div class="empty-state">当前没有进行中任务</div>`;
  return `<section class="panel">
    <div class="section-hd compact">
      <div>
        <h2>👤 By Owner</h2>
        <p>按负责人看工作负荷与异常，点击卡片直接筛选任务。</p>
      </div>
    </div>
    <div class="owner-grid">${body}</div>
  </section>`;
}

function renderPhaseView(board) {
  const phases = (board || []).map(ph => {
    const pct = phaseProgress(ph);
    return `<div class="phase-card">
      <div class="phase-main">
        <div class="phase-title">${esc(ph.name)}</div>
        <div class="phase-meta">${badge(ph.status)} <span>${esc(fmtDate(ph.startDate))} — ${esc(fmtDate(ph.due))}</span></div>
      </div>
      <div class="phase-prog">
        <div class="phase-pct">${pct}%</div>
        <div class="prog-track"><div class="prog-fill prog-fill--${statusKey(ph.status)}" style="width:${pct}%"></div></div>
        <div class="phase-mini">${ph.done || 0}/${ph.total || 0} 完成 · ${ph.blocked || 0} 阻塞 · ${ph.active || 0} 进行中</div>
      </div>
    </div>`;
  }).join('');
  return `<section class="panel">
    <div class="section-hd compact">
      <div>
        <h2>📁 Phase View</h2>
        <p>阶段视图降级为参考视图，用来复盘，不作为第一工作入口。</p>
      </div>
    </div>
    <div class="phase-stack">${phases || '<div class="empty-state">暂无阶段</div>'}</div>
  </section>`;
}

function renderTimeline(board) {
  const items = [];
  for (const ph of board || []) {
    if (ph.due) items.push({ name: ph.name, date: ph.due, kind: 'phase' });
    for (const m of (ph.milestones || [])) {
      if (m.due) items.push({ name: m.name, date: m.due, kind: 'ms' });
    }
  }
  if (!items.length) return '';
  items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const first = parseDate(items[0].date);
  const last = parseDate(items[items.length - 1].date);
  if (!first || !last) return '';
  const span = Math.max(1, last - first);

  const pos = (d) => {
    const raw = ((parseDate(d) - first) / span) * 88 + 6;
    return Math.min(94, Math.max(6, raw));
  };

  const markers = items.map((it, idx) => {
    const p = pos(it.date);
    const edgeClass = p < 16 ? 'edge-left' : p > 84 ? 'edge-right' : '';
    const label = it.name.length > 18 ? it.name.slice(0, 16) + '…' : it.name;
    return `<div class="tl-marker ${edgeClass}" style="left:${p}%">
      <div class="tl-dot ${it.kind === 'phase' ? 'tl-phase' : 'tl-ms'}"></div>
      <div class="tl-label">${esc(label)}</div>
    </div>`;
  }).join('');

  const today = pos(new Date().toISOString());
  return `<section class="panel">
    <div class="section-hd compact">
      <div>
        <h2>🕒 Timeline</h2>
        <p>时间轴仅作辅助查看，不作为主工作入口。</p>
      </div>
    </div>
    <div class="timeline">
      <div class="timeline-line"></div>
      <div class="timeline-today" style="left:${today}%">
        <div class="timeline-today-line"></div>
        <div class="timeline-today-label">Today</div>
      </div>
      ${markers}
    </div>
  </section>`;
}

function buildPageScript() {
  return `<script>
(() => {
  const body = document.getElementById('task-table-body');
  const search = document.getElementById('task-search');
  const filterButtons = [...document.querySelectorAll('.filter-btn')];
  let activeFilter = 'all';
  let ownerFilter = '';

  function applyFilters() {
    const query = (search?.value || '').trim().toLowerCase();
    [...body.querySelectorAll('tr')].forEach(tr => {
      const bucket = tr.dataset.filter || '';
      const owner = tr.querySelector('.owner-link')?.dataset.owner || '';
      const text = tr.innerText.toLowerCase();
      const okFilter = activeFilter === 'all' || bucket.includes(activeFilter);
      const okOwner = !ownerFilter || owner === ownerFilter;
      const okQuery = !query || text.includes(query);
      tr.style.display = okFilter && okOwner && okQuery ? '' : 'none';
    });
    document.querySelectorAll('.owner-card').forEach(card => {
      card.classList.toggle('is-active', ownerFilter && card.dataset.owner === ownerFilter);
    });
  }

  filterButtons.forEach(btn => btn.addEventListener('click', () => {
    filterButtons.forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    activeFilter = btn.dataset.filter || 'all';
    applyFilters();
  }));

  document.querySelectorAll('.owner-card').forEach(card => {
    card.addEventListener('click', () => {
      ownerFilter = ownerFilter === card.dataset.owner ? '' : card.dataset.owner;
      applyFilters();
    });
  });

  document.querySelectorAll('.owner-link').forEach(btn => {
    btn.addEventListener('click', () => {
      ownerFilter = btn.dataset.owner || '';
      applyFilters();
      document.getElementById('task-table-body')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  search?.addEventListener('input', applyFilters);
  applyFilters();
})();
</script>`;
}

export function renderBoard({ board, allBlocked, summary, lastSync }) {
  const tasks = flattenBoard(board);
  tasks.sort(compareTasks);

  const title = cfg.boardTitle || 'ARCBOS Board';
  const domain = cfg.boardDomain || '';
  const syncText = (() => {
    try {
      return new Date(lastSync).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).replace(',', '');
    } catch {
      return String(lastSync || '');
    }
  })();

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex,nofollow">
<style>
:root{
  --bg:#f3f5fb;--panel:#ffffff;--line:#e7ebf4;--text:#13203a;--muted:#6e7b96;
  --navy:#14213d;--blue:#3878ff;--green:#16a34a;--green-bg:#dcfce7;
  --amber:#d97706;--amber-bg:#fef3c7;--red:#dc2626;--red-bg:#fee2e2;
  --orange:#ea580c;--orange-bg:#ffedd5;--shadow:0 10px 30px rgba(20,33,61,.06);
}
*{box-sizing:border-box} html,body{margin:0;padding:0}
body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:var(--bg);color:var(--text)}
.wrap{max-width:1480px;margin:0 auto;padding:28px 20px 56px}
.header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}
h1{margin:0;font-size:26px;line-height:1.2}
.sub{margin-top:6px;color:var(--muted);font-size:14px}
.sync{text-align:right;color:var(--muted);font-size:13px;line-height:1.5}
.top-metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:14px;margin:16px 0 20px}
.metric{background:var(--panel);border-radius:18px;padding:18px 18px 16px;box-shadow:var(--shadow);border:1px solid var(--line)}
.metric-num{font-size:24px;font-weight:800;line-height:1;margin-bottom:10px}
.metric-en{font-size:14px;color:var(--muted)}
.metric-zh{font-size:14px;font-weight:700;margin-top:2px}
.metric--blocked .metric-num{color:var(--red)}
.metric--overdue .metric-num{color:var(--orange)}
.metric--atrisk .metric-num{color:var(--amber)}
.metric--active .metric-num{color:var(--blue)}
.metric--done .metric-num{color:var(--green)}
.metric--total .metric-num{color:var(--navy)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);padding:18px 18px 16px;margin-bottom:18px}
.section-hd{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:16px}
.section-hd.compact{margin-bottom:12px}
h2{margin:0;font-size:18px;line-height:1.2}
.section-hd p{margin:6px 0 0;color:var(--muted);font-size:13px}
.section-count{min-width:48px;height:48px;padding:0 14px;border-radius:14px;background:#eef2ff;color:var(--blue);display:flex;align-items:center;justify-content:center;font-weight:800}
.attention-list{display:flex;flex-direction:column;gap:12px}
.attention-item{display:flex;justify-content:space-between;gap:16px;border:1px solid var(--line);border-radius:16px;padding:14px 16px;text-decoration:none;color:inherit;background:#fafcff}
.attention-item--blocked{border-color:#fecaca;background:#fff7f7}
.attention-item--overdue{border-color:#fed7aa;background:#fffaf5}
.attention-item--atrisk{border-color:#fde68a;background:#fffdf5}
.att-title{font-size:15px;font-weight:800}
.att-meta,.att-reason{margin-top:6px;color:var(--muted);font-size:13px}
.risk-pill{display:inline-flex;align-items:center;justify-content:center;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:800}
.risk-pill--blocked{background:var(--red-bg);color:var(--red)}
.risk-pill--overdue{background:var(--orange-bg);color:var(--orange)}
.risk-pill--atrisk{background:var(--amber-bg);color:var(--amber)}
.empty-state{border:1px dashed var(--line);border-radius:14px;padding:16px;color:var(--muted);background:#fafcff}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap}
.filters{display:flex;gap:10px;flex-wrap:wrap}
.filter-btn,.owner-card,.owner-link{cursor:pointer}
.filter-btn{border:0;background:#f3f4f6;color:#26334d;padding:10px 16px;border-radius:999px;font-size:14px;font-weight:700}
.filter-btn.is-active{background:var(--navy);color:#fff}
.task-search{width:360px;max-width:100%;padding:11px 14px;border-radius:14px;border:1px solid var(--line);font-size:14px}
.table-wrap{overflow:auto}
.task-table{width:100%;border-collapse:collapse}
.task-table th,.task-table td{padding:16px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle;font-size:14px}
.task-table th{color:var(--muted);font-weight:700}
.task-link{color:var(--navy);font-weight:800;text-decoration:none}
.task-link:hover{text-decoration:underline}
.task-link--plain{text-decoration:none}
.task-code{display:inline-block;margin-left:8px;padding:4px 8px;border-radius:999px;background:#eef2ff;color:#6366f1;font-size:11px;font-weight:800;vertical-align:middle}
.badge,.risk{display:inline-flex;align-items:center;justify-content:center;padding:7px 12px;border-radius:999px;font-size:12px;font-weight:800;white-space:nowrap}
.badge--done,.risk--done{background:var(--green-bg);color:var(--green)}
.badge--active,.risk--active{background:#dbeafe;color:var(--blue)}
.badge--blocked,.risk--blocked{background:var(--red-bg);color:var(--red)}
.badge--pending,.risk--pending{background:#eef2f7;color:#64748b}
.badge--draft,.risk--draft{background:#f3f4f6;color:#6b7280}
.risk--overdue{background:var(--orange-bg);color:var(--orange)}
.risk--atrisk{background:var(--amber-bg);color:var(--amber)}
.owner-link{border:0;background:none;color:var(--blue);font-weight:800;padding:0}
.issue{color:#a14f2d}
.owner-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.owner-card{border:1px solid var(--line);background:#fafcff;border-radius:16px;padding:14px 16px;text-align:left}
.owner-card.is-active{outline:2px solid var(--blue);background:#eef4ff}
.owner-name{font-size:16px;font-weight:800;margin-bottom:8px}
.owner-stats{display:flex;flex-wrap:wrap;gap:10px;color:var(--muted);font-size:13px}
.phase-stack{display:flex;flex-direction:column;gap:12px}
.phase-card{display:flex;justify-content:space-between;gap:16px;align-items:center;border:1px solid var(--line);border-radius:16px;padding:18px}
.phase-title{font-size:18px;font-weight:800}
.phase-meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px;color:var(--muted);font-size:14px}
.phase-prog{min-width:340px;max-width:420px;flex:1;text-align:right}
.phase-pct{font-size:20px;font-weight:900;margin-bottom:8px}
.prog-track{height:14px;background:#edf2ff;border-radius:999px;overflow:hidden}
.prog-fill{height:100%;border-radius:999px}
.prog-fill--done{background:linear-gradient(90deg,#22c55e,#16a34a)}
.prog-fill--active{background:linear-gradient(90deg,#60a5fa,#3878ff)}
.prog-fill--blocked{background:linear-gradient(90deg,#fb7185,#dc2626)}
.prog-fill--pending,.prog-fill--draft{background:linear-gradient(90deg,#cbd5e1,#94a3b8)}
.phase-mini{font-size:13px;color:var(--muted);margin-top:8px}
.timeline{position:relative;height:124px;padding:16px 34px 12px;overflow:hidden}
.timeline-line{position:absolute;left:34px;right:34px;top:64px;height:4px;border-radius:999px;background:#dbe1ee}
.timeline-today{position:absolute;top:20px;transform:translateX(-50%)}
.timeline-today-line{height:46px;width:2px;background:#111827;margin:0 auto;border-radius:999px}
.timeline-today-label{margin-top:6px;font-weight:800;font-size:13px;color:#111827;text-align:center}
.tl-marker{position:absolute;top:48px;transform:translateX(-50%);width:124px;text-align:center}
.tl-dot{width:16px;height:16px;border-radius:999px;margin:0 auto 10px;box-shadow:0 0 0 6px rgba(99,102,241,.08)}
.tl-phase{background:#6366f1}
.tl-ms{background:#8b5cf6}
.tl-label{font-size:13px;color:var(--muted);line-height:1.35;word-break:break-word}
.tl-marker.edge-left{transform:none}
.tl-marker.edge-left .tl-label{text-align:left}
.tl-marker.edge-right{transform:translateX(-100%)}
.tl-marker.edge-right .tl-label{text-align:right}
.footer{text-align:center;color:var(--muted);font-size:12px;padding:10px 0 0}
@media (max-width:1100px){
  .top-metrics{grid-template-columns:repeat(3,1fr)}
  .phase-card{flex-direction:column;align-items:flex-start}
  .phase-prog{min-width:0;max-width:none;width:100%;text-align:left}
}
@media (max-width:760px){
  .top-metrics{grid-template-columns:repeat(2,1fr)}
  .timeline{padding:16px 18px 12px}
  .timeline-line{left:18px;right:18px}
  .tl-marker{width:88px}
}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div>
      <h1>${esc(title)}</h1>
      <div class="sub">Operational Board · 先看问题，再看任务，再看阶段。团队打开页面就知道“谁该做什么”。</div>
    </div>
    <div class="sync">Last sync · ${esc(syncText)}<br>${esc(domain)}</div>
  </div>

  ${summaryCards(summary, tasks)}
  ${renderAttentionZone(tasks)}
  ${renderActionBoard()}
  ${renderTaskList(tasks)}
  ${renderOwnerView(tasks)}
  ${renderPhaseView(board)}
  ${renderTimeline(board)}

  <div class="footer">${esc(domain)} · © ${new Date().getFullYear()} ARCBOS · Auto-published from Notion</div>
</div>
${buildPageScript()}
</body>
</html>`;
}
