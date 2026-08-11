export function renderReviewPage(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enrichment Staging Review</title>
<style>
  :root{--bg:#f5f5f5;--card:#fff;--border:#ddd;--text:#222;--muted:#666;
        --green:#2d9e5f;--yellow:#c9860a;--orange:#d95b00;--red:#c0392b;
        --btn:#2563eb;--btn-h:#1d4ed8;--rej:#dc2626;--rej-h:#b91c1c}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--text)}
  header{background:#1e293b;color:#fff;padding:12px 20px;display:flex;align-items:center;gap:16px}
  header h1{font-size:16px;font-weight:600}
  #controls{background:var(--card);border-bottom:1px solid var(--border);
            padding:10px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  #controls label{display:flex;align-items:center;gap:6px;font-size:13px}
  select{padding:5px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px}
  .btn{padding:6px 12px;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:500}
  .btn-primary{background:var(--btn);color:#fff}.btn-primary:hover{background:var(--btn-h)}
  .btn-danger{background:var(--rej);color:#fff}.btn-danger:hover{background:var(--rej-h)}
  .btn-sm{padding:3px 8px;font-size:12px}
  .btn:disabled{opacity:.45;cursor:default}
  #stats{padding:8px 20px;font-size:12px;color:var(--muted);background:var(--card);
         border-bottom:1px solid var(--border)}
  #rows-container{padding:16px 20px;display:flex;flex-direction:column;gap:12px}
  .row-card{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:14px}
  .row-card.flagged{border-left:4px solid var(--orange)}
  .row-card.approved{opacity:.7}
  .row-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
  .row-id{font-family:monospace;font-size:11px;color:var(--muted)}
  .badge{display:inline-block;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600}
  .badge-red{background:#fde8e8;color:var(--red)}
  .badge-orange{background:#fff0e6;color:var(--orange)}
  .badge-yellow{background:#fef9e7;color:var(--yellow)}
  .badge-green{background:#e8f8f0;color:var(--green)}
  .badge-gray{background:#f0f0f0;color:var(--muted)}
  .badge-blue{background:#dbeafe;color:#1d4ed8}
  details{margin-top:8px}
  details summary{cursor:pointer;font-size:12px;color:var(--muted);user-select:none}
  details pre{background:#f8f8f8;border:1px solid var(--border);border-radius:4px;
              padding:8px;font-size:11px;overflow:auto;max-height:200px;margin-top:4px}
  .row-actions{margin-top:10px;display:flex;gap:8px;align-items:center}
  .verdict-text{font-size:12px;color:var(--muted)}
  #login-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);
                 display:flex;align-items:center;justify-content:center;z-index:100}
  #login-box{background:#fff;border-radius:8px;padding:28px;width:360px;max-width:90vw}
  #login-box h2{margin-bottom:12px;font-size:16px}
  #login-box p{font-size:13px;color:var(--muted);margin-bottom:14px}
  #login-box input{width:100%;padding:8px;border:1px solid var(--border);border-radius:4px;
                   font-size:13px;margin-bottom:10px}
  #login-error{color:var(--red);font-size:12px;min-height:16px}
  .empty{text-align:center;padding:40px;color:var(--muted)}
</style>
</head>
<body>

<div id="login-overlay">
  <div id="login-box">
    <h2>Enrichment Staging Review</h2>
    <p>Enter your Paperclip bearer token (SSI Director or CEO only).</p>
    <input id="token-input" type="password" placeholder="Bearer token…" autocomplete="off">
    <div id="login-error"></div>
    <button class="btn btn-primary" style="width:100%" id="login-btn">Sign in</button>
  </div>
</div>

<header>
  <h1>Enrichment Staging Review</h1>
  <span style="margin-left:auto;font-size:12px;opacity:.7" id="identity-label"></span>
</header>

<div id="controls">
  <label>Batch
    <select id="batch-select"><option value="">— select —</option></select>
  </label>
  <label><input type="checkbox" id="flagged-only"> Flagged only</label>
  <button class="btn btn-primary btn-sm" id="bulk-approve-btn" disabled>
    Bulk approve clean rows
  </button>
  <button class="btn btn-sm" id="refresh-btn" style="background:#e2e8f0" disabled>Refresh</button>
</div>

<div id="stats"></div>
<div id="rows-container"><p class="empty">Select a batch to begin.</p></div>

<script>
(function(){
  const $ = id => document.getElementById(id);

  let TOKEN = localStorage.getItem('review_token') ?? '';
  let CURRENT_BATCH = '';
  let ALL_ROWS = [];

  // ── Auth ──────────────────────────────────────────────────────────────────
  async function apiFetch(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
                 ...(opts.headers ?? {}) },
    });
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem('review_token');
      TOKEN = '';
      showLogin('Session expired or forbidden — sign in again.');
      throw new Error('auth');
    }
    return res;
  }

  function showLogin(msg = '') {
    $('login-overlay').style.display = 'flex';
    $('login-error').textContent = msg;
  }
  function hideLogin() { $('login-overlay').style.display = 'none'; }

  async function trySignIn() {
    const t = $('token-input').value.trim();
    if (!t) return;
    TOKEN = t;
    $('login-error').textContent = '';
    $('login-btn').disabled = true;
    try {
      const res = await fetch('/api/batches', {
        headers: { 'Authorization': 'Bearer ' + TOKEN },
      });
      if (res.status === 401 || res.status === 403) {
        TOKEN = '';
        $('login-error').textContent = 'Access denied — not in reviewer allowlist.';
        return;
      }
      localStorage.setItem('review_token', TOKEN);
      hideLogin();
      await loadBatches();
    } catch {
      $('login-error').textContent = 'Network error — try again.';
      TOKEN = '';
    } finally {
      $('login-btn').disabled = false;
    }
  }

  $('login-btn').addEventListener('click', trySignIn);
  $('token-input').addEventListener('keydown', e => { if (e.key === 'Enter') trySignIn(); });

  // ── Batches ───────────────────────────────────────────────────────────────
  async function loadBatches() {
    const res = await apiFetch('/api/batches');
    const { batches } = await res.json();
    const sel = $('batch-select');
    sel.innerHTML = '<option value="">— select —</option>';
    for (const b of batches) {
      const opt = document.createElement('option');
      opt.value = b.batch_id;
      opt.textContent = b.batch_id.slice(0, 8) + '…  (' + b.row_count + ' rows, '
        + b.flagged_count + ' flagged, ' + b.approved_count + ' approved)';
      sel.appendChild(opt);
    }
  }

  $('batch-select').addEventListener('change', async function () {
    CURRENT_BATCH = this.value;
    $('bulk-approve-btn').disabled = !CURRENT_BATCH;
    $('refresh-btn').disabled = !CURRENT_BATCH;
    if (CURRENT_BATCH) await loadRows();
    else { $('rows-container').innerHTML = '<p class="empty">Select a batch to begin.</p>'; $('stats').textContent = ''; }
  });

  $('flagged-only').addEventListener('change', filterRows);
  $('refresh-btn').addEventListener('click', () => loadRows());

  // ── Rows ──────────────────────────────────────────────────────────────────
  async function loadRows() {
    $('rows-container').innerHTML = '<p class="empty">Loading…</p>';
    $('stats').textContent = '';
    const res = await apiFetch('/api/staging?batch_id=' + encodeURIComponent(CURRENT_BATCH));
    const { rows } = await res.json();
    ALL_ROWS = rows;
    renderRows();
    updateStats();
  }

  function scoreClass(s) {
    if (s === null || s === undefined) return 'badge-gray';
    if (s >= 0.7) return 'badge-red';
    if (s >= 0.5) return 'badge-orange';
    if (s >= 0.3) return 'badge-yellow';
    return 'badge-green';
  }

  function verdictBadge(row) {
    if (!row.reviewer_verdict && !row.human_approved_at) return '<span class="badge badge-gray">Pending</span>';
    const v = (row.reviewer_verdict ?? '').toLowerCase();
    if (v.startsWith('approved')) return '<span class="badge badge-green">Approved</span>';
    if (v.startsWith('rejected')) return '<span class="badge badge-red">Rejected</span>';
    return '<span class="badge badge-gray">' + escHtml(row.reviewer_verdict) + '</span>';
  }

  function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function jsonBlock(label, obj) {
    if (obj === null || obj === undefined) return '';
    return '<details><summary>' + label + '</summary><pre>' +
      escHtml(JSON.stringify(obj, null, 2)) + '</pre></details>';
  }

  function validatorBadge(vr) {
    if (!vr) return '<span class="badge badge-gray">—</span>';
    const ok = vr.valid === true || vr.valid === 'true';
    return ok
      ? '<span class="badge badge-green">PASS</span>'
      : '<span class="badge badge-red">FAIL</span>';
  }

  function renderRows() {
    const flaggedOnly = $('flagged-only').checked;
    const visible = flaggedOnly ? ALL_ROWS.filter(r => r.is_flagged) : ALL_ROWS;
    if (!visible.length) {
      $('rows-container').innerHTML = '<p class="empty">No rows' + (flaggedOnly ? ' matching filter.' : '.') + '</p>';
      return;
    }
    $('rows-container').innerHTML = visible.map(row => {
      const done = !!row.human_approved_at;
      const score = row.anomaly_score !== null ? parseFloat(row.anomaly_score) : null;
      const scoreLabel = score !== null ? score.toFixed(4) : '—';
      return \`<div class="row-card \${row.is_flagged ? 'flagged' : ''} \${done ? 'approved' : ''}" data-id="\${escHtml(row.id)}" data-flagged="\${row.is_flagged}">
  <div class="row-meta">
    <span class="row-id">\${escHtml(row.id)}</span>
    <span class="badge badge-gray">\${escHtml(row.source_row_id)}</span>
    \${row.is_flagged ? '<span class="badge badge-orange">Flagged</span>' : '<span class="badge badge-green">Clean</span>'}
    <span class="badge \${scoreClass(score)}">Anomaly \${escHtml(scoreLabel)}</span>
    \${validatorBadge(row.validator_result)}
    \${verdictBadge(row)}
  </div>
  \${jsonBlock('Source data', row.source_payload_json)}
  \${jsonBlock('Primary output', row.primary_output_json)}
  \${jsonBlock('Validator result', row.validator_result)}
  \${jsonBlock('Fallback output', row.fallback_output_json)}
  <div class="row-actions">
    <button class="btn btn-primary btn-sm approve-btn" data-id="\${escHtml(row.id)}" \${done ? 'disabled' : ''}>Approve</button>
    <button class="btn btn-danger btn-sm reject-btn" data-id="\${escHtml(row.id)}" \${done ? 'disabled' : ''}>Reject</button>
    \${row.human_approved_by ? '<span class="verdict-text">by ' + escHtml(row.human_approved_by.slice(0,8)) + '…</span>' : ''}
  </div>
</div>\`;
    }).join('');

    // bind approve/reject buttons
    document.querySelectorAll('.approve-btn').forEach(btn => {
      btn.addEventListener('click', () => approveRow(btn.dataset.id));
    });
    document.querySelectorAll('.reject-btn').forEach(btn => {
      btn.addEventListener('click', () => rejectRow(btn.dataset.id));
    });
  }

  function filterRows() { renderRows(); updateStats(); }

  function updateStats() {
    const total = ALL_ROWS.length;
    const flagged = ALL_ROWS.filter(r => r.is_flagged).length;
    const approved = ALL_ROWS.filter(r => r.human_approved_at).length;
    const clean = ALL_ROWS.filter(r => !r.is_flagged && !r.human_approved_at).length;
    $('stats').textContent =
      'Batch: ' + total + ' rows | ' + flagged + ' flagged | ' + approved + ' approved | ' + clean + ' clean & pending';
  }

  async function approveRow(id) {
    const res = await apiFetch('/api/staging/' + encodeURIComponent(id) + '/approve', { method: 'POST' });
    if (!res.ok) { const d = await res.json(); alert('Error: ' + (d.error ?? res.status)); return; }
    const row = ALL_ROWS.find(r => r.id === id);
    if (row) { row.human_approved_at = new Date().toISOString(); row.reviewer_verdict = 'approved'; }
    renderRows(); updateStats();
  }

  async function rejectRow(id) {
    const reason = prompt('Rejection reason (optional):') ?? '';
    const res = await apiFetch('/api/staging/' + encodeURIComponent(id) + '/reject', {
      method: 'POST', body: JSON.stringify({ reason }),
    });
    if (!res.ok) { const d = await res.json(); alert('Error: ' + (d.error ?? res.status)); return; }
    const row = ALL_ROWS.find(r => r.id === id);
    if (row) {
      row.human_approved_at = new Date().toISOString();
      row.reviewer_verdict = reason ? 'rejected: ' + reason : 'rejected';
    }
    renderRows(); updateStats();
  }

  $('bulk-approve-btn').addEventListener('click', async function () {
    const clean = ALL_ROWS.filter(r => !r.is_flagged && !r.human_approved_at).length;
    if (clean === 0) { alert('No clean unapproved rows to approve.'); return; }
    if (!confirm('Approve all ' + clean + ' clean (unflagged) unapproved rows in this batch?')) return;
    $('bulk-approve-btn').disabled = true;
    try {
      const res = await apiFetch('/api/batches/' + encodeURIComponent(CURRENT_BATCH) + '/bulk-approve', { method: 'POST' });
      const d = await res.json();
      await loadRows();
      alert('Approved ' + (d.approved_count ?? '?') + ' rows.');
    } finally {
      $('bulk-approve-btn').disabled = false;
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (TOKEN) {
    apiFetch('/api/batches')
      .then(async res => {
        const { batches } = await res.json();
        const sel = $('batch-select');
        sel.innerHTML = '<option value="">— select —</option>';
        for (const b of batches) {
          const opt = document.createElement('option');
          opt.value = b.batch_id;
          opt.textContent = b.batch_id.slice(0, 8) + '…  (' + b.row_count + ' rows, '
            + b.flagged_count + ' flagged, ' + b.approved_count + ' approved)';
          sel.appendChild(opt);
        }
        hideLogin();
      })
      .catch(() => { if (TOKEN) showLogin(''); });
  }
})();
</script>
</body>
</html>`;
}
