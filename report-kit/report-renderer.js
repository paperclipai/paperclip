/**
 * report-renderer.js — Fable-5-quality report renderer
 *
 * ES module. Call renderReport(data) with an object matching
 * report-data.schema.json to get a complete HTML document string.
 *
 * The output uses the warm parchment design system with botanical
 * SVG status indicators, metric cards, tables, manifest ledger,
 * and guardrail footer.
 *
 * Usage:
 *   import { renderReport } from './report-renderer.js';
 *   const html = renderReport(reportData);
 *   document.body.innerHTML = html;  // or write to file
 */

/* ── Botanical SVG status indicators ────────────────────────────── */

const STATUS_ICONS = {
  healthy: `<svg class="status-icon status-healthy" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M9 12l2 2 4-4" stroke="#2e7d32"/></svg>`,
  warning: `<svg class="status-icon status-warning" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13" stroke="#f57c00"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="#f57c00"/></svg>`,
  critical: `<svg class="status-icon status-critical" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" stroke="#c62828"/><line x1="15" y1="9" x2="9" y2="15" stroke="#c62828"/><line x1="9" y1="9" x2="15" y2="15" stroke="#c62828"/></svg>`,
  unknown: `<svg class="status-icon status-unknown" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" stroke="#9e9e9e"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" stroke="#9e9e9e"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="#9e9e9e"/></svg>`
};

const STATUS_COLORS = {
  healthy: '#2e7d32',
  warning: '#f57c00',
  critical: '#c62828',
  unknown: '#9e9e9e'
};

/* ── Inline styles (warm parchment design system) ─────────────── */

