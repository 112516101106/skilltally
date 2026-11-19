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

export function formatStats(report, { limit = null, heading = 'skilltally', bySource = false } = {}) {
  const lines = [];
  lines.push(`${heading} — ${formatWindow(report.window)}`);
  lines.push(`hosts: ${formatHostLine(report.totals.hosts)}`);
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
    const rankW = Math.max(2, String(displayRows.length).length + 1);
    lines.push(
      ` ${padLeft('#', rankW)}  ${padRight('skill', skillCol)}  ${padLeft('activations', 11)}  ${padLeft('reads', 5)}  ${padRight('last used', 16)}  hosts`
    );
    displayRows.forEach((r, idx) => {
      const label = bySource ? `${r.skill} (${r.source})` : r.skill;
      lines.push(
        ` ${padLeft(idx + 1, rankW)}  ${padRight(label, skillCol)}  ${padLeft(r.activations, 11)}  ${padLeft(r.reads, 5)}  ${padRight(formatDateCompact(r.last_used), 16)}  ${r.hosts.join(', ')}`
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
