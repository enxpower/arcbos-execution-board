// src/core/board-renderer.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Pure HTML renderer. Takes structured board data, returns complete HTML page.
// No Notion calls, no side effects.
// ─────────────────────────────────────────────────────────────────────────────

import { cfg } from '../lib/config.mjs';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); }
  catch { return d; }
}

function statusCls(s) {
  return { done:'done', active:'active', blocked:'blocked', draft:'draft' }[(s||'').toLowerCase()] || 'pending';
}

function badge(s) {
  const cls = statusCls(s);
  const labels = { Draft:'Draft', Active:'Active', Done:'Done', Blocked:'Blocked', Pending:'Pending' };
  return `<span class="badge badge--${cls}">${esc(labels[s] || s || 'Pending')}</span>`;
}

// ── Sections ───────────────────────────────────────────────────────────────

function renderSummaryBar(summary) {
  return `
<div class="summary-bar">
  <span class="sb-item"><span class="sb-num">${summary.totalTasks}</span><span class="sb-lbl">total</span></span>
  <span class="sb-sep"></span>
  <span class="sb-item sb-done"><span class="sb-num">${summary.totalDone}</span><span class="sb-lbl">done</span></span>
  <span class="sb-item sb-active"><span class="sb-num">${summary.totalActive}</span><span class="sb-lbl">active</span></span>
  <span class="sb-item sb-blocked"><span class="sb-num">${summary.totalBlocked}</span><span class="sb-lbl">blocked</span></span>
  ${summary.totalDraft ? `<span class="sb-item sb-draft"><span class="sb-num">${summary.totalDraft}</span><span class="sb-lbl">draft</span></span>` : ''}
</div>`;
}

function renderBlocked(allBlocked) {
  if (!allBlocked.length) return '';
  const rows = allBlocked.map(t => {
    const code = t.taskCode ? `<span class="task-code">${esc(t.taskCode)}</span> ` : '';
    return `<tr>
      <td class="bl-name">${code}${esc(t.name)}</td>
      <td>${esc(t.module || t.phase)}</td>
      <td>${esc(t.owner)}</td>
      <td>${esc(fmtDate(t.due))}</td>
      <td class="bl-reason">${esc(t.blockedBy || '—')}</td>
    </tr>`;
  }).join('');

  return `
<section class="blocked-section">
  <div class="blocked-header">
    <span class="blocked-dot"></span>
    <span class="blocked-title">Blocked — ${allBlocked.length} item${allBlocked.length !== 1 ? 's' : ''}</span>
  </div>
  <div class="blocked-scroll">
    <table class="blocked-table">
      <thead><tr><th>Task</th><th>Module</th><th>Owner</th><th>Due</th><th>Blocked by</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>`;
}

function renderMilestone(m) {
  const cls = statusCls(m.status);
  return `
<div class="ms ms--${cls}">
  <div class="ms-name">${esc(m.name)}</div>
  <div class="ms-meta">
    ${badge(m.status)}
    ${m.due ? `<span class="ms-due">${esc(fmtDate(m.due))}</span>` : ''}
    ${m.owner ? `<span class="ms-owner">${esc(m.owner)}</span>` : ''}
  </div>
</div>`;
}

function renderTaskChips(ph) {
  if (!ph.total) return '';
  return `
<div class="task-chips">
  <span class="chip-label">Tasks</span>
  ${ph.done    ? `<span class="chip chip--done">${ph.done} done</span>` : ''}
  ${ph.active  ? `<span class="chip chip--active">${ph.active} active</span>` : ''}
  ${ph.blocked ? `<span class="chip chip--blocked">${ph.blocked} blocked</span>` : ''}
  ${ph.draft   ? `<span class="chip chip--draft">${ph.draft} draft</span>` : ''}
</div>`;
}