const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

  :root {
    --bg-page: #f5f0e8;
    --bg-card: #faf7f0;
    --bg-surface: #ffffff;
    --text-primary: #2c2416;
    --text-secondary: #6b5d4a;
    --text-muted: #9a8b78;
    --border: #e0d6c4;
    --border-light: #ede5d6;
    --accent: #7a6b4e;
    --accent-light: #e8dfce;
    --shadow: 0 1px 3px rgba(44, 36, 22, 0.08), 0 1px 2px rgba(44, 36, 22, 0.06);
    --shadow-lg: 0 4px 12px rgba(44, 36, 22, 0.1);
    --radius: 8px;
    --radius-sm: 4px;
    --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--font-sans);
    background: var(--bg-page);
    color: var(--text-primary);
    line-height: 1.6;
    padding: 40px 24px;
  }

  .report-container {
    max-width: 960px;
    margin: 0 auto;
  }

  /* ── Header ── */
  .report-header {
    margin-bottom: 32px;
    padding-bottom: 20px;
    border-bottom: 2px solid var(--border);
  }
  .report-header h1 {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.02em;
  }
  .report-header .subtitle {
    font-size: 15px;
    color: var(--text-secondary);
    margin-top: 4px;
  }
  .report-header .timestamp {
    font-size: 13px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    margin-top: 8px;
  }

  /* ── Metric cards ── */
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 32px;
  }
  .metric-card {
    background: var(--bg-card);
    border: 1px solid var(--border-light);
    border-radius: var(--radius);
    padding: 20px;
    box-shadow: var(--shadow);
    transition: box-shadow 0.15s ease;
  }
  .metric-card:hover {
    box-shadow: var(--shadow-lg);
  }
  .metric-card .metric-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .metric-card .metric-label {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }
  .metric-card .metric-value {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-primary);
    line-height: 1.2;
  }
  .metric-card .metric-detail {
    font-size: 13px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  .status-icon {
    flex-shrink: 0;
  }

  /* ── Sections ── */
  .report-section {
    background: var(--bg-surface);
    border: 1px solid var(--border-light);
    border-radius: var(--radius);
    padding: 24px;
    margin-bottom: 20px;
    box-shadow: var(--shadow);
  }
  .report-section h2 {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 4px;
  }
  .report-section .section-desc {
    font-size: 14px;
    color: var(--text-secondary);
    margin-bottom: 16px;
  }

  /* ── Tables ── */
  .report-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  .report-table thead th {
    text-align: left;
    padding: 10px 12px;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
    border-bottom: 2px solid var(--border);
    background: var(--bg-page);
  }
  .report-table tbody td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-light);
    color: var(--text-primary);
  }
  .report-table tbody tr:last-child td {
    border-bottom: none;
  }
  .report-table tbody tr:hover {
    background: #faf7f0;
  }
  .report-table .cell-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .report-table .cell-status .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }

  /* ── List ── */
  .report-list {
    list-style: none;
    padding: 0;
  }
  .report-list li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border-light);
    font-size: 14px;
  }
  .report-list li:last-child {
    border-bottom: none;
  }
  .report-list .list-label {
    color: var(--text-secondary);
    min-width: 120px;
  }
  .report-list .list-value {
    font-weight: 500;
  }

  /* ── Text ── */
  .report-text {
    font-size: 14px;
    line-height: 1.7;
    color: var(--text-primary);
  }
  .report-text p {
    margin-bottom: 12px;
  }
  .report-text p:last-child {
    margin-bottom: 0;
  }

  /* ── Manifest ledger ── */
  .manifest-ledger {
    background: var(--bg-card);
    border: 1px solid var(--border-light);
    border-radius: var(--radius);
    padding: 16px 20px;
    margin-bottom: 20px;
    display: flex;
    flex-wrap: wrap;
    gap: 24px;
    font-size: 13px;
  }
  .manifest-ledger .ledger-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .manifest-ledger .ledger-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  .manifest-ledger .ledger-value {
    font-family: var(--font-mono);
    color: var(--text-primary);
    font-weight: 500;
  }

  /* ── Guardrail footer ── */
  .guardrail-footer {
    border-top: 1px solid var(--border);
    padding-top: 16px;
    margin-top: 8px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .guardrail-footer .guardrail-version {
    font-family: var(--font-mono);
    font-weight: 500;
  }
  .guardrail-footer .guardrail-notes {
    font-style: italic;
  }

  /* ── Responsive ── */
  @media (max-width: 640px) {
    body { padding: 20px 12px; }
    .metrics-grid { grid-template-columns: 1fr 1fr; }
    .report-section { padding: 16px; }
    .manifest-ledger { flex-direction: column; gap: 12px; }
    .guardrail-footer { flex-direction: column; align-items: flex-start; }
  }
`;

/* ── Helpers ──────────────────────────────────────────────────── */

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCellValue(cell) {
  if (typeof cell === 'object' && cell !== null && cell.value !== undefined) {
    const color = STATUS_COLORS[cell.status] || STATUS_COLORS.unknown;
    return `<span class="cell-status"><span class="status-dot" style="background:${color}"></span>${escapeHtml(cell.value)}</span>`;
  }
  return escapeHtml(cell);
}

function renderStatusIcon(status) {
  return STATUS_ICONS[status] || STATUS_ICONS.unknown;
}

/* ── Section renderers ─────────────────────────────────────────── */

function renderTableSection(section) {
  const thead = section.headers
    ? `<thead><tr>${section.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`
    : '';
  const tbody = section.rows
    ? `<tbody>${section.rows.map(row => {
        const cells = Array.isArray(row) ? row : [];
        return `<tr>${cells.map(cell => `<td>${renderCellValue(cell)}</td>`).join('')}</tr>`;
      }).join('')}</tbody>`
    : '';
  return `<table class="report-table">${thead}${tbody}</table>`;
}

function renderListSection(section) {
  if (!section.items) return '';
  return `<ul class="report-list">${section.items.map(item =>
    `<li>${renderStatusIcon(item.status)}<span class="list-label">${escapeHtml(item.label)}</span><span class="list-value">${escapeHtml(item.value)}</span></li>`
  ).join('')}</ul>`;
}

function renderTextSection(section) {
  const paragraphs = (section.body || '').split('\n\n').filter(Boolean);
  return `<div class="report-text">${paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('')}</div>`;
}

function renderMetricsGridSection(section) {
  if (!section.items) return '';
  return `<div class="metrics-grid">${section.items.map(item =>
    `<div class="metric-card">
      <div class="metric-header">
        ${renderStatusIcon(item.status)}
        <span class="metric-label">${escapeHtml(item.label)}</span>
      </div>
      <div class="metric-value">${escapeHtml(item.value)}</div>
    </div>`
  ).join('')}</div>`;
}

const SECTION_RENDERERS = {
  table: renderTableSection,
  list: renderListSection,
  text: renderTextSection,
  'metrics-grid': renderMetricsGridSection
};

/* ── Main render function ─────────────────────────────────────── */

export function renderReport(data) {
  const title = escapeHtml(data.title);
  const subtitle = data.subtitle ? escapeHtml(data.subtitle) : '';
  const ts = data.generatedAt ? new Date(data.generatedAt).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short'
  }) : '';

  /* Metric cards */
  const metricsHtml = data.metrics?.length
    ? `<div class="metrics-grid">${data.metrics.map(m =>
        `<div class="metric-card">
          <div class="metric-header">
            ${renderStatusIcon(m.status)}
            <span class="metric-label">${escapeHtml(m.label)}</span>
          </div>
          <div class="metric-value">${escapeHtml(m.value)}</div>
          ${m.detail ? `<div class="metric-detail">${escapeHtml(m.detail)}</div>` : ''}
        </div>`
      ).join('')}</div>`
    : '';

  /* Sections */
  const sectionsHtml = data.sections?.length
    ? data.sections.map(section => {
        const renderer = SECTION_RENDERERS[section.type];
        if (!renderer) return '';
        const desc = section.description
          ? `<p class="section-desc">${escapeHtml(section.description)}</p>`
          : '';
        return `<div class="report-section">
          <h2>${escapeHtml(section.title)}</h2>
          ${desc}
          ${renderer(section)}
        </div>`;
      }).join('')
    : '';

  /* Manifest ledger */
  let manifestHtml = '';
  if (data.manifest) {
    const m = data.manifest;
    const items = [];
    if (m.generatedBy) items.push(`<div class="ledger-item"><span class="ledger-label">Generated By</span><span class="ledger-value">${escapeHtml(m.generatedBy)}</span></div>`);
    if (m.source) items.push(`<div class="ledger-item"><span class="ledger-label">Source</span><span class="ledger-value">${escapeHtml(m.source)}</span></div>`);
    if (m.checksum) items.push(`<div class="ledger-item"><span class="ledger-label">Checksum</span><span class="ledger-value">${escapeHtml(m.checksum)}</span></div>`);
    if (m.counts) {
      for (const [key, val] of Object.entries(m.counts)) {
        items.push(`<div class="ledger-item"><span class="ledger-label">${escapeHtml(key)}</span><span class="ledger-value">${escapeHtml(val)}</span></div>`);
      }
    }
    if (items.length) {
      manifestHtml = `<div class="manifest-ledger">${items.join('')}</div>`;
    }
  }

  /* Guardrail footer */
  let guardrailHtml = '';
  if (data.guardrail) {
    const g = data.guardrail;
    const parts = [];
    if (g.version) parts.push(`<span class="guardrail-version">v${escapeHtml(g.version)}</span>`);
    if (g.environment) parts.push(`<span>${escapeHtml(g.environment)}</span>`);
    if (g.notes) parts.push(`<span class="guardrail-notes">${escapeHtml(g.notes)}</span>`);
    if (parts.length) {
      guardrailHtml = `<div class="guardrail-footer">${parts.join('')}</div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="report-container">
  <div class="report-header">
    <h1>${title}</h1>
    ${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}
    ${ts ? `<p class="timestamp">${ts}</p>` : ''}
  </div>
  ${metricsHtml}
  ${sectionsHtml}
  ${manifestHtml}
  ${guardrailHtml}
</div>
</body>
</html>`;
}
