import { spawnSync } from 'node:child_process';

function serializePayload(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function openInBrowser(filePath, platform = process.platform) {
  try {
    let cmd;
    let args;
    if (platform === 'darwin') {
      cmd = 'open';
      args = [filePath];
    } else if (platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', filePath];
    } else {
      cmd = 'xdg-open';
      args = [filePath];
    }
    const res = spawnSync(cmd, args, { stdio: 'ignore', timeout: 5000 });
    return { opened: res.status === 0, status: res.status };
  } catch (err) {
    return { opened: false, error: err.message };
  }
}

export function generateDashboardHtml({
  stats,
  timeline,
  dailyTimeline,
  chains,
  inventory,
  generatedAt = new Date().toISOString(),
} = {}) {
  const invSkills = (inventory?.skills || []).map((s) => ({
    name: s.name,
    dir_name: s.dir_name,
    source: s.source,
    hosts: s.hosts || [],
    est_tokens: s.est_tokens || 0,
    desc_chars: s.desc_chars || 0,
    enabled: Boolean(s.enabled),
  }));

  const payload = {
    generatedAt,
    stats: stats || { window: {}, totals: {}, inventory: {}, rows: [], unused: { bySource: [] }, insights: {} },
    timeline: timeline || { window: {}, by: 'day', totals: {}, rows: [] },
    dailyTimeline: dailyTimeline || timeline || { window: {}, by: 'day', totals: {}, rows: [] },
    chains: chains || { window: {}, totals: {}, transitions: [], sequences: [], pairs: [] },
    inventory: { skills: invSkills },
  };

  const jsonScript = serializePayload(payload);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>skilltally Analytics</title>
<style>
  :root {
    --bg: #000000;
    --pill-bg: #070707;
    --surface: #171717;
    --surface-hover: #1f1f1f;
    --border: #262626;
    --border-subtle: #1a1a1a;
    --text: #f5f5f5;
    --muted: #8e8e93;
    --dim: #52525b;
    --dot-empty: #242424;
    --blue-1: #152c4a;
    --blue-2: #1d4ed8;
    --blue-3: #2b7fff;
    --blue-4: #93c5fd;
    --bloat-fill: #212121;
    --bloat-stroke: #2e2e2e;
    --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  [data-theme="light"] {
    --bg: #ffffff;
    --pill-bg: #fafafa;
    --surface: #f4f4f5;
    --surface-hover: #ececef;
    --border: #e4e4e7;
    --border-subtle: #f0f0f2;
    --text: #0d0d0d;
    --muted: #6e6e80;
    --dim: #a1a1aa;
    --dot-empty: #ebebeb;
    --blue-1: #bfdbfe;
    --blue-2: #60a5fa;
    --blue-3: #2563eb;
    --blue-4: #1d4ed8;
    --bloat-fill: #ececef;
    --bloat-stroke: #d4d4d8;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--sans); -webkit-font-smoothing: antialiased; }
  body { padding: 40px 20px 72px; font-size: 14px; line-height: 1.5; }
  .wrap { max-width: 760px; margin: 0 auto; }

  /* Subtle top bar */
  .topbar {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    margin-bottom: 24px;
  }
  .brand-title { font-size: 15px; font-weight: 500; letter-spacing: -0.01em; color: var(--text); }
  .brand-meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .top-links { display: flex; align-items: center; gap: 16px; }

  /* Text link buttons (profile switcher pattern) */
  .text-tab {
    background: none; border: none; padding: 0; margin: 0;
    font: inherit; font-size: 13px; font-weight: 400;
    color: var(--muted); cursor: pointer; transition: color 0.15s ease;
  }
  .text-tab:hover { color: var(--text); }
  .text-tab.active { color: var(--text); font-weight: 500; }

  /* 5-Metric Pill Strip */
  .kpi-strip {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    background: var(--pill-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 0;
    margin-bottom: 36px;
  }
  .kpi-cell {
    text-align: center;
    padding: 0 10px;
    border-right: 1px solid var(--border-subtle);
  }
  .kpi-cell:last-child { border-right: none; }
  .kpi-val { font-size: 16px; font-weight: 500; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; color: var(--text); }
  .kpi-lbl { font-size: 12px; color: var(--muted); margin-top: 3px; white-space: nowrap; }

  /* Sections */
  section { margin-bottom: 40px; }
  .sec-head {
    display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .sec-title { margin: 0; font-size: 15px; font-weight: 500; letter-spacing: -0.01em; color: var(--text); }
  .sec-tabs { display: flex; align-items: center; gap: 16px; }

  /* Activity Heatmap / Timeline */
  .activity-wrap { width: 100%; overflow-x: auto; }
  svg { width: 100%; display: block; }

  /* Top Sources / Plugins Squircle Dock */
  .dock {
    display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap;
  }
  .squircle-btn {
    background: none; border: none; padding: 0; cursor: pointer;
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    color: var(--muted); width: 60px;
  }
  .squircle-box {
    width: 54px; height: 54px; border-radius: 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    display: grid; place-items: center;
    font-size: 14px; font-weight: 600; color: var(--text);
    letter-spacing: -0.02em;
    transition: border-color 0.15s ease, background 0.15s ease, transform 0.12s ease;
  }
  .squircle-btn:hover .squircle-box { background: var(--surface-hover); border-color: var(--dim); transform: translateY(-1px); }
  .squircle-btn.active .squircle-box { border-color: var(--blue-3); box-shadow: 0 0 0 1px var(--blue-3); }
  .squircle-btn.active { color: var(--text); }
  .squircle-lbl {
    font-size: 11px; max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* Showcase Context Footprint Card */
  .showcase-card {
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 16px;
    padding: 18px;
  }
  .showcase-foot {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    margin-top: 12px; font-size: 12px; color: var(--muted);
  }
  .dot-legend { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .swatch { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 5px; vertical-align: middle; }

  /* Insights Key-Value Ledger */
  .ledger-row {
    display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
    padding: 9px 0;
  }
  .ledger-k { color: var(--muted); font-size: 14px; }
  .ledger-v { color: var(--text); font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; text-align: right; }

  .rec-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .rec-row:last-child { border-bottom: none; }
  .rec-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .code-pill {
    font-family: var(--mono); font-size: 11px; color: var(--muted);
    background: var(--surface); border: 1px solid var(--border);
    padding: 4px 8px; border-radius: 6px; white-space: nowrap;
  }

  /* Skills Explorer Table */
  .controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  input[type="search"], select {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
    font-family: inherit;
    font-size: 12px;
    outline: none;
  }
  input[type="search"] { flex: 1; min-width: 180px; }
  input[type="search"]:focus, select:focus { border-color: var(--dim); }

  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td {
    text-align: left; padding: 10px 8px;
    border-bottom: 1px solid var(--border-subtle);
    white-space: nowrap;
  }
  th {
    font-size: 11px; font-weight: 500; color: var(--muted);
    cursor: pointer; user-select: none;
  }
  th:hover { color: var(--text); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:hover td { background: var(--pill-bg); }
  .mono { font-family: var(--mono); font-size: 12px; }
  .status-dot {
    width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 6px; vertical-align: middle;
  }
  .status-dot.used { background: var(--blue-3); }
  .status-dot.unused { background: var(--dim); }

  /* Footer */
  footer {
    margin-top: 48px; padding-top: 18px;
    border-top: 1px solid var(--border-subtle);
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    font-size: 12px; color: var(--muted);
  }

  /* Tooltip */
  .tooltip {
    position: fixed; pointer-events: none; z-index: 1000; display: none;
    background: #141414; color: #f5f5f5; border: 1px solid #2e2e2e;
    padding: 7px 10px; border-radius: 8px; font-size: 12px; line-height: 1.4;
    max-width: 280px;
  }
  [data-theme="light"] .tooltip { background: #18181b; color: #fafafa; }

  /* Mermaid Dialog */
  dialog {
    background: var(--surface); color: var(--text);
    border: 1px solid var(--border); border-radius: 14px;
    max-width: 680px; width: 92vw; padding: 20px;
  }
  dialog::backdrop { background: rgba(0, 0, 0, 0.72); }
  pre {
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px; overflow-x: auto; font-family: var(--mono); font-size: 12px; margin: 12px 0;
  }
  .btn-minimal {
    background: var(--text); color: var(--bg); border: none; border-radius: 999px;
    padding: 7px 14px; font-size: 12px; font-weight: 500; cursor: pointer;
  }
  .btn-outline {
    background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 999px;
    padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer;
  }

  .hidden { display: none !important; }

  @media (max-width: 640px) {
    .kpi-strip { grid-template-columns: repeat(2, 1fr); row-gap: 12px; }
    .kpi-cell { border-right: none; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header class="topbar">
    <div>
      <div class="brand-title">skilltally Analytics</div>
      <div class="brand-meta" id="window-subtitle">100% local · zero telemetry</div>
    </div>
    <div class="top-links">
      <button class="text-tab hidden" id="btn-reset-filter">Clear filter</button>
      <button class="text-tab" id="btn-theme">Light mode</button>
    </div>
  </header>

  <div class="kpi-strip" id="kpi-strip"></div>

  <section>
    <div class="sec-head">
      <h2 class="sec-title">Skill activity</h2>
      <div class="sec-tabs">
        <button class="text-tab active" data-activity="daily">Daily</button>
        <button class="text-tab" data-activity="weekly">Weekly</button>
        <button class="text-tab" data-activity="cumulative">Cumulative</button>
      </div>
    </div>
    <div class="activity-wrap">
      <svg id="svg-timeline" viewBox="0 0 720 132"></svg>
    </div>
  </section>

  <section>
    <div class="sec-head">
      <h2 class="sec-title">Top sources</h2>
      <span class="brand-meta" id="dock-subtitle">Click a source to filter</span>
    </div>
    <div class="dock" id="sources-dock"></div>
  </section>

  <section>
    <div class="sec-head">
      <h2 class="sec-title">Context footprint</h2>
      <div class="sec-tabs">
        <button class="text-tab active" data-treemap-mode="source">By Source</button>
        <button class="text-tab" data-treemap-mode="skill">By Skill</button>
      </div>
    </div>
    <div class="showcase-card">
      <svg id="svg-treemap" viewBox="0 0 720 220" preserveAspectRatio="xMidYMid meet"></svg>
      <div class="showcase-foot">
        <span id="footprint-summary">Area proportional to ~tokens/session</span>
        <div class="dot-legend">
          <span><span class="swatch" style="background:var(--bloat-fill);border:1px solid var(--bloat-stroke)"></span>0 runs</span>
          <span><span class="swatch" style="background:var(--blue-1)"></span>1-2</span>
          <span><span class="swatch" style="background:var(--blue-2)"></span>3-7</span>
          <span><span class="swatch" style="background:var(--blue-3)"></span>8+</span>
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="sec-head">
      <h2 class="sec-title">Insights</h2>
      <div class="sec-tabs">
        <button class="text-tab active" data-insights-tab="overview">Overview</button>
        <button class="text-tab" data-insights-tab="workflows">Workflows</button>
        <button class="text-tab" data-insights-tab="pruning">Pruning</button>
      </div>
    </div>

    <div id="panel-overview"></div>

    <div id="panel-workflows" class="hidden">
      <div class="showcase-card" style="margin-bottom: 12px;">
        <svg id="svg-chains" viewBox="0 0 720 210"></svg>
      </div>
      <div id="workflows-ledger"></div>
    </div>

    <div id="panel-pruning" class="hidden"></div>
  </section>

  <section>
    <div class="sec-head">
      <h2 class="sec-title">Skills</h2>
      <div class="sec-tabs">
        <button class="text-tab active" data-status-tab="all">All</button>
        <button class="text-tab" data-status-tab="used">Used</button>
        <button class="text-tab" data-status-tab="unused">Unused</button>
      </div>
    </div>
    <div class="controls">
      <input type="search" id="filter-search" placeholder="Filter skills or sources..." />
      <select id="filter-host"><option value="all">Host: All</option></select>
      <select id="filter-source"><option value="all">Source: All</option></select>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th data-sort="skill">Skill</th>
            <th data-sort="source">Source</th>
            <th class="num" data-sort="activations">Activations</th>
            <th class="num" data-sort="reads">Reads</th>
            <th class="num" data-sort="est_tokens">Context</th>
            <th class="num" data-sort="manualRatio">Manual</th>
            <th>14d</th>
            <th>Hosts</th>
          </tr>
        </thead>
        <tbody id="skills-tbody"></tbody>
      </table>
    </div>
    <div class="brand-meta" id="table-count" style="margin-top: 10px;"></div>
  </section>

  <footer>
    <span>skilltally · 100% local · zero telemetry</span>
    <div class="top-links">
      <button class="text-tab" id="btn-mermaid">Export Mermaid</button>
    </div>
  </footer>
</div>

<div class="tooltip" id="tooltip"></div>

<dialog id="mermaid-dialog">
  <div class="sec-head" style="margin-bottom: 10px;">
    <h2 class="sec-title">Mermaid Diagrams</h2>
    <button class="btn-outline" id="btn-close-mermaid">Close</button>
  </div>
  <div class="sec-tabs">
    <button class="text-tab active" data-mermaid="pie">Context Tax Pie</button>
    <button class="text-tab" data-mermaid="timeline">Timeline XY Chart</button>
    <button class="text-tab" data-mermaid="chains">Workflow Flowchart</button>
  </div>
  <pre id="mermaid-code"></pre>
  <div style="display:flex; justify-content:flex-end;">
    <button class="btn-minimal" id="btn-copy-mermaid">Copy Snippet</button>
  </div>
</dialog>

<script id="skilltally-data" type="application/json">${jsonScript}</script>
<script>
(function() {
  const DATA = JSON.parse(document.getElementById('skilltally-data').textContent);
  const stats = DATA.stats || {};
  const timeline = DATA.timeline || {};
  const dailyTimeline = DATA.dailyTimeline || timeline;
  const chains = DATA.chains || {};
  const invSkills = (DATA.inventory && DATA.inventory.skills) || [];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, text = null) => {
    const node = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text !== null) node.textContent = String(text);
    return node;
  };
  const fmtCompact = (n) => {
    const v = Number(n || 0);
    if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(1).replace(/\\.0$/, '') + 'B';
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\\.0$/, '') + 'M';
    if (v >= 1_000) return (v / 1_000).toFixed(1).replace(/\\.0$/, '') + 'K';
    return String(v);
  };
  const fmtDuration = (seconds) => {
    const sec = Number(seconds || 0);
    if (!Number.isFinite(sec) || sec <= 0) return '0s';
    const rounded = Math.round(sec);
    if (rounded < 60) return rounded + 's';
    if (rounded < 3600) {
      const m = Math.floor(rounded / 60);
      const s = rounded % 60;
      return s > 0 ? m + 'm ' + s + 's' : m + 'm';
    }
    const h = Math.floor(rounded / 3600);
    const m = Math.floor((rounded % 3600) / 60);
    return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
  };

  const tooltip = document.getElementById('tooltip');
  function showTip(evt, html) {
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    const x = Math.min(window.innerWidth - 290, evt.clientX + 12);
    const y = Math.min(window.innerHeight - 100, evt.clientY + 12);
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }
  function hideTip() { tooltip.style.display = 'none'; }

  // Theme (Default dark pure black; remembers user override)
  const themeBtn = document.getElementById('btn-theme');
  const applyTheme = (mode) => {
    if (mode === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      themeBtn.textContent = 'Dark mode';
    } else {
      document.documentElement.removeAttribute('data-theme');
      themeBtn.textContent = 'Light mode';
    }
  };
  const savedTheme = localStorage.getItem('skilltally-theme');
  if (savedTheme === 'light') applyTheme('light');
  themeBtn.addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const next = isLight ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('skilltally-theme', next);
  });

  // Subtitle
  const win = stats.window || {};
  const winLabel = win.from ? \`\${win.from} \u2192 \${win.to} (\${win.since})\` : \`all time \u00b7 \${win.to || ''}\`;
  document.getElementById('window-subtitle').textContent = \`\${winLabel}\`;

  // Compute daily map & streaks
  const dayRows = (dailyTimeline.rows || []).filter((r) => /^\\d{4}-\\d{2}-\\d{2}$/.test(r.bucket));
  const dayMap = new Map();
  for (const r of dayRows) dayMap.set(r.bucket, r);

  const activeDayMs = dayRows
    .filter((r) => r.activations > 0)
    .map((r) => Date.parse(r.bucket + 'T00:00:00.000Z'))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  let longestStreak = 0;
  let run = 0;
  for (let i = 0; i < activeDayMs.length; i++) {
    if (i === 0 || activeDayMs[i] - activeDayMs[i - 1] === 86400_000) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > longestStreak) longestStreak = run;
  }

  const endStr = (win.to || (DATA.generatedAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10));
  const endMidnight = Date.parse(endStr + 'T00:00:00.000Z');
  let currentStreak = 0;
  if (activeDayMs.length > 0 && Number.isFinite(endMidnight)) {
    const activeSet = new Set(activeDayMs);
    let cursor = activeSet.has(endMidnight)
      ? endMidnight
      : activeSet.has(endMidnight - 86400_000)
        ? endMidnight - 86400_000
        : null;
    while (cursor !== null && activeSet.has(cursor)) {
      currentStreak += 1;
      cursor -= 86400_000;
    }
  }

  // 1. 5-Metric Pill Strip (Profile layout)
  const totals = stats.totals || {};
  const inv = stats.inventory || {};
  const unused = stats.unused || {};
  const tokStats = totals.tokens || {};
  const durStats = totals.duration || {};
  const enabledTok = inv.enabledEstTokens || 0;
  const unusedTok = unused.totalEstTokens || 0;
  const wastePct = enabledTok > 0 ? Math.round((unusedTok / enabledTok) * 100) : 0;

  document.getElementById('kpi-strip').innerHTML = [
    { val: fmtCompact(tokStats.lifetimeTokens || 0), lbl: 'Lifetime tokens' },
    { val: fmtCompact(tokStats.peakSessionTokens || 0), lbl: 'Peak tokens' },
    { val: fmtDuration(durStats.longestTaskSeconds || 0), lbl: 'Longest task' },
    { val: longestStreak + (longestStreak === 1 ? ' day' : ' days'), lbl: 'Longest streak' },
    { val: currentStreak + (currentStreak === 1 ? ' day' : ' days'), lbl: 'Current streak' }
  ].map((k) => \`
    <div class="kpi-cell">
      <div class="kpi-val">\${esc(k.val)}</div>
      <div class="kpi-lbl">\${esc(k.lbl)}</div>
    </div>
  \`).join('');

  // Unified skill dataset
  const usedByKey = new Map();
  for (const r of (stats.rows || [])) {
    usedByKey.set(r.skill + '\\0' + r.source, r);
    if (!usedByKey.has(r.skill)) usedByKey.set(r.skill, r);
  }
  const unified = [];
  const seenUnified = new Set();
  for (const s of invSkills) {
    if (!s.enabled) continue;
    const match = usedByKey.get(s.name + '\\0' + s.source) || usedByKey.get(s.name) || usedByKey.get(s.dir_name);
    const key = s.name + '\\0' + s.source;
    if (seenUnified.has(key)) continue;
    seenUnified.add(key);
    unified.push({
      skill: s.name,
      source: s.source,
      activations: match ? match.activations : 0,
      reads: match ? match.reads : 0,
      est_tokens: s.est_tokens || (match ? match.est_tokens : 0) || 10,
      raw_tokens: s.est_tokens || (match ? match.est_tokens : 0) || 0,
      manualRatio: match ? match.manualRatio : 0,
      sparkline: match ? match.sparkline : '··············',
      hosts: match && match.hosts.length ? match.hosts : s.hosts,
      status: match ? 'used' : 'unused'
    });
  }
  for (const r of (stats.rows || [])) {
    if (![...seenUnified].some((k) => k.startsWith(r.skill + '\\0'))) {
      unified.push({
        skill: r.skill,
        source: r.source,
        activations: r.activations,
        reads: r.reads,
        est_tokens: r.est_tokens || 10,
        raw_tokens: r.est_tokens || 0,
        manualRatio: r.manualRatio || 0,
        sparkline: r.sparkline || '··············',
        hosts: r.hosts || [],
        status: 'used'
      });
    }
  }

  // 2. Skill Activity Heatmap / Weekly / Cumulative
  let activityMode = 'daily';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dotColor = (act, maxAct) => {
    if (!act || act <= 0) return 'var(--dot-empty)';
    const ratio = act / Math.max(1, maxAct);
    if (ratio <= 0.25) return 'var(--blue-1)';
    if (ratio <= 0.55) return 'var(--blue-2)';
    if (ratio <= 0.85) return 'var(--blue-3)';
    return 'var(--blue-4)';
  };

  function isoWeekKey(dateObj) {
    const d = new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d - yearStart) / 86400_000 + 1) / 7);
    return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
  }

  function renderActivity() {
    const svg = document.getElementById('svg-timeline');
    svg.innerHTML = '';

    if (activityMode === 'daily') {
      svg.setAttribute('viewBox', '0 0 720 128');
      const endDate = Number.isFinite(endMidnight) ? new Date(endMidnight) : new Date();
      const endDow = endDate.getUTCDay();
      const cols = 52;
      const startMs = endDate.getTime() - (51 * 7 + endDow) * 86400_000;
      const maxAct = Math.max(1, ...dayRows.map((r) => r.activations));

      const pitchX = 13.8;
      const pitchY = 13.8;
      const offsetX = 4;
      const offsetY = 8;

      let lastMonth = -1;
      let lastLabelX = -100;

      for (let c = 0; c < cols; c++) {
        const colTopDate = new Date(startMs + c * 7 * 86400_000);
        const m = colTopDate.getUTCMonth();
        const cx = offsetX + c * pitchX + 4;
        if (m !== lastMonth && cx - lastLabelX >= 36) {
          svg.appendChild(el('text', {
            x: cx - 4, y: 120, fill: 'var(--muted)', 'font-size': 11
          }, MONTHS[m]));
          lastMonth = m;
          lastLabelX = cx;
        }

        for (let r = 0; r < 7; r++) {
          if (c === cols - 1 && r > endDow) continue;
          const dMs = startMs + (c * 7 + r) * 86400_000;
          const iso = new Date(dMs).toISOString().slice(0, 10);
          const entry = dayMap.get(iso);
          const act = entry ? entry.activations : 0;
          const reads = entry ? entry.reads : 0;
          const dot = el('circle', {
            cx, cy: offsetY + r * pitchY + 4, r: 4.3,
            fill: dotColor(act, maxAct)
          });
          dot.addEventListener('mousemove', (evt) => {
            showTip(evt, \`<strong>\${esc(iso)}</strong><br/>Activations: \${act}<br/>Reads: \${reads}\`);
          });
          dot.addEventListener('mouseleave', hideTip);
          svg.appendChild(dot);
        }
      }
      return;
    }

    svg.setAttribute('viewBox', '0 0 720 156');
    let series = [];
    if (dayRows.length > 0) {
      const weekBuckets = new Map();
      for (const r of dayRows) {
        const wk = isoWeekKey(new Date(r.bucket + 'T00:00:00.000Z'));
        let b = weekBuckets.get(wk);
        if (!b) { b = { bucket: wk, activations: 0, reads: 0 }; weekBuckets.set(wk, b); }
        b.activations += r.activations;
        b.reads += r.reads;
      }
      series = [...weekBuckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
    } else {
      series = (timeline.rows || []).map((r) => ({ bucket: r.bucket, activations: r.activations, reads: r.reads }));
    }

    if (series.length === 0) {
      svg.appendChild(el('text', { x: 360, y: 80, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 13 }, 'No activity recorded in this window.'));
      return;
    }

    const padL = 32, padR = 12, padT = 14, padB = 24;
    const W = 720 - padL - padR;
    const H = 156 - padT - padB;

    if (activityMode === 'weekly') {
      const display = series.slice(-26);
      const maxV = Math.max(1, ...display.map((r) => r.activations));
      const step = W / display.length;
      const barW = Math.max(5, Math.min(24, step * 0.62));
      display.forEach((r, idx) => {
        const bh = Math.max(2, (r.activations / maxV) * H);
        const bx = padL + idx * step + (step - barW) / 2;
        const by = padT + H - bh;
        const rect = el('rect', { x: bx, y: by, width: barW, height: bh, rx: 3, fill: r.activations > 0 ? 'var(--blue-3)' : 'var(--dot-empty)' });
        rect.addEventListener('mousemove', (evt) => {
          showTip(evt, \`<strong>\${esc(r.bucket)}</strong><br/>Activations: \${r.activations}<br/>Reads: \${r.reads}\`);
        });
        rect.addEventListener('mouseleave', hideTip);
        svg.appendChild(rect);
        if (display.length <= 8 || idx === 0 || idx === display.length - 1 || idx % Math.ceil(display.length / 5) === 0) {
          svg.appendChild(el('text', { x: bx + barW / 2, y: 148, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 10 }, r.bucket));
        }
      });
    } else {
      const cumRows = [];
      let sum = 0;
      const src = dayRows.length > 0 ? [...dayRows].sort((a, b) => a.bucket.localeCompare(b.bucket)) : series;
      for (const r of src) {
        sum += r.activations;
        cumRows.push({ bucket: r.bucket, total: sum, delta: r.activations });
      }
      const maxV = Math.max(1, sum);
      const pts = cumRows.map((r, i) => {
        const x = padL + (cumRows.length === 1 ? W / 2 : (i / (cumRows.length - 1)) * W);
        const y = padT + H - (r.total / maxV) * H;
        return { x, y, r };
      });
      const lineD = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
      const areaD = lineD + \` L \${pts[pts.length - 1].x.toFixed(1)} \${padT + H} L \${pts[0].x.toFixed(1)} \${padT + H} Z\`;
      svg.appendChild(el('path', { d: areaD, fill: 'var(--blue-3)', 'fill-opacity': '0.12' }));
      svg.appendChild(el('path', { d: lineD, fill: 'none', stroke: 'var(--blue-3)', 'stroke-width': 2 }));
      svg.appendChild(el('text', { x: padL - 6, y: padT + 8, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 10 }, fmtCompact(maxV)));
      svg.appendChild(el('text', { x: padL, y: 148, fill: 'var(--muted)', 'font-size': 10 }, cumRows[0].bucket));
      svg.appendChild(el('text', { x: 720 - padR, y: 148, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 10 }, cumRows[cumRows.length - 1].bucket));
      for (const p of pts) {
        const hit = el('circle', { cx: p.x, cy: p.y, r: 4, fill: 'transparent', style: 'cursor:pointer' });
        hit.addEventListener('mousemove', (evt) => {
          showTip(evt, \`<strong>\${esc(p.r.bucket)}</strong><br/>Cumulative: \${p.r.total} (+\${p.r.delta})\`);
        });
        hit.addEventListener('mouseleave', hideTip);
        svg.appendChild(hit);
      }
    }
  }
  document.querySelectorAll('[data-activity]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-activity]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activityMode = btn.dataset.activity;
      renderActivity();
    });
  });

  // 3. Top Sources / Plugins Squircle Dock
  let selectedSourceFilter = null;
  function sourceShortLabel(src) {
    if (src.startsWith('plugin:')) return src.slice(7);
    return src;
  }
  function sourceMonogram(name) {
    const parts = name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  function renderDock() {
    const dock = document.getElementById('sources-dock');
    dock.innerHTML = '';
    const bySrc = new Map();
    for (const u of unified) {
      let g = bySrc.get(u.source);
      if (!g) { g = { source: u.source, activations: 0, skills: 0, tokens: 0 }; bySrc.set(u.source, g); }
      g.activations += u.activations;
      g.skills += 1;
      g.tokens += u.raw_tokens;
    }
    const items = [...bySrc.values()]
      .sort((a, b) => b.activations - a.activations || b.tokens - a.tokens)
      .slice(0, 8);

    if (items.length === 0) {
      dock.innerHTML = '<span class="brand-meta">No sources found.</span>';
      return;
    }

    for (const item of items) {
      const shortName = sourceShortLabel(item.source);
      const btn = document.createElement('button');
      btn.className = 'squircle-btn' + (selectedSourceFilter === item.source ? ' active' : '');
      btn.innerHTML = \`
        <div class="squircle-box">\${esc(sourceMonogram(shortName))}</div>
        <span class="squircle-lbl">\${esc(shortName)}</span>
      \`;
      btn.addEventListener('mousemove', (evt) => {
        showTip(evt, \`<strong>\${esc(item.source)}</strong><br/>Activations: \${item.activations}<br/>Skills: \${item.skills} · ~\${item.tokens.toLocaleString()} tok/sess\`);
      });
      btn.addEventListener('mouseleave', hideTip);
      btn.addEventListener('click', () => {
        if (selectedSourceFilter === item.source) {
          selectedSourceFilter = null;
          document.getElementById('filter-source').value = 'all';
        } else {
          selectedSourceFilter = item.source;
          document.getElementById('filter-source').value = item.source;
        }
        syncResetVisibility();
        renderDock();
        renderTable();
      });
      dock.appendChild(btn);
    }
  }

  // 4. Context Footprint Treemap
  function layoutTreemap(items, x, y, w, h) {
    if (items.length === 0 || w <= 0 || h <= 0) return [];
    if (items.length === 1) return [{ ...items[0], x, y, w, h }];
    const total = items.reduce((a, b) => a + b.value, 0) || 1;
    let half = 0;
    let split = 1;
    for (let i = 0; i < items.length - 1; i++) {
      half += items[i].value;
      split = i + 1;
      if (half >= total / 2) break;
    }
    const left = items.slice(0, split);
    const right = items.slice(split);
    const ratio = half / total;
    if (w >= h) {
      const w1 = w * ratio;
      return [...layoutTreemap(left, x, y, w1, h), ...layoutTreemap(right, x + w1, y, w - w1, h)];
    } else {
      const h1 = h * ratio;
      return [...layoutTreemap(left, x, y, w, h1), ...layoutTreemap(right, x, y + h1, w, h - h1)];
    }
  }

  let treemapMode = 'source';
  function fillForBlock(act) {
    if (!act || act <= 0) return 'var(--bloat-fill)';
    if (act <= 2) return 'var(--blue-1)';
    if (act <= 7) return 'var(--blue-2)';
    return 'var(--blue-3)';
  }
  function renderTreemap() {
    const svg = document.getElementById('svg-treemap');
    svg.innerHTML = '';
    let items;
    if (treemapMode === 'source') {
      const bySrc = new Map();
      for (const u of unified) {
        let g = bySrc.get(u.source);
        if (!g) { g = { label: u.source, source: u.source, value: 0, rawTokens: 0, activations: 0 }; bySrc.set(u.source, g); }
        g.value += u.est_tokens;
        g.rawTokens += u.raw_tokens;
        g.activations += u.activations;
      }
      items = [...bySrc.values()].sort((a, b) => b.value - a.value).slice(0, 32);
    } else {
      items = [...unified]
        .map((u) => ({ label: u.skill, source: u.source, value: u.est_tokens, rawTokens: u.raw_tokens, activations: u.activations }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 48);
    }

    document.getElementById('footprint-summary').textContent =
      \`Enabled: ~\${enabledTok.toLocaleString()} tok/session · Unused: ~\${unusedTok.toLocaleString()} (\${wastePct}%)\`;

    if (items.length === 0) {
      svg.appendChild(el('text', { x: 360, y: 110, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 13 }, 'No installed skills to visualize.'));
      return;
    }

    const rects = layoutTreemap(items, 0, 0, 720, 220);
    for (const r of rects) {
      const isBloat = !r.activations || r.activations <= 0;
      const g = el('g', { style: 'cursor:pointer' });
      g.appendChild(el('rect', {
        x: r.x + 1.5, y: r.y + 1.5,
        width: Math.max(0, r.w - 3), height: Math.max(0, r.h - 3),
        rx: 6,
        fill: fillForBlock(r.activations),
        stroke: isBloat ? 'var(--bloat-stroke)' : 'transparent',
        'stroke-width': 1
      }));

      if (r.w > 56 && r.h > 28) {
        const maxChars = Math.max(4, Math.floor((r.w - 14) / 6.8));
        const txt = r.label.length > maxChars ? r.label.slice(0, maxChars - 1) + '…' : r.label;
        g.appendChild(el('text', {
          x: r.x + 9, y: r.y + 19,
          fill: isBloat ? 'var(--muted)' : '#ffffff',
          'font-size': 11, 'font-weight': 500
        }, txt));
        if (r.h > 44) {
          const subTxt = isBloat ? \`~\${r.rawTokens} tok · 0 runs\` : \`~\${r.rawTokens} tok · \${r.activations}\`;
          g.appendChild(el('text', {
            x: r.x + 9, y: r.y + 34,
            fill: isBloat ? 'var(--dim)' : 'rgba(255,255,255,0.78)',
            'font-size': 10
          }, subTxt));
        }
      }

      g.addEventListener('mousemove', (evt) => {
        showTip(evt, \`<strong>\${esc(r.label)}</strong><br/>Source: \${esc(r.source)}<br/>Context: ~\${r.rawTokens.toLocaleString()} tok/session<br/>Activations: \${r.activations}\`);
      });
      g.addEventListener('mouseleave', hideTip);
      g.addEventListener('click', () => {
        if (treemapMode === 'source') {
          selectedSourceFilter = r.source;
          document.getElementById('filter-source').value = r.source;
        } else {
          document.getElementById('filter-search').value = r.label;
        }
        syncResetVisibility();
        renderDock();
        renderTable();
      });
      svg.appendChild(g);
    }
  }
  document.querySelectorAll('[data-treemap-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-treemap-mode]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      treemapMode = btn.dataset.treemapMode;
      renderTreemap();
    });
  });

  // 5. Insights Key-Value Ledger + Workflows + Pruning
  function topEntry(mapObj) {
    const entries = Object.entries(mapObj || {}).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return null;
    const sum = entries.reduce((a, b) => a + b[1], 0) || 1;
    return { name: entries[0][0], count: entries[0][1], pct: Math.round((entries[0][1] / sum) * 100) };
  }

  function renderInsights() {
    const autoR = totals.autoReads || 0;
    const manR = totals.manualReads || 0;
    const autoPct = autoR + manR > 0 ? Math.round((autoR / (autoR + manR)) * 100) : 0;
    const topHost = topEntry(totals.hosts);
    const topModel = topEntry(totals.models);
    const topChain = (chains.transitions || [])[0] || null;
    const ins = stats.insights || {};
    const projCands = ins.projectScopeCandidates || [];
    const manualOnly = ins.manualOnlySkills || [];
    const heavyBodies = ins.heavyBodySkills || [];
    const slowestSkills = ins.slowestSkills || [];
    const promptPatterns = ins.promptPatterns || [];
    const cachePct = tokStats.total > 0 ? Math.round((tokStats.cacheHitRate || 0) * 100) + '%' : '—';

    const overviewRows = [
      ['Prompt cache hit rate', cachePct],
      ['Active skill body tokens', '~' + fmtCompact(tokStats.activeBodyTokens || 0) + ' tok loaded'],
      ['Total time automated', fmtDuration(durStats.totalSeconds || 0)],
      ['Heavy SKILL.md bodies', heavyBodies.length + (heavyBodies.length === 1 ? ' skill' : ' skills')],
      ['Auto-discovery rate', autoPct + '% of runs'],
      ['Most active host', topHost ? \`\${topHost.name} · \${topHost.pct}%\` : '—'],
      ['Most used model', topModel ? \`\${topModel.name} · \${topModel.pct}%\` : '—'],
      ['Top workflow chain', topChain ? \`\${topChain.from} \u2192 \${topChain.to} (\${topChain.sessions}x)\` : 'Single-skill runs'],
      ['Reclaimable context tax', \`~\${unusedTok.toLocaleString()} tok/session · \${wastePct}%\`],
      ['Single-project global skills', projCands.length + (projCands.length === 1 ? ' candidate' : ' candidates')],
      ['Manual-only skills', String(manualOnly.length)],
      ['Skills explored', String(inv.used || 0)],
      ['Total skills used', String(totals.events || 0)],
      ['Total skills installed', String(inv.enabled || 0)],
    ];

    document.getElementById('panel-overview').innerHTML = overviewRows
      .map(([k, v]) => \`<div class="ledger-row"><span class="ledger-k">\${esc(k)}</span><span class="ledger-v">\${esc(v)}</span></div>\`)
      .join('');

    // Workflows SVG (#svg-chains)
    const svg = document.getElementById('svg-chains');
    svg.innerHTML = '';
    const transitions = (chains.transitions || []).slice(0, 7);
    if (transitions.length === 0) {
      svg.appendChild(el('text', { x: 360, y: 105, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 13 }, 'No multi-skill transitions recorded in this window.'));
    } else {
      const leftNodes = [...new Set(transitions.map((t) => t.from))];
      const rightNodes = [...new Set(transitions.map((t) => t.to))];
      const maxS = Math.max(1, ...transitions.map((t) => t.sessions));
      const yPos = (arr, name) => 20 + (arr.indexOf(name) * 165) / Math.max(1, arr.length - 1 || 1);

      for (const t of transitions) {
        const y1 = yPos(leftNodes, t.from) + 10;
        const y2 = yPos(rightNodes, t.to) + 10;
        const sw = Math.max(1.5, (t.sessions / maxS) * 6);
        const path = el('path', {
          d: \`M 190 \${y1} C 310 \${y1}, 410 \${y2}, 530 \${y2}\`,
          fill: 'none', stroke: 'var(--blue-3)', 'stroke-opacity': '0.45', 'stroke-width': sw
        });
        path.addEventListener('mousemove', (evt) => {
          showTip(evt, \`<strong>\${esc(t.from)} \u2192 \${esc(t.to)}</strong><br/>Sessions: \${t.sessions} (\${Math.round(t.probability * 100)}%)<br/>Avg gap: \${t.avgGapSeconds}s\`);
        });
        path.addEventListener('mouseleave', hideTip);
        svg.appendChild(path);
      }
      for (const name of leftNodes) {
        const y = yPos(leftNodes, name);
        svg.appendChild(el('rect', { x: 10, y, width: 180, height: 22, rx: 6, fill: 'var(--bg)', stroke: 'var(--border)' }));
        svg.appendChild(el('text', { x: 20, y: y + 15, fill: 'var(--text)', 'font-size': 11 }, name.length > 24 ? name.slice(0, 23) + '…' : name));
      }
      for (const name of rightNodes) {
        const y = yPos(rightNodes, name);
        svg.appendChild(el('rect', { x: 530, y, width: 180, height: 22, rx: 6, fill: 'var(--bg)', stroke: 'var(--border)' }));
        svg.appendChild(el('text', { x: 540, y: y + 15, fill: 'var(--text)', 'font-size': 11 }, name.length > 24 ? name.slice(0, 23) + '…' : name));
      }
    }

    const seqs = (chains.sequences || []).slice(0, 4);
    const pairs = (chains.pairs || []).slice(0, 4);
    const wfHtml = [];
    for (const s of seqs) {
      wfHtml.push(\`<div class="ledger-row"><span class="ledger-k">3-step sequence</span><span class="ledger-v mono">\${esc(s.label)} (\${s.sessions}x)</span></div>\`);
    }
    for (const p of pairs) {
      wfHtml.push(\`<div class="ledger-row"><span class="ledger-k">Co-occurring pair</span><span class="ledger-v">\${esc(p.skills[0])} + \${esc(p.skills[1])} · J=\${p.jaccard.toFixed(2)}</span></div>\`);
    }
    document.getElementById('workflows-ledger').innerHTML = wfHtml.join('');

    // Pruning panel
    const pruneRows = [];
    for (const g of (unused.bySource || [])) {
      const cmd = g.source.startsWith('plugin:') ? \`skilltally prune --plugin \${g.source.slice(7)}\` : '';
      pruneRows.push(\`
        <div class="rec-row">
          <div>
            <div><strong>\${esc(g.source)}</strong> · \${g.skillCount} unused skill(s)</div>
            <div class="rec-sub">Saves ~\${g.estTokens.toLocaleString()} tok/session (\${(g.descChars / 1024).toFixed(1)} KB)</div>
          </div>
          \${cmd ? \`<span class="code-pill">\${esc(cmd)}</span>\` : '<span class="brand-meta">personal</span>'}
        </div>
      \`);
    }
    for (const s of manualOnly.slice(0, 5)) {
      pruneRows.push(\`
        <div class="rec-row">
          <div>
            <div><strong>\${esc(s.skill)}</strong> · manual-only (\${s.reads} read(s))</div>
            <div class="rec-sub">0% auto-match — sharpen SKILL.md description</div>
          </div>
          <span class="brand-meta">~\${s.est_tokens} tok</span>
        </div>
      \`);
    }
    for (const c of projCands.slice(0, 5)) {
      pruneRows.push(\`
        <div class="rec-row">
          <div>
            <div><strong>\${esc(c.skill)}</strong> · single-project (\${esc(c.project)})</div>
            <div class="rec-sub">Move from \${esc(c.source)} to repo-local skills</div>
          </div>
          <span class="brand-meta">~\${c.est_tokens} tok</span>
        </div>
      \`);
    }
    for (const h of heavyBodies.slice(0, 5)) {
      pruneRows.push(\`
        <div class="rec-row">
          <div>
            <div><strong>\${esc(h.skill)}</strong> · heavy SKILL.md body</div>
            <div class="rec-sub">Split ~\${h.body_tokens.toLocaleString()} tok into references/ (\${h.activations} act)</div>
          </div>
          <span class="brand-meta">~\${h.body_tokens.toLocaleString()} tok/read</span>
        </div>
      \`);
    }
    for (const s of slowestSkills.slice(0, 5)) {
      pruneRows.push(\`
        <div class="rec-row">
          <div>
            <div><strong>\${esc(s.skill)}</strong> · longest/slowest task</div>
            <div class="rec-sub">Avg \${fmtDuration(s.avg_duration_seconds)} across \${s.activations} activation(s)</div>
          </div>
          <span class="brand-meta">\${fmtDuration(s.total_duration_seconds)} total</span>
        </div>
      \`);
    }
    for (const p of promptPatterns.slice(0, 5)) {
      pruneRows.push(\`
        <div class="rec-row">
          <div>
            <div><strong>"\${esc(p.prompt)}"</strong></div>
            <div class="rec-sub">Triggered: \${esc(p.skills.join(', '))}</div>
          </div>
          <span class="brand-meta">\${p.count}x</span>
        </div>
      \`);
    }
    document.getElementById('panel-pruning').innerHTML = pruneRows.length > 0
      ? pruneRows.join('')
      : '<div class="brand-meta">No pruning or optimization candidates detected.</div>';
  }

  document.querySelectorAll('[data-insights-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-insights-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.insightsTab;
      document.getElementById('panel-overview').classList.toggle('hidden', tab !== 'overview');
      document.getElementById('panel-workflows').classList.toggle('hidden', tab !== 'workflows');
      document.getElementById('panel-pruning').classList.toggle('hidden', tab !== 'pruning');
    });
  });

  // 6. Skills Directory Table
  const hostSet = new Set();
  const sourceSet = new Set();
  for (const u of unified) {
    for (const h of (u.hosts || [])) hostSet.add(h);
    if (u.source) sourceSet.add(u.source);
  }
  const hostSel = document.getElementById('filter-host');
  for (const h of [...hostSet].sort()) hostSel.appendChild(new Option(h, h));
  const srcSel = document.getElementById('filter-source');
  for (const s of [...sourceSet].sort()) srcSel.appendChild(new Option(s, s));

  let statusFilter = 'all';
  let sortKey = 'activations';
  let sortDir = -1;

  function syncResetVisibility() {
    const active =
      document.getElementById('filter-search').value.trim() !== '' ||
      statusFilter !== 'all' ||
      hostSel.value !== 'all' ||
      srcSel.value !== 'all';
    document.getElementById('btn-reset-filter').classList.toggle('hidden', !active);
  }

  function renderTable() {
    const q = document.getElementById('filter-search').value.trim().toLowerCase();
    const hf = hostSel.value;
    const sf = srcSel.value;

    const filtered = unified.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (hf !== 'all' && !(r.hosts || []).includes(hf)) return false;
      if (sf !== 'all' && r.source !== sf) return false;
      if (q && !r.skill.toLowerCase().includes(q) && !r.source.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir || b.raw_tokens - a.raw_tokens;
      return String(av).localeCompare(String(bv)) * sortDir;
    });

    document.getElementById('table-count').textContent = \`Showing \${filtered.length} of \${unified.length} skill(s)\`;
    document.getElementById('skills-tbody').innerHTML = filtered.slice(0, 250).map((r) => \`
      <tr>
        <td><span class="status-dot \${r.status}"></span>\${esc(r.skill)}</td>
        <td class="mono" style="color:var(--muted)">\${esc(r.source)}</td>
        <td class="num">\${r.activations}</td>
        <td class="num" style="color:var(--muted)">\${r.reads}</td>
        <td class="num" style="color:var(--muted)">~\${r.raw_tokens.toLocaleString()}</td>
        <td class="num" style="color:var(--muted)">\${r.reads > 0 ? Math.round(r.manualRatio * 100) + '%' : '—'}</td>
        <td class="mono" style="color:var(--muted)">\${esc(r.sparkline)}</td>
        <td style="color:var(--muted)">\${esc((r.hosts || []).join(', '))}</td>
      </tr>
    \`).join('');
  }

  document.querySelectorAll('[data-status-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-status-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      statusFilter = btn.dataset.statusTab;
      syncResetVisibility();
      renderTable();
    });
  });

  ['filter-search', 'filter-host', 'filter-source'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      if (id === 'filter-source') {
        selectedSourceFilter = srcSel.value === 'all' ? null : srcSel.value;
        renderDock();
      }
      syncResetVisibility();
      renderTable();
    });
    document.getElementById(id).addEventListener('change', () => {
      if (id === 'filter-source') {
        selectedSourceFilter = srcSel.value === 'all' ? null : srcSel.value;
        renderDock();
      }
      syncResetVisibility();
      renderTable();
    });
  });

  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (sortKey === k) sortDir *= -1;
      else { sortKey = k; sortDir = k === 'skill' || k === 'source' ? 1 : -1; }
      renderTable();
    });
  });

  document.getElementById('btn-reset-filter').addEventListener('click', () => {
    document.getElementById('filter-search').value = '';
    statusFilter = 'all';
    document.querySelectorAll('[data-status-tab]').forEach((b) => b.classList.toggle('active', b.dataset.statusTab === 'all'));
    hostSel.value = 'all';
    srcSel.value = 'all';
    selectedSourceFilter = null;
    syncResetVisibility();
    renderDock();
    renderTable();
  });

  // 7. Mermaid generator
  function buildMermaid(kind) {
    if (kind === 'pie') {
      const groups = (unused.bySource || []).slice(0, 8);
      if (groups.length === 0) return 'pie title Unused Context Tax (tokens/session)\\n    "All skills active" : 1';
      return 'pie title Unused Context Tax (~tokens/session)\\n' +
        groups.map((g) => \`    "\${g.source}" : \${Math.max(1, g.estTokens)}\`).join('\\n');
    }
    if (kind === 'timeline') {
      const rows = (timeline.rows || []).slice(-14);
      if (rows.length === 0) return 'xychart-beta\\n    title "Skill Activations"\\n    x-axis ["none"]\\n    bar [0]';
      const xs = rows.map((r) => \`"\${r.bucket}"\`).join(', ');
      const ys = rows.map((r) => r.activations).join(', ');
      return \`xychart-beta\\n    title "Skill Activations (\${timeline.by || 'day'})"\\n    x-axis [\${xs}]\\n    y-axis "Activations"\\n    bar [\${ys}]\`;
    }
    const trans = (chains.transitions || []).slice(0, 10);
    if (trans.length === 0) return 'flowchart LR\\n    A[No multi-skill chains recorded]';
    const sanitize = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
    return 'flowchart LR\\n' + trans.map((t) =>
      \`    \${sanitize(t.from)}["\${t.from}"] -->|\${t.sessions}x| \${sanitize(t.to)}["\${t.to}"]\`
    ).join('\\n');
  }

  const dialog = document.getElementById('mermaid-dialog');
  let mermaidKind = 'pie';
  const updateMermaid = () => {
    document.getElementById('mermaid-code').textContent = buildMermaid(mermaidKind);
  };
  document.getElementById('btn-mermaid').addEventListener('click', () => {
    updateMermaid();
    dialog.showModal();
  });
  document.getElementById('btn-close-mermaid').addEventListener('click', () => dialog.close());
  document.querySelectorAll('[data-mermaid]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-mermaid]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      mermaidKind = btn.dataset.mermaid;
      updateMermaid();
    });
  });
  document.getElementById('btn-copy-mermaid').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById('mermaid-code').textContent);
      document.getElementById('btn-copy-mermaid').textContent = 'Copied';
      setTimeout(() => { document.getElementById('btn-copy-mermaid').textContent = 'Copy Snippet'; }, 1500);
    } catch {}
  });

  renderActivity();
  renderDock();
  renderTreemap();
  renderInsights();
  renderTable();
})();
</script>
</body>
</html>
`;
}