function renderPhase(ph) {
  const cls       = statusCls(ph.status);
  const dateRange = [fmtDate(ph.startDate), fmtDate(ph.due)].filter(Boolean).join(' – ');
  return `
<section class="phase">
  <div class="phase-hd">
    <div class="phase-title-row">
      <h2 class="phase-name">${esc(ph.name)}</h2>
      ${badge(ph.status)}
    </div>
    ${dateRange ? `<div class="phase-dates">${esc(dateRange)}</div>` : ''}
    <div class="phase-progress">
      <div class="prog-track"><div class="prog-fill prog-fill--${cls}" style="width:${ph.pct}%"></div></div>
      <span class="prog-label">${ph.pct}%</span>
    </div>
  </div>
  <div class="milestones">
    ${ph.milestones.length
      ? ph.milestones.map(renderMilestone).join('')
      : '<div class="no-ms">No milestones defined</div>'}
  </div>
  ${renderTaskChips(ph)}
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
    const cls   = it.type === 'phase' ? 'tl-phase' : `tl-${statusCls(it.status||'pending')}`;
    const label = it.name.length > 16 ? it.name.slice(0,14)+'…' : it.name;
    return `<div class="tl-marker ${cls}" style="left:${pct(it.date)}%" title="${esc(it.name)} — ${fmtDate(it.date)}">
      <div class="tl-dot"></div><div class="tl-lbl">${esc(label)}</div></div>`;
  }).join('');

  return `
<section class="timeline-wrap">
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

// ── Full page ──────────────────────────────────────────────────────────────

export function renderBoard({ board, allBlocked, summary, lastSync }) {
  const title   = cfg.boardTitle;
  const domain  = cfg.boardDomain;
  const syncTime = new Date(lastSync).toLocaleString('en-US', {
    weekday:'short', month:'short', day:'numeric',
    hour:'2-digit', minute:'2-digit', timeZoneName:'short',
  });

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex,nofollow">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:15px;-webkit-font-smoothing:antialiased}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;
  background:#f5f5f4;color:#1c1c1a;line-height:1.5;min-height:100vh}
.wrap{max-width:980px;margin:0 auto;padding:28px 20px 64px}

/* ── header ── */
.hd{border-bottom:1px solid #e2e1da;padding-bottom:14px;margin-bottom:20px}
.hd-top{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.hd-title{font-size:1.15rem;font-weight:600;letter-spacing:-.02em}
.hd-sync{font-size:.75rem;color:#888780}

/* ── summary bar ── */
.summary-bar{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.sb-item{display:flex;flex-direction:column;align-items:center;min-width:44px}
.sb-num{font-size:1.3rem;font-weight:600;line-height:1}
.sb-lbl{font-size:.68rem;color:#888780;text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
.sb-sep{width:1px;height:28px;background:#e2e1da;margin:0 4px}
.sb-done .sb-num{color:#1d9e75}
.sb-active .sb-num{color:#ef9f27}
.sb-blocked .sb-num{color:#e24b4a}
.sb-draft .sb-num{color:#888780}

/* ── legend ── */
.legend{display:flex;gap:12px;margin:16px 0 22px;flex-wrap:wrap}
.leg{display:flex;align-items:center;gap:5px;font-size:.76rem;color:#5f5e5a}
.leg-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.ld-done{background:#1d9e75}.ld-active{background:#ef9f27}
.ld-blocked{background:#e24b4a}.ld-pending{background:#b4b2a9}.ld-draft{background:#d3d1c7}

/* ── badges ── */
.badge{font-size:.68rem;font-weight:500;padding:2px 7px;border-radius:20px;white-space:nowrap}
.badge--done{background:#e1f5ee;color:#0f6e56}
.badge--active{background:#faeeda;color:#854f0b}
.badge--blocked{background:#fcebeb;color:#a32d2d}
.badge--pending,.badge--{background:#f1efe8;color:#5f5e5a}
.badge--draft{background:#f1efe8;color:#888780}

/* ── task code ── */
.task-code{font-family:ui-monospace,monospace;font-size:.75rem;background:#f1efe8;
  padding:1px 5px;border-radius:4px;color:#5f5e5a;margin-right:2px}

/* ── blocked section ── */
.blocked-section{background:#fff5f5;border:1px solid #f7c1c1;border-radius:10px;
  padding:14px 18px;margin-bottom:24px}
.blocked-header{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.blocked-dot{width:9px;height:9px;border-radius:50%;background:#e24b4a;flex-shrink:0}
.blocked-title{font-size:.86rem;font-weight:600;color:#a32d2d}
.blocked-scroll{overflow-x:auto}
.blocked-table{width:100%;border-collapse:collapse;font-size:.78rem;min-width:480px}
.blocked-table th{text-align:left;color:#a32d2d;font-weight:500;
  padding:3px 10px 7px 0;border-bottom:1px solid #f7c1c1;white-space:nowrap}
.blocked-table td{padding:5px 10px 5px 0;color:#791f1f;
  border-bottom:1px solid #feeded;vertical-align:top}
.blocked-table tr:last-child td{border-bottom:none}
.bl-name{font-weight:500;min-width:140px}
.bl-reason{color:#a32d2d;opacity:.85;min-width:160px}

/* ── timeline ── */
.timeline-wrap{margin-bottom:28px}
.tl-track{position:relative;height:60px;padding:0 8px}
.tl-line{position:absolute;top:18px;left:0;right:0;height:2px;background:#e2e1da;border-radius:1px}
.tl-marker{position:absolute;top:0;transform:translateX(-50%);text-align:center}
.tl-dot{width:10px;height:10px;border-radius:50%;margin:13px auto 4px;border:2px solid #f5f5f4}
.tl-lbl{font-size:.62rem;color:#5f5e5a;white-space:nowrap;line-height:1.2;
  max-width:86px;overflow:hidden;text-overflow:ellipsis}
.tl-phase .tl-dot{background:#534ab7;width:12px;height:12px;margin-top:12px}
.tl-done .tl-dot{background:#1d9e75}
.tl-active .tl-dot{background:#ef9f27}
.tl-blocked .tl-dot{background:#e24b4a}
.tl-pending .tl-dot{background:#b4b2a9}
.tl-today{position:absolute;top:0;transform:translateX(-50%)}
.tl-today-line{width:2px;height:36px;background:#e24b4a;margin:0 auto;border-radius:1px;opacity:.7}
.tl-today-lbl{font-size:.6rem;color:#a32d2d;text-align:center;font-weight:600;margin-top:2px}

/* ── phase ── */
.phase{background:#fff;border:1px solid #e2e1da;border-radius:12px;
  padding:18px 22px;margin-bottom:16px}
.phase-hd{margin-bottom:12px}
.phase-title-row{display:flex;align-items:center;gap:10px;margin-bottom:4px;flex-wrap:wrap}
.phase-name{font-size:.93rem;font-weight:600}
.phase-dates{font-size:.76rem;color:#888780;margin-bottom:5px}
.phase-progress{display:flex;align-items:center;gap:10px;margin-top:4px}
.prog-track{flex:1;height:5px;background:#f1efe8;border-radius:3px;overflow:hidden}
.prog-fill{height:100%;border-radius:3px;transition:width .3s}
.prog-fill--done{background:#1d9e75}
.prog-fill--active{background:#ef9f27}
.prog-fill--pending,.prog-fill--{background:#b4b2a9}
.prog-fill--blocked{background:#e24b4a}
.prog-label{font-size:.73rem;font-weight:500;color:#5f5e5a;min-width:32px;text-align:right}

/* ── milestones ── */
.milestones{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));
  gap:9px;margin-bottom:10px}
.ms{border:1px solid #e2e1da;border-radius:8px;padding:11px 13px;background:#fafaf9}
.ms--done{border-color:#9fe1cb;background:#f0faf6}
.ms--active{border-color:#fac775;background:#fffdf5}
.ms--blocked{border-color:#f7c1c1;background:#fff5f5}
.ms--pending{opacity:.75}
.ms-name{font-size:.84rem;font-weight:500;margin-bottom:6px}
.ms-meta{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.ms-due{font-size:.71rem;color:#888780}
.ms-owner{font-size:.71rem;color:#888780;margin-left:auto}
.no-ms{font-size:.78rem;color:#b4b2a9;font-style:italic;padding:2px 0 9px}

/* ── task chips ── */
.task-chips{display:flex;align-items:center;gap:7px;flex-wrap:wrap;
  padding-top:10px;border-top:1px solid #f1efe8;margin-top:2px}
.chip-label{font-size:.73rem;color:#888780;font-weight:500}
.chip{font-size:.7rem;padding:2px 7px;border-radius:20px;font-weight:500}
.chip--done{background:#e1f5ee;color:#0f6e56}
.chip--active{background:#faeeda;color:#854f0b}
.chip--blocked{background:#fcebeb;color:#a32d2d}
.chip--draft{background:#f1efe8;color:#888780}

/* ── footer ── */
.footer{text-align:center;font-size:.73rem;color:#b4b2a9;margin-top:36px;
  padding-top:12px;border-top:1px solid #f1efe8}

@media(max-width:600px){
  .wrap{padding:16px 12px 48px}
  .milestones{grid-template-columns:1fr}
  .blocked-table td:nth-child(3),.blocked-table th:nth-child(3),
  .blocked-table td:nth-child(4),.blocked-table th:nth-child(4){display:none}
  .tl-lbl{display:none}
  .summary-bar{gap:10px}
}
</style>
<body>
<div class="wrap">
  <div class="hd">
    <div class="hd-top">
      <div class="hd-title">${esc(title)}</div>
      <div class="hd-sync">Last sync: ${esc(syncTime)}</div>
    </div>
    ${renderSummaryBar(summary)}
  </div>

  <div class="legend">
    <span class="leg"><span class="leg-dot ld-done"></span>Done</span>
    <span class="leg"><span class="leg-dot ld-active"></span>Active</span>
    <span class="leg"><span class="leg-dot ld-blocked"></span>Blocked</span>
    <span class="leg"><span class="leg-dot ld-pending"></span>Pending</span>
    <span class="leg"><span class="leg-dot ld-draft"></span>Draft (awaiting approval)</span>
  </div>

  ${renderBlocked(allBlocked)}
  ${renderTimeline(board)}
  ${board.map(renderPhase).join('')}

  <div class="footer">
    ${esc(domain)} &nbsp;·&nbsp; © ${new Date().getFullYear()} ARCBOS &nbsp;·&nbsp;
    Auto-published from Notion
  </div>
</div>
</body></html>`;
}
