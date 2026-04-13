// main.js — init, polling, and public Dashboard namespace
// Depends on: api.js, render.js, scripts.js  (loaded before this file)
// Exposes window.Dashboard

window.Dashboard = (() => {

  // ─── refresh ───────────────────────────────────────────────────────────────

  const refresh = async () => {
    const dot  = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    const main = document.getElementById('main');

    let status, events, routines, scripts;

    try {
      [status, events, routines, scripts] = await Promise.all([
        API.getStatus(),
        API.getEvents(),
        API.getRoutines(),
        API.getScripts(),
      ]);
    } catch (err) {
      console.error('[Dashboard] refresh failed:', err);
      dot?.classList.add('error');
      if (text) text.textContent = String(err.message ?? err);
      if (main) {
        main.innerHTML = `
          <div class="card full-width">
            <div class="card-body">
              <p class="empty error-msg">Failed to load dashboard data: ${String(err.message ?? err)}</p>
            </div>
          </div>`;
      }
      return;
    }

    // — render cards
    main.innerHTML = `
  <div class="card">
    <div class="card-header"><div class="card-title"><span class="icon">🐳</span>Containers</div></div>
    <div class="card-body">${Render.renderContainers(status.containers)}</div>
  </div>

  <div class="card">
    <div class="card-header"><div class="card-title"><span class="icon">🔐</span>Credentials &amp; Health</div></div>
    <div class="card-body">${Render.renderCreds(status.summary)}</div>
  </div>

  <div class="card">
    <div class="card-header"><div class="card-title"><span class="icon">🔔</span>Pending Approvals</div></div>
    <div class="card-body">${Render.renderApprovals(status.summary)}</div>
  </div>

  <div class="card">
    <div class="card-header"><div class="card-title"><span class="icon">🤖</span>Claude Spawns</div></div>
    <div class="card-body">${Render.renderSpawns(status.summary)}</div>
  </div>

  <div class="card">
    <div class="card-header"><div class="card-title"><span class="icon">🚨</span>Alerts</div></div>
    <div class="card-body">${Render.renderAlerts(status.summary)}</div>
  </div>

  <div class="card full-width">
    <div class="card-header">
      <div class="card-title"><span class="icon">⚙️</span>Routines</div>
      <a class="card-action" href="http://localhost:3100/ANGA/routines" target="_blank">↗ manage</a>
    </div>
    <div class="card-body">${Render.renderRoutines(routines)}</div>
  </div>

  <div class="card full-width">
    <div class="card-header"><div class="card-title"><span class="icon">📜</span>Scripts &amp; Deploy</div></div>
    ${Render.renderScripts(scripts)}
  </div>

  <div class="card full-width">
    <div class="card-header"><div class="card-title"><span class="icon">🔍</span>Claude Audit</div></div>
    <div class="card-body"><div class="job-list">${Render.renderAudit(status.summary)}</div></div>
  </div>

  <div class="card full-width">
    <div class="card-header"><div class="card-title"><span class="icon">📡</span>Event Timeline</div></div>
    <div class="card-body">${Render.renderTimeline(events)}</div>
  </div>
`;

    // — update header status
    dot?.classList.remove('error');

    if (text) {
      const now = new Date().toLocaleTimeString();
      const count = Array.isArray(events) ? events.length : 0;
      text.textContent = `Updated ${now} · ${count} events`;
    }
  };

  // ─── delegators ────────────────────────────────────────────────────────────

  const toggleEntry  = (id)       => ScriptRunner.toggleEntry(id);
  const runScript    = (file, btn) => ScriptRunner.run(file, btn);
  const clearHistory = ()          => ScriptRunner.clearHistory();

  // ─── public API ────────────────────────────────────────────────────────────

  return { refresh, toggleEntry, runScript, clearHistory };
})();

// ─── bootstrap (scripts load deferred — no DOMContentLoaded needed) ──────────
Dashboard.refresh();
setInterval(Dashboard.refresh.bind(Dashboard), 15000);
