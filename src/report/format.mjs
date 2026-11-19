function padRight(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function padLeft(str, len) {
  const s = String(str);
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

function formatDateCompact(iso) {
  if (!iso) return '—';
  return String(iso).slice(0, 16).replace('T', ' ');
}

function formatWindow(win) {
  if (!win.from) return `all time (up to ${win.to})`;
  return `last ${win.since} (${win.from} -> ${win.to})`;
}

function formatHostLine(hosts) {
  const entries = Object.entries(hosts || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return 'none';
  return entries.map(([h, n]) => `${h} ${n}`).join(' · ');
}

export function renderMeter(ratio, width = 16) {
  const r = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const filled = Math.round(r * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

export function formatStats(report, { limit = null, heading = 'skilltally', bySource = false } = {}) {
  const lines = [];
  lines.push(`${heading} — ${formatWindow(report.window)}`);
  lines.push(`hosts: ${formatHostLine(report.totals.hosts)}`);
  if (
    report.totals?.via &&
    Object.keys(report.totals.via).length > 0 &&
    ((report.totals.autoReads || 0) > 0 || (report.totals.manualReads || 0) > 0)
  ) {
    lines.push(
      `triggers: auto ${report.totals.autoReads || 0} · manual ${report.totals.manualReads || 0}`
    );
  }
  lines.push('');

  const displayRows = limit && limit > 0 ? report.rows.slice(0, limit) : report.rows;
  if (displayRows.length === 0) {
    lines.push('No skill events found in this window.');
    lines.push('Tip: run `skilltally backfill` to import historical sessions.');
  } else {
    const skillCol = Math.max(
      10,
      ...displayRows.map((r) => (bySource ? `${r.skill} (${r.source})` : r.skill).length)
    );
    const hostsCol = Math.max(5, ...displayRows.map((r) => (r.hosts || []).join(', ').length));
    const rankW = Math.max(2, String(displayRows.length).length + 1);
    lines.push(
      ` ${padLeft('#', rankW)}  ${padRight('skill', skillCol)}  ${padLeft('activations', 11)}  ${padLeft('reads', 5)}  ${padRight('last used', 16)}  ${padRight('hosts', hostsCol)}  trend (14d)`
    );
    displayRows.forEach((r, idx) => {
      const label = bySource ? `${r.skill} (${r.source})` : r.skill;
      lines.push(
        ` ${padLeft(idx + 1, rankW)}  ${padRight(label, skillCol)}  ${padLeft(r.activations, 11)}  ${padLeft(r.reads, 5)}  ${padRight(formatDateCompact(r.last_used), 16)}  ${padRight((r.hosts || []).join(', '), hostsCol)}  ${r.sparkline || '··············'}`
      );
    });
    if (limit && report.rows.length > limit) {
      lines.push(` ... and ${report.rows.length - limit} more skills`);
    }
  }

  if (report.inventory.enabled > 0 || report.inventory.disabled > 0) {
    lines.push('');
    const dis = report.inventory.disabled > 0 ? ` (${report.inventory.disabled} disabled)` : '';
    lines.push(
      `installed: ${report.inventory.enabled}${dis} · used: ${report.inventory.used} · unused: ${report.inventory.unused}  ->  run \`skilltally unused\``
    );
  }

  return lines.join('\n');
}

export function formatUnused(report, { showAll = false } = {}) {
  const lines = [];
  const u = report.unused;
  const kb = (u.totalDescChars / 1024).toFixed(1);
  lines.push(
    `Unused enabled skills — ${formatWindow(report.window)}: ${u.total} (${kb} KB ≈ ~${u.totalEstTokens.toLocaleString()} tok/session)`
  );
  if ((report.inventory?.enabledEstTokens || 0) > 0) {
    const ratio = u.totalEstTokens / report.inventory.enabledEstTokens;
    const pct = Math.round(ratio * 100);
    lines.push(
      `context tax: [${renderMeter(ratio, 16)}] ${pct}% unused (~${u.totalEstTokens.toLocaleString()} / ~${report.inventory.enabledEstTokens.toLocaleString()} tok/session)`
    );
  }

  if (u.total === 0) {
    lines.push('All enabled installed skills were used in this window.');
    return lines.join('\n');
  }

  lines.push('');
  const srcCol = Math.max(12, ...u.bySource.map((g) => g.source.length));
  for (const g of u.bySource) {
    const gKb = (g.descChars / 1024).toFixed(1);
    const header = `${padRight(g.source, srcCol)}  ${padLeft(g.skillCount, 3)} skills  ${padLeft(gKb + ' KB', 8)}  ~${padLeft(g.estTokens, 5)} tok/session`;
    const names = g.skills.map((s) => s.name);
    const preview = showAll || names.length <= 6 ? names.join(', ') : `${names.slice(0, 6).join(', ')}, … (+${names.length - 6})`;
    lines.push(`  ${header}`);
    lines.push(`    ${preview}`);
  }

  lines.push('');
  lines.push('Tip: disabling an unused plugin removes all of its skill descriptions from every session context.');
  return lines.join('\n');
}

export function formatInventory(inventory) {
  const lines = [];
  const enabled = inventory.skills.filter((s) => s.enabled);
  const disabled = inventory.skills.filter((s) => !s.enabled);
  const totalTok = enabled.reduce((acc, s) => acc + s.est_tokens, 0);
  const totalKb = (enabled.reduce((acc, s) => acc + s.desc_chars, 0) / 1024).toFixed(1);

  lines.push(
    `Installed skills: ${enabled.length} enabled (${totalKb} KB ≈ ~${totalTok.toLocaleString()} tok/session), ${disabled.length} disabled`
  );
  lines.push('');

  const bySrc = new Map();
  for (const s of inventory.skills) {
    let g = bySrc.get(s.source);
    if (!g) {
      g = { source: s.source, enabled: 0, disabled: 0, tokens: 0, hosts: new Set() };
      bySrc.set(s.source, g);
    }
    if (s.enabled) {
      g.enabled += 1;
      g.tokens += s.est_tokens;
    } else {
      g.disabled += 1;
    }
    for (const h of s.hosts) g.hosts.add(h);
  }

  const rows = [...bySrc.values()].sort((a, b) => b.tokens - a.tokens || b.enabled - a.enabled);
  const srcW = Math.max(10, ...rows.map((r) => r.source.length));
  lines.push(`  ${padRight('source', srcW)}  ${padLeft('enabled', 7)}  ${padLeft('disabled', 8)}  ${padLeft('~tokens', 8)}  hosts`);
  for (const r of rows) {
    lines.push(
      `  ${padRight(r.source, srcW)}  ${padLeft(r.enabled, 7)}  ${padLeft(r.disabled, 8)}  ${padLeft(r.tokens, 8)}  ${[...r.hosts].sort().join(', ')}`
    );
  }
  return lines.join('\n');
}

export function formatBackfill(summary) {
  const lines = [];
  lines.push(
    `Backfill ${summary.dryRun ? '(dry-run) ' : ''}complete: ${summary.totalEvents} events across ${summary.uniqueSkills} skills`
  );
  for (const [host, h] of Object.entries(summary.hosts)) {
    const zstNote = h.skippedZst ? ` (${h.skippedZst} .zst skipped)` : '';
    lines.push(`  ${padRight(host, 12)} files: ${padLeft(h.files, 4)}  events: ${padLeft(h.events, 4)}  skills: ${padLeft(h.uniqueSkills, 3)}${zstNote}`);
  }
  if (summary.outputPath) {
    lines.push(`Written to: ${summary.outputPath}`);
  }
  return lines.join('\n');
}

export function formatInstall(res) {
  const lines = [];
  lines.push(`skilltally install${res.dryRun ? ' (dry-run)' : ''}`);
  lines.push('');
  for (const r of res.results) {
    const detail = r.reason || r.target || '';
    lines.push(`  ${padRight(r.host, 12)} ${padRight(r.status, 14)} ${detail}`.trimEnd());
    if (r.backup) lines.push(`               backup: ${r.backup}`);
    if (r.note) lines.push(`               note: ${r.note}`);
  }
  return lines.join('\n');
}

export function formatUninstall(res) {
  const lines = [];
  lines.push(`skilltally uninstall${res.dryRun ? ' (dry-run)' : ''}`);
  lines.push('');
  for (const r of res.results) {
    const detail = r.target || '';
    lines.push(`  ${padRight(r.host, 12)} ${padRight(r.status, 14)} ${detail}`.trimEnd());
    if (r.backup) lines.push(`               backup: ${r.backup}`);
  }
  if (res.purgeRequested) {
    lines.push(
      res.purged
        ? `  data         ${res.dryRun ? 'would_remove' : 'purged'}         ${res.dataHome}`
        : `  data         not_found      ${res.dataHome}`
    );
  }
  return lines.join('\n');
}

export function formatDoctor(report) {
  const lines = [];
  lines.push(`skilltally doctor — ${report.ok ? 'OK' : 'ISSUES FOUND'}`);
  lines.push('');
  lines.push(
    `  node         ${report.node.ok ? 'ok' : 'fail'}  v${report.node.version} (zstd native: ${report.node.zstdNative ? 'yes' : 'no'})`
  );
  lines.push(
    `  self-test    ${report.selfTest.ok ? 'ok' : 'fail'}${report.selfTest.error ? `  ${report.selfTest.error}` : ''}`
  );
  lines.push(
    `  events       ${report.events.total} total (${report.events.hook} hook, ${report.events.backfill} backfill, ${report.events.corruptLines} corrupt)${report.events.latestTs ? ` · latest ${formatDateCompact(report.events.latestTs)}` : ''}`
  );
  lines.push('');
  lines.push('Hosts:');
  for (const [name, h] of Object.entries(report.hosts)) {
    const status = !h.detected
      ? 'not_detected'
      : h.hookPathValid === false
        ? 'broken_path'
        : h.installed
          ? h.disabled
            ? 'disabled'
            : 'active'
          : 'not_installed';
    const extras = [];
    if (h.mode && h.mode !== 'none') extras.push(`mode=${h.mode}`);
    if (h.pluginInstalled) extras.push('plugin=yes');
    if (h.settingsInstalled) extras.push('settings=yes');
    if (h.hooksJsonInstalled) extras.push('hooks.json=yes');
    if (h.trustStatus && h.trustStatus !== 'unknown') extras.push(`trust=${h.trustStatus}`);
    if (h.hooksConfigDisabled) extras.push('WARNING: hooksConfig.enabled=false');
    if (h.duplicateHook) extras.push('WARNING: duplicate hook');
    if (h.hookPathValid === false) extras.push('ERROR: hook target missing on disk');
    lines.push(
      `  ${padRight(name, 12)} ${padRight(status, 14)} ${extras.join(' · ')}`.trimEnd()
    );
  }
  return lines.join('\n');
}

export function formatTimeline(timeline) {
  const lines = [];
  const label = timeline.skill ? `skilltally timeline (${timeline.skill})` : 'skilltally timeline';
  lines.push(`${label} — by ${timeline.by}, ${formatWindow(timeline.window)}`);
  lines.push('');

  if (timeline.rows.length === 0) {
    lines.push('No skill events found in this window.');
    return lines.join('\n');
  }

  const maxAct = Math.max(1, ...timeline.rows.map((r) => r.activations));
  const bucketW = Math.max(10, ...timeline.rows.map((r) => r.bucket.length));
  const barWidth = 24;

  lines.push(
    `  ${padRight('period', bucketW)}  ${padRight('bar', barWidth)}  ${padLeft('activations', 11)}  ${padLeft('reads', 5)}  ${padLeft('skills', 6)}`
  );
  for (const r of timeline.rows) {
    const filled = Math.max(1, Math.round((r.activations / maxAct) * barWidth));
    const bar = '#'.repeat(filled);
    lines.push(
      `  ${padRight(r.bucket, bucketW)}  ${padRight(bar, barWidth)}  ${padLeft(r.activations, 11)}  ${padLeft(r.reads, 5)}  ${padLeft(r.uniqueSkills, 6)}`
    );
  }
  lines.push('');
  lines.push(
    `totals: ${timeline.totals.activations} activations · ${timeline.totals.reads} reads across ${timeline.totals.buckets} ${timeline.by}(s)`
  );
  return lines.join('\n');
}

export function formatDebug(status) {
  const lines = [];
  lines.push(`skilltally debug: ${status.enabled ? 'on' : 'off'}`);
  lines.push(`  marker: ${status.markerPath}`);
  lines.push(
    `  log:    ${status.logPath} (${status.logExists ? `${status.logLines} lines, ${status.logBytes} bytes` : 'absent'})`
  );
  if (status.deletedLog) {
    lines.push('  cleaned: removed debug.jsonl');
  }
  if (status.enabled) {
    lines.push('');
    lines.push('Warning: debug mode logs raw hook stdin payloads (may include shell commands). Run `skilltally debug off` when done.');
  }
  return lines.join('\n');
}

function formatGapSeconds(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

export function formatChains(chainsReport) {
  const lines = [];
  lines.push(`skilltally chains — ${formatWindow(chainsReport.window)}`);
  lines.push(
    `sessions: ${chainsReport.totals.sessions} · multi-skill: ${chainsReport.totals.multiSkillSessions} · transitions: ${chainsReport.totals.transitions} · pairs: ${chainsReport.totals.pairs}`
  );
  lines.push('');

  if (
    chainsReport.transitions.length === 0 &&
    chainsReport.pairs.length === 0 &&
    chainsReport.sequences.length === 0
  ) {
    lines.push('No multi-skill session chains found in this window.');
    return lines.join('\n');
  }

  if (chainsReport.transitions.length > 0) {
    lines.push('Top ordered transitions (A -> B):');
    const labels = chainsReport.transitions.map((t) => `${t.from} -> ${t.to}`);
    const labelW = Math.max(16, ...labels.map((l) => l.length));
    lines.push(
      `  ${padRight('transition', labelW)}  ${padLeft('sessions', 8)}  ${padLeft('prob', 6)}  ${padLeft('avg gap', 8)}`
    );
    for (let i = 0; i < chainsReport.transitions.length; i++) {
      const t = chainsReport.transitions[i];
      const pct = `${Math.round((t.probability || 0) * 100)}%`;
      lines.push(
        `  ${padRight(labels[i], labelW)}  ${padLeft(t.sessions, 8)}  ${padLeft(pct, 6)}  ${padLeft(formatGapSeconds(t.avgGapSeconds), 8)}`
      );
    }
    lines.push('');
  }

  if (chainsReport.pairs.length > 0) {
    lines.push('Top co-occurring pairs (same session):');
    const pairLabels = chainsReport.pairs.map((p) => `${p.skills[0]} + ${p.skills[1]}`);
    const pairW = Math.max(16, ...pairLabels.map((l) => l.length));
    lines.push(`  ${padRight('pair', pairW)}  ${padLeft('sessions', 8)}  ${padLeft('jaccard', 7)}`);
    for (let i = 0; i < chainsReport.pairs.length; i++) {
      const p = chainsReport.pairs[i];
      lines.push(
        `  ${padRight(pairLabels[i], pairW)}  ${padLeft(p.sessions, 8)}  ${padLeft(p.jaccard.toFixed(2), 7)}`
      );
    }
    lines.push('');
  }

  if (chainsReport.sequences.length > 0) {
    lines.push('Common 3-step workflows:');
    const seqW = Math.max(20, ...chainsReport.sequences.map((s) => s.label.length));
    for (const s of chainsReport.sequences) {
      lines.push(`  ${padRight(s.label, seqW)}  ${padLeft(s.sessions, 3)} session(s)`);
    }
  }

  return lines.join('\n').trimEnd();
}

export function formatInsights(report) {
  const lines = [];
  lines.push(`skilltally insights — ${formatWindow(report.window)}`);
  lines.push(
    `hosts: ${formatHostLine(report.totals.hosts)} · sessions: ${report.totals.sessions || 0} · skills used: ${report.totals.uniqueSkills || 0}`
  );
  lines.push('');

  // 1. Context Tax & ROI Efficiency
  lines.push('1. Context Tax & ROI Efficiency');
  const enabledTok = report.inventory?.enabledEstTokens || 0;
  const unusedTok = report.unused?.totalEstTokens || 0;
  if (enabledTok > 0) {
    const ratio = unusedTok / enabledTok;
    const pct = Math.round(ratio * 100);
    lines.push(
      `  context tax: [${renderMeter(ratio, 18)}] ${pct}% unused (~${unusedTok.toLocaleString()} / ~${enabledTok.toLocaleString()} tok/session)`
    );
  } else {
    lines.push('  No enabled skill inventory descriptions found.');
  }

  const highCost = report.insights?.highCostSkills || [];
  if (highCost.length > 0) {
    const w = Math.max(12, ...highCost.map((s) => s.skill.length));
    lines.push('  Highest cumulative context cost per activation:');
    for (const s of highCost.slice(0, 6)) {
      lines.push(
        `    ${padRight(s.skill, w)}  ~${padLeft(s.est_tokens, 4)} tok/sess  ${padLeft(s.activations, 4)} act  ~${s.tokenCostPerActivation.toLocaleString()} tok/activation`
      );
    }
  }
  lines.push('');

  // 2. Trigger Mode Breakdown (via)
  lines.push('2. Trigger Mode Breakdown (via)');
  const autoReads = report.totals?.autoReads || 0;
  const manualReads = report.totals?.manualReads || 0;
  const totalReads = autoReads + manualReads;
  if (totalReads > 0) {
    const autoPct = Math.round((autoReads / totalReads) * 100);
    const manualPct = 100 - autoPct;
    lines.push(`  auto: ${autoReads} (${autoPct}%) · manual: ${manualReads} (${manualPct}%)`);
    const viaEntries = Object.entries(report.totals.via || {}).sort((a, b) => b[1] - a[1]);
    if (viaEntries.length > 0) {
      lines.push(`  via breakdown: ${viaEntries.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    }
  } else {
    lines.push('  No trigger events recorded in this window.');
  }

  const manualOnly = report.insights?.manualOnlySkills || [];
  if (manualOnly.length > 0) {
    lines.push('  Manual-only skills (0% auto-match — review SKILL.md description triggers):');
    for (const s of manualOnly.slice(0, 8)) {
      lines.push(
        `    ${s.skill} (${s.source}) — ${s.reads} read(s), ~${s.est_tokens} tok/session`
      );
    }
  }
  lines.push('');

  // 3. Project-Scoping Candidates
  lines.push('3. Project-Scoping Candidates');
  const projCand = report.insights?.projectScopeCandidates || [];
  if (projCand.length > 0) {
    lines.push('  Global/plugin skills used in only 1 project (consider moving to repo .agents/skills or .claude/skills):');
    for (const c of projCand.slice(0, 8)) {
      lines.push(
        `    ${c.skill} (${c.source}) -> only in "${c.project}" (${c.activations} act, ~${c.est_tokens} tok/session)`
      );
    }
  } else {
    lines.push('  None detected (skills are either multi-project or already project-scoped).');
  }

  // 4. Model Breakdown
  const modelEntries = Object.entries(report.totals?.models || {}).sort((a, b) => b[1] - a[1]);
  if (modelEntries.length > 0) {
    lines.push('');
    lines.push('4. Model Breakdown');
    const mw = Math.max(12, ...modelEntries.map(([m]) => m.length));
    for (const [model, count] of modelEntries) {
      lines.push(`  ${padRight(model, mw)}  ${padLeft(count, 5)} read(s)`);
    }
  }

  return lines.join('\n');
}

export function formatPrune(res) {
  const lines = [];
  lines.push(`skilltally prune${res.dryRun ? ' (dry-run)' : ''} — ${formatWindow(res.window)}`);
  lines.push(
    `estimated savings: ${res.savedKb} KB (~${(res.savedTokensPerSession || 0).toLocaleString()} tok/session)`
  );
  lines.push('');

  if (res.disabledPlugins.length === 0 && res.disabledSkills.length === 0) {
    lines.push('No matching unused plugins or skills to disable.');
    return lines.join('\n');
  }

  if (res.disabledPlugins.length > 0) {
    lines.push(res.dryRun ? 'Plugins to disable:' : 'Disabled plugins:');
    for (const p of res.disabledPlugins) {
      lines.push(
        `  ${padRight(p.source, 28)} [${p.host}]  ${p.skillCount} skill(s)  ~${p.estTokens} tok/session`
      );
    }
    lines.push('');
  }

  if (res.disabledSkills.length > 0) {
    lines.push(res.dryRun ? 'Skills to disable:' : 'Disabled skills:');
    for (const s of res.disabledSkills) {
      lines.push(`  ${padRight(s.name, 28)} [${s.host}]  ~${s.est_tokens} tok/session`);
    }
    lines.push('');
  }

  if (res.backups && res.backups.length > 0) {
    lines.push('Backups:');
    for (const b of res.backups) {
      lines.push(`  ${b}`);
    }
  }

  return lines.join('\n').trimEnd();
}
