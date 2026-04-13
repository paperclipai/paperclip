// render.js — pure HTML-string rendering functions for the Flask ops dashboard
// Depends on: api.js (none at runtime, but loaded second)
// Exposes window.Render

window.Render = (() => {

  // ─── internal helpers ──────────────────────────────────────────────────────

  const esc = (s) => {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  const badge = (cls, text) =>
    `<span class="badge ${esc(cls)}">${esc(text)}</span>`;

  const fmtAgo = (iso) => {
    if (!iso) return '';
    const diffMs = Date.now() - new Date(iso).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60)  return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60)  return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24)   return `${diffHr}h ago`;
    return `${Math.floor(diffHr / 24)}d ago`;
  };

  const fmtTime = (unixTs) =>
    new Date(unixTs * 1000).toLocaleTimeString();

  // ─── event label ───────────────────────────────────────────────────────────

  const eventLabel = (e) => {
    const d = e.data || {};
    switch (e.type) {
      case 'health_check':
        return `Health check → ${esc(d.status ?? '')}`;
      case 'cred_synced':
        return `🔑 Credentials synced → ${esc(d.target ?? '')}`;
      case 'cred_up_to_date':
        return `Credentials up to date → ${esc(d.target ?? '')}`;
      case 'token_expired':
        return `⚠ Token expired → ${esc(d.target ?? '')}`;
      case 'approval_found':
        return `🔔 Approval: ${esc(String(d.id ?? '').slice(0, 8))}… type=${esc(d.type ?? '')}`;
      case 'claude_spawned':
        return `🤖 Claude spawned: ${esc(d.label ?? '')}`;
      case 'claude_completed':
        return `✓ Claude done: ${esc(d.label ?? '')} success=${esc(String(d.success ?? ''))}`;
      case 'alert_sent':
        return `🚨 Alert: ${esc(d.subject ?? '')}`;
      case 'telegram_sent':
        return `📨 Telegram: ${esc(String(d.message ?? '').slice(0, 80))}`;
      case 'server_restarted':
        return `🔄 Server restarted`;
      case 'gh_auth_refreshed':
        return `🔑 GitHub auth refreshed`;
      default:
        return `${esc(e.type)}: ${esc(JSON.stringify(d).slice(0, 80))}`;
    }
  };

  // ─── exported render functions ─────────────────────────────────────────────

  const renderContainers = (containers) => {
    if (!containers || !containers.length) {
      return '<p class="empty">No container data</p>';
    }
    const rows = containers.map(c => {
      const isUp = /^up/i.test(c.status ?? '');
      const statusCls = isUp ? 'ok' : 'error';
      return `
        <div class="container-row">
          <span class="container-name">${esc(c.name)}</span>
          ${badge(statusCls, c.status ?? 'unknown')}
          <span class="container-meta">${esc(c.image ?? '')}</span>
        </div>`;
    });
    return `<div class="container-list">${rows.join('')}</div>`;
  };

  const renderCreds = (summary) => {
    if (!summary) return '<p class="empty">No data</p>';

    const { claude_creds, gh_creds, server_health } = summary;

    const credRow = (label, info) => {
      if (!info) return '';
      const cls = info.valid ? 'ok' : 'error';
      const ago = info.last_synced ? `<span class="muted">${fmtAgo(info.last_synced)}</span>` : '';
      return `
        <div class="cred-row">
          <span class="cred-label">${esc(label)}</span>
          ${badge(cls, info.valid ? 'valid' : 'invalid')}
          ${ago}
        </div>`;
    };

    const healthRow = server_health
      ? `<div class="cred-row">
           <span class="cred-label">Server</span>
           ${badge(server_health.ok ? 'ok' : 'error', server_health.ok ? 'healthy' : 'unhealthy')}
           ${server_health.latency_ms != null
             ? `<span class="muted">${server_health.latency_ms}ms</span>`
             : ''}
         </div>`
      : '';

    return `<div class="cred-list">
      ${credRow('Claude', claude_creds)}
      ${credRow('GitHub', gh_creds)}
      ${healthRow}
    </div>`;
  };

  const renderApprovals = (summary) => {
    const approvals = summary?.pending_approvals ?? [];
    if (!approvals.length) return '<p class="empty">No pending approvals</p>';

    const items = approvals.map(a => `
      <div class="approval-row">
        <span class="approval-id">${esc(String(a.id ?? '').slice(0, 12))}…</span>
        ${badge('warn', a.type ?? 'unknown')}
        <span class="muted">${fmtAgo(a.created_at)}</span>
      </div>`);

    return `<div class="approval-list">${items.join('')}</div>`;
  };

  const renderSpawns = (summary) => {
    const spawns = summary?.recent_spawns ?? [];
    if (!spawns.length) return '<p class="empty">No recent spawns</p>';

    const items = spawns.map(s => `
      <div class="spawn-row">
        <span class="spawn-label">${esc(s.label ?? s.id ?? '')}</span>
        ${badge(s.success === false ? 'error' : s.success === true ? 'ok' : 'neutral',
                s.status ?? (s.success === true ? 'done' : s.success === false ? 'failed' : 'running'))}
        <span class="muted">${fmtAgo(s.started_at)}</span>
      </div>`);

    return `<div class="spawn-list">${items.join('')}</div>`;
  };

  const renderAlerts = (summary) => {
    const alerts = summary?.recent_alerts ?? [];
    if (!alerts.length) return '<p class="empty">No recent alerts</p>';

    const items = alerts.map(a => `
      <div class="alert-row">
        <span class="alert-subject">${esc(a.subject ?? a.message ?? '')}</span>
        <span class="muted">${fmtAgo(a.sent_at ?? a.timestamp)}</span>
      </div>`);

    return `<div class="alert-list">${items.join('')}</div>`;
  };

  const renderRoutines = (routines) => {
    if (!routines || !routines.length) {
      return '<p class="empty">No routines</p>';
    }

    const rows = routines.map(r => {
      const isActive = r.enabled !== false;
      const statusCls = isActive ? 'ok' : 'neutral';
      return `
        <div class="routine-row">
          <span class="routine-name">${esc(r.name ?? r.id ?? '')}</span>
          ${badge(statusCls, isActive ? 'enabled' : 'disabled')}
          <span class="routine-schedule muted">${esc(r.schedule ?? '')}</span>
          <span class="muted">${r.last_run ? fmtAgo(r.last_run) : '—'}</span>
        </div>`;
    });

    return `<div class="routine-list">${rows.join('')}</div>`;
  };

  const renderAudit = (summary) => {
    const entries = summary?.claude_audit ?? [];
    if (!entries.length) return '<p class="empty">No audit entries</p>';

    const items = entries.map((entry, i) => {
      const id = `audit-${i}`;
      const label = esc(entry.label ?? entry.id ?? `Entry ${i}`);
      const success = entry.success;
      const statusCls = success === true ? 'ok' : success === false ? 'error' : 'neutral';
      const statusText = success === true ? 'success' : success === false ? 'failed' : 'unknown';
      const detail = esc(JSON.stringify(entry, null, 2));

      return `
        <div class="entry">
          <div class="entry-header" onclick="Dashboard.toggleEntry('${id}')">
            <span class="entry-label">${label}</span>
            ${badge(statusCls, statusText)}
            <span class="muted">${fmtAgo(entry.timestamp ?? entry.started_at)}</span>
            <span class="toggle-icon">▾</span>
          </div>
          <pre class="entry-body" id="${id}">${detail}</pre>
        </div>`;
    });

    return items.join('');
  };

  const renderTimeline = (events) => {
    if (!events || !events.length) {
      return '<div class="event-list"><p class="empty">No events</p></div>';
    }

    const typeClass = (type) => {
      if (!type) return '';
      if (/error|fail|expired/i.test(type)) return 'ev-error';
      if (/warn|alert/i.test(type))         return 'ev-warn';
      if (/sync|refresh|restart/i.test(type)) return 'ev-info';
      if (/spawn|complet|done/i.test(type)) return 'ev-ok';
      return '';
    };

    const items = events.map(e => {
      const ts = e.timestamp ? fmtTime(e.timestamp) : (e.created_at ? fmtAgo(e.created_at) : '');
      return `
        <div class="event-row ${typeClass(e.type)}">
          <span class="event-time muted">${esc(ts)}</span>
          <span class="event-label">${eventLabel(e)}</span>
        </div>`;
    });

    return `<div class="event-list">${items.join('')}</div>`;
  };

  const renderScripts = (scripts) => {
    if (!scripts || !scripts.length) {
      return `
        <div class="card-body">
          <div class="script-toolbar">
            <span class="toolbar-label">Available scripts</span>
            <button class="btn-secondary" onclick="Dashboard.clearHistory()">Clear history</button>
          </div>
          <p class="empty">No scripts found</p>
          <div class="job-list" id="job-list"></div>
        </div>`;
    }

    const buttons = scripts.map(s => {
      const file = s.file ?? s;
      const label = esc(String(file).replace(/^.*[\\/]/, ''));
      const isDeploy = /deploy/i.test(String(file));
      const extraCls = isDeploy ? ' deploy-btn' : '';
      return `<button class="script-btn${extraCls}" onclick="Dashboard.runScript('${esc(file)}', this)">${label}</button>`;
    });

    return `
      <div class="card-body">
        <div class="script-toolbar">
          <span class="toolbar-label">Available scripts</span>
          <button class="btn-secondary" onclick="Dashboard.clearHistory()">Clear history</button>
        </div>
        <div class="script-grid">
          ${buttons.join('\n          ')}
        </div>
        <div class="job-list" id="job-list"></div>
      </div>`;
  };

  // ─── public API ────────────────────────────────────────────────────────────

  return {
    renderContainers,
    renderCreds,
    renderApprovals,
    renderSpawns,
    renderAlerts,
    renderRoutines,
    renderAudit,
    renderTimeline,
    renderScripts,
  };
})();
