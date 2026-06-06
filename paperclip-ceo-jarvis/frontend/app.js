const API = localStorage.getItem('jarvis_api') || 'http://localhost:8000';
const KEY = localStorage.getItem('jarvis_key') || 'dev-change-me';
const headers = { 'Content-Type': 'application/json', 'X-Jarvis-Key': KEY };

async function api(path, options = {}) {
  const mergedHeaders = path === '/health' ? {} : { ...headers, ...(options.headers || {}) };
  const res = await fetch(API + path, { ...options, headers: mergedHeaders });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
function pretty(x) { return JSON.stringify(x, null, 2); }
function set(id, val) { document.getElementById(id).textContent = typeof val === 'string' ? val : pretty(val); }
async function wrap(id, fn) { try { set(id, 'Working…'); set(id, await fn()); } catch (e) { set(id, 'Error: ' + e.message); } }

function showTab(id, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
  if (id === 'jarvis2') {
    loadJarvis2();
  }
}

const jarvis2State = {
  activeView: 'dashboard',
  snapshot: null,
  agents: [],
  briefing: null,
  ritual: null,
  loadedAt: null,
  selectedAlertId: null,
  loading: false,
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]|'/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function jarvis2Clamp(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 0;
  return Math.max(0, Math.min(100, num));
}

function jarvis2HealthClass(value) {
  if (value >= 80) return 'good';
  if (value >= 65) return 'warn';
  return 'bad';
}

function jarvis2HealthLabel(value) {
  if (value >= 80) return 'Shipping';
  if (value >= 65) return 'Building';
  return 'At risk';
}

function jarvis2Bar(value) {
  return `<div class="jarvis2-bar"><span style="width:${jarvis2Clamp(value)}%"></span></div>`;
}

function jarvis2List(items, renderItem) {
  return `<div class="jarvis2-list">${items.map(renderItem).join('') || '<div class="jarvis2-empty">Nothing to show.</div>'}</div>`;
}

function jarvis2Metric(label, value, detail) {
  return `<article class="card jarvis2-card"><p class="jarvis2-label">${escapeHtml(label)}</p><div class="jarvis2-metric">${escapeHtml(value)}</div>${detail ? `<p class="jarvis2-detail">${escapeHtml(detail)}</p>` : ''}</article>`;
}

function jarvis2NavSync() {
  document.querySelectorAll('.jarvis2-nav button[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === jarvis2State.activeView);
  });
}

function jarvis2SetView(view) {
  jarvis2State.activeView = view;
  renderJarvis2();
}

function jarvis2SelectAlert(alertId) {
  jarvis2State.selectedAlertId = String(alertId);
  renderJarvis2();
}

async function jarvis2DecisionAction(id, action) {
  const note = action === 'approve' ? 'Approved from Jarvis command center.' : 'Rejected from Jarvis command center.';
  try {
    set('jarvis2Status', 'Working…');
    await api(`/governance/approvals/${id}/${action}`, { method: 'POST', body: JSON.stringify({ note }) });
    await loadJarvis2(true);
    set('jarvis2Status', `Decision ${action}d.`);
  } catch (e) {
    set('jarvis2Status', 'Error: ' + e.message);
  }
}

async function loadJarvis2(force = false) {
  if (jarvis2State.loading) return;
  if (!force && jarvis2State.snapshot) {
    renderJarvis2();
    return;
  }
  jarvis2State.loading = true;
  set('jarvis2Status', 'Loading command center…');
  const view = document.getElementById('jarvis2View');
  if (view) view.innerHTML = '<div class="jarvis2-empty">Loading command center…</div>';
  try {
    const [snapshot, agents, briefing, ritual] = await Promise.all([
      api('/dashboard/god-view'),
      api('/agents'),
      api('/ceo/morning-briefing'),
      api('/mission-control/daily-ritual'),
    ]);
    jarvis2State.snapshot = snapshot;
    jarvis2State.agents = Array.isArray(agents.agents) ? agents.agents : [];
    jarvis2State.briefing = briefing;
    jarvis2State.ritual = ritual;
    jarvis2State.loadedAt = new Date();
    const alerts = snapshot?.governance?.alerts || [];
    jarvis2State.selectedAlertId = jarvis2State.selectedAlertId || (alerts[0] ? String(alerts[0].id) : null);
    renderJarvis2();
    set('jarvis2Status', `Loaded ${jarvis2State.loadedAt.toLocaleTimeString()}`);
  } catch (e) {
    set('jarvis2Status', 'Error: ' + e.message);
    if (view) view.innerHTML = '<div class="jarvis2-empty">Failed to load command center.</div>';
  } finally {
    jarvis2State.loading = false;
  }
}

function renderJarvis2View() {
  const data = jarvis2State.snapshot;
  if (!data) {
    return '<div class="jarvis2-empty">Open the command center to load the live portfolio, decisions, agents, analytics, and briefing views.</div>';
  }

  const snapshot = data;
  const portfolio = snapshot.portfolio || {};
  const governance = snapshot.governance || {};
  const missionControl = snapshot.mission_control || {};
  const people = snapshot.people_and_agents || {};
  const orchestration = snapshot.cross_system_orchestration || {};
  const autonomy = snapshot.autonomy_kernel || {};
  const alerts = Array.isArray(governance.alerts) ? governance.alerts : [];
  const approvals = Array.isArray(governance.pending_approvals) ? governance.pending_approvals : [];
  const workflows = Array.isArray(missionControl.active_workflows) ? missionControl.active_workflows : [];
  const companies = Array.isArray(portfolio.companies) ? portfolio.companies : [];
  const agents = jarvis2State.agents;
  const topItems = Array.isArray(jarvis2State.briefing?.top_items) ? jarvis2State.briefing.top_items : [];
  const recommendations = Array.isArray(jarvis2State.briefing?.recommendations) ? jarvis2State.briefing.recommendations : [];
  const workload = people.workload || {};
  const selectedAlert = alerts.find((alert) => String(alert.id) === String(jarvis2State.selectedAlertId)) || alerts[0] || null;
  const selectedAlertActions = selectedAlert ? (selectedAlert.severity === 'critical' ? 'Investigate now' : 'Review with CEO') : 'No alert selected';

  if (jarvis2State.activeView === 'dashboard') {
    return `
      <div class="jarvis2-grid">
        <article class="card jarvis2-card">
          <h2>Critical Alerts & Intelligence</h2>
          ${jarvis2List(alerts, (alert) => `
            <div class="jarvis2-item ${String(alert.id) === String(jarvis2State.selectedAlertId) ? 'selected' : ''}" onclick="jarvis2SelectAlert('${escapeHtml(alert.id)}')">
              <div class="jarvis2-item-head">
                <strong>${escapeHtml(alert.title)}</strong>
                <span class="jarvis2-badge ${jarvis2HealthClass(alert.severity === 'critical' ? 100 : alert.severity === 'high' ? 75 : 50)}">${escapeHtml(alert.severity)}</span>
              </div>
              <p>${escapeHtml(alert.detail || alert.summary || alert.description || '')}</p>
            </div>
          `)}
        </article>
        <article class="card jarvis2-card">
          <h2>Decisions Pending Your Input</h2>
          ${jarvis2List(approvals, (approval) => `
            <div class="jarvis2-item">
              <div class="jarvis2-item-head">
                <strong>${escapeHtml(approval.title)}</strong>
                <span class="jarvis2-badge warn">${escapeHtml(approval.risk_level || 'medium')}</span>
              </div>
              <p>${escapeHtml(approval.created_at || '')}</p>
              <div class="jarvis2-actions">
                <button onclick="jarvis2DecisionAction('${escapeHtml(approval.id)}', 'approve')">Approve</button>
                <button class="secondary" onclick="jarvis2DecisionAction('${escapeHtml(approval.id)}', 'reject')">Reject</button>
              </div>
            </div>
          `)}
        </article>
        <article class="card jarvis2-card">
          <h2>Agent Network</h2>
          ${jarvis2List(agents, (agent) => `
            <div class="jarvis2-item">
              <div class="jarvis2-item-head">
                <strong>${escapeHtml(agent.name)}</strong>
                <span class="jarvis2-badge good">${escapeHtml(agent.status || 'active')}</span>
              </div>
              <p>${escapeHtml(agent.role)}</p>
              ${jarvis2Bar(agent.reliability_score || 0)}
              <div class="jarvis2-item-foot">Reliability ${escapeHtml(agent.reliability_score || 0)}%</div>
            </div>
          `)}
        </article>
        <article class="card jarvis2-card">
          <h2>Alert Detail</h2>
          ${selectedAlert ? `
            <div class="jarvis2-feature">
              <p class="jarvis2-label">${escapeHtml(selectedAlert.severity || 'info')}</p>
              <h3>${escapeHtml(selectedAlert.title || '')}</h3>
              <p>${escapeHtml(selectedAlert.detail || selectedAlert.summary || '')}</p>
              <p class="jarvis2-detail">${escapeHtml(selectedAlertActions)}</p>
            </div>
          ` : '<div class="jarvis2-empty">No alert selected.</div>'}
          <p class="jarvis2-detail">Open risk score: ${escapeHtml(governance.open_risk_score || 0)}</p>
        </article>
      </div>`;
  }

  if (jarvis2State.activeView === 'portfolio') {
    return `
      <div class="jarvis2-mini-grid">
        ${jarvis2Metric('Average Health', `${portfolio.average_health ?? 0}%`, `${portfolio.company_count ?? companies.length ?? 0} companies`)}
        ${jarvis2Metric('Open Tasks', `${portfolio.open_tasks ?? 0}`, `${portfolio.high_risk_tasks ?? 0} high risk`)}
        ${jarvis2Metric('Agent Health', `${people.agent_health ?? 0}%`, `${people.federated_agents ?? agents.length ?? 0} federated agents`)}
        ${jarvis2Metric('Workload Risk', `${workload.risk_count ?? 0}`, `${workload.overloaded_count ?? 0} overloaded`)}
      </div>
      <div class="jarvis2-grid jarvis2-grid-spread">
        ${jarvis2List(companies, (company) => `
          <article class="card jarvis2-card">
            <h2>${escapeHtml(company.name)}</h2>
            <div class="jarvis2-feature">
              <p class="jarvis2-label">Health ${escapeHtml(company.health_score || 0)}%</p>
              ${jarvis2Bar(company.health_score || 0)}
              <p class="jarvis2-detail">${escapeHtml(company.mission || 'No mission provided.')}</p>
              <span class="jarvis2-badge ${jarvis2HealthClass(company.health_score || 0)}">${escapeHtml(jarvis2HealthLabel(company.health_score || 0))}</span>
            </div>
          </article>
        `)}
      </div>`;
  }

  if (jarvis2State.activeView === 'decisions') {
    return `
      <div class="jarvis2-grid">
        <article class="card jarvis2-card wide">
          <h2>Approval Queue</h2>
          ${jarvis2List(approvals, (approval) => `
            <div class="jarvis2-item">
              <div class="jarvis2-item-head">
                <strong>${escapeHtml(approval.title)}</strong>
                <span class="jarvis2-badge warn">${escapeHtml(approval.risk_level || 'medium')}</span>
              </div>
              <p>${escapeHtml(approval.created_at || '')}</p>
              <div class="jarvis2-actions">
                <button onclick="jarvis2DecisionAction('${escapeHtml(approval.id)}', 'approve')">Approve</button>
                <button class="secondary" onclick="jarvis2DecisionAction('${escapeHtml(approval.id)}', 'reject')">Reject</button>
              </div>
            </div>
          `)}
        </article>
        <article class="card jarvis2-card wide">
          <h2>Active Workflows</h2>
          ${jarvis2List(workflows, (workflow) => `
            <div class="jarvis2-item">
              <div class="jarvis2-item-head">
                <strong>${escapeHtml(workflow.title)}</strong>
                <span class="jarvis2-badge info">${escapeHtml(workflow.status || 'running')}</span>
              </div>
              <p>${escapeHtml(workflow.template_key || '')}</p>
              <div class="jarvis2-item-foot">Step ${escapeHtml(workflow.current_step_index ?? 0)}</div>
            </div>
          `)}
        </article>
      </div>`;
  }

  if (jarvis2State.activeView === 'agents') {
    return `
      <div class="jarvis2-mini-grid">
        ${jarvis2Metric('Active Agents', `${agents.length}`, `${people.federated_agents ?? agents.length} in the network`)}
        ${jarvis2Metric('Agent Health', `${people.agent_health ?? 0}%`, 'Average reliability score')}
        ${jarvis2Metric('Company Alerts', `${alerts.length}`, `${selectedAlert ? 'One selected' : 'No selection'}`)}
        ${jarvis2Metric('Cross-System Traces', `${orchestration.trace_count ?? 0}`, `${(orchestration.recent_traces || []).length} recent traces`)}
      </div>
      <div class="jarvis2-grid jarvis2-grid-spread">
        ${jarvis2List(agents, (agent) => `
          <article class="card jarvis2-card">
            <h2>${escapeHtml(agent.name)}</h2>
            <p class="jarvis2-label">${escapeHtml(agent.role)}</p>
            <p class="jarvis2-detail">${escapeHtml(agent.mission || '')}</p>
            ${jarvis2Bar(agent.reliability_score || 0)}
            <div class="jarvis2-item-foot">${escapeHtml(agent.capabilities || '')}</div>
          </article>
        `)}
      </div>`;
  }

  if (jarvis2State.activeView === 'analytics') {
    const capability = missionControl.capability_readiness || {};
    return `
      <div class="jarvis2-mini-grid">
        ${jarvis2Metric('Decision Accuracy', '94.2%', 'Zip import benchmark')}
        ${jarvis2Metric('Alert Precision', '87.6%', 'Zip import benchmark')}
        ${jarvis2Metric('Average Response Time', '2.3s', 'Zip import benchmark')}
        ${jarvis2Metric('Uptime', '99.98%', 'Zip import benchmark')}
        ${jarvis2Metric('Ready Capabilities', `${capability.ready ?? 0}/${capability.total ?? 0}`, `${capability.approval_gated ?? 0} approval gated`)}
        ${jarvis2Metric('Open Insights', `${autonomy.open_insights?.length ?? 0}`, `${orchestration.trace_count ?? 0} trace events`)}
      </div>`;
  }

  const topThings = jarvis2List(topItems.slice(0, 3), (item) => `
    <div class="jarvis2-item">
      <div class="jarvis2-item-head">
        <strong>${escapeHtml(item.title || '')}</strong>
        <span class="jarvis2-badge info">${escapeHtml(item.category || 'item')}</span>
      </div>
      <p>${escapeHtml(item.summary || '')}</p>
    </div>
  `);

  const recHtml = jarvis2List(recommendations, (recommendation) => `<div class="jarvis2-item"><p>${escapeHtml(recommendation)}</p></div>`);
  const ritualOpen = jarvis2State.ritual?.opening || jarvis2State.briefing?.greeting || 'Jarvis command center briefing.';

  return `
    <div class="jarvis2-grid">
      <article class="card jarvis2-card wide">
        <h2>Daily Briefing</h2>
        <div class="jarvis2-feature">
          <p class="jarvis2-label">${escapeHtml(ritualOpen)}</p>
          <p>${escapeHtml(jarvis2State.ritual?.ceo_prompt || jarvis2State.briefing?.greeting || '')}</p>
        </div>
      </article>
      <article class="card jarvis2-card">
        <h2>Three Things to Know</h2>
        ${topThings}
      </article>
      <article class="card jarvis2-card">
        <h2>Portfolio Status</h2>
        <p>${escapeHtml(snapshot.governance?.alerts?.length || 0)} current alerts, ${escapeHtml(governance.pending_approvals?.length || 0)} pending approvals, ${escapeHtml(workflows.length)} active workflows.</p>
        <p class="jarvis2-detail">${escapeHtml(snapshot.ceo_recommendations?.[0] || '')}</p>
      </article>
      <article class="card jarvis2-card">
        <h2>Recommendations</h2>
        ${recHtml}
      </article>
    </div>`;
}

function renderJarvis2() {
  const view = document.getElementById('jarvis2View');
  const meta = document.getElementById('jarvis2Meta');
  const time = document.getElementById('jarvis2Time');
  if (time) time.textContent = new Date().toLocaleTimeString();
  jarvis2NavSync();
  if (!view) return;
  if (!jarvis2State.snapshot) {
    view.innerHTML = '<div class="jarvis2-empty">Open the command center to load the live command center views.</div>';
    if (meta) meta.textContent = 'Waiting for live snapshot.';
    return;
  }
  const snapshot = jarvis2State.snapshot;
  const portfolio = snapshot.portfolio || {};
  const governance = snapshot.governance || {};
  const missionControl = snapshot.mission_control || {};
  const people = snapshot.people_and_agents || {};
  const orchestration = snapshot.cross_system_orchestration || {};
  const alertCount = Array.isArray(governance.alerts) ? governance.alerts.length : 0;
  const approvalCount = Array.isArray(governance.pending_approvals) ? governance.pending_approvals.length : 0;
  const workflowCount = Array.isArray(missionControl.active_workflows) ? missionControl.active_workflows.length : 0;
  const companyCount = Array.isArray(portfolio.companies) ? portfolio.companies.length : 0;
  if (meta) {
    meta.textContent = `${companyCount} companies · ${approvalCount} approvals · ${workflowCount} workflows · ${alertCount} alerts · ${orchestration.trace_count || 0} traces`;
  }
  view.innerHTML = renderJarvis2View();
}

async function checkHealth() {
  try { const data = await api('/health'); document.getElementById('status').textContent = `${data.app}: ${data.status}`; }
  catch { document.getElementById('status').textContent = 'API offline'; }
}
function loadSnapshot() { return wrap('snapshot', () => api('/dashboard/god-view')); }
function loadBriefing() { return wrap('briefingOut', () => api('/ceo/morning-briefing')); }
function loadBoardPack() { return wrap('boardOut', () => api('/ceo/board-pack')); }
function sendChat() {
  const message = document.getElementById('chatInput').value;
  return wrap('chatOutput', () => api('/chat', { method: 'POST', body: JSON.stringify({ message }) }));
}
function simulateDecision() {
  const title = document.getElementById('decisionTitle').value;
  const decision = document.getElementById('decisionBody').value;
  return wrap('decisionOut', () => api('/ceo/decisions/simulate', {
    method: 'POST', body: JSON.stringify({ title, decision, horizon_days: 60, assumptions: ['support load rises', 'conversion target is 8%'], constraints: ['zero-budget/open-source first'] })
  }));
}
function reason() {
  const question = document.getElementById('reasonQuestion').value;
  return wrap('reasonOut', () => api('/intelligence/reason', { method: 'POST', body: JSON.stringify({ question, horizon_days: 90 }) }));
}
function searchKnowledge() {
  const query = document.getElementById('knowledgeQuery').value;
  return wrap('knowledgeOut', () => api('/intelligence/knowledge/search', { method: 'POST', body: JSON.stringify({ query, limit: 8 }) }));
}
function loadContext() { return wrap('contextOut', () => api('/intelligence/context?query=jarvis')); }
function loadAgents() { return wrap('agentsOut', () => api('/agents')); }
function runSwarm() {
  const task = document.getElementById('swarmTask').value;
  const mode = document.getElementById('swarmMode').value || 'parallel';
  return wrap('swarmOut', () => api('/agents/swarm', { method: 'POST', body: JSON.stringify({ task, mode, require_approval_for_execution: true }) }));
}
function loadApprovals() { return wrap('approvalsOut', () => api('/governance/approvals?status=all')); }
function createApproval() {
  const title = document.getElementById('approvalTitle').value;
  const action = document.getElementById('approvalAction').value;
  return wrap('approvalCreateOut', () => api('/governance/approvals', { method: 'POST', body: JSON.stringify({ title, action, risk_level: 'high', rationale: 'Public/external action requires CEO approval.' }) }));
}
function loadRisks() { return wrap('riskOut', () => api('/risk')); }
function loadAudit() { return wrap('auditOut', () => api('/governance/audit?limit=25')); }
function loadTimeline() { return wrap('timelineOut', () => api('/temporal/timeline?horizon_days=90')); }
function loadWindows() { return wrap('windowsOut', () => api('/temporal/opportunity-windows')); }
function loadDebt() { return wrap('debtOut', () => api('/temporal/debt')); }
function generateContent() {
  const kind = document.getElementById('contentKind').value;
  const topic = document.getElementById('contentTopic').value;
  const facts = document.getElementById('contentFacts').value.split('\n').filter(Boolean);
  return wrap('contentOut', () => api('/content/generate', { method: 'POST', body: JSON.stringify({ kind, topic, facts, audience: 'CEO stakeholders' }) }));
}
function loadIntegrations() { return wrap('integrationsOut', () => api('/integrations')); }

checkHealth();
loadSnapshot();
setInterval(() => {
  const clock = document.getElementById('jarvis2Time');
  if (clock) clock.textContent = new Date().toLocaleTimeString();
}, 1000);


function triageCommand() {
  const command = document.getElementById('missionCommand').value;
  const autonomous = document.getElementById('missionAutonomous').checked;
  return wrap('missionCommandOut', () => api('/mission-control/command', { method: 'POST', body: JSON.stringify({ command, autonomous }) }));
}
function loadPlaybooks() { return wrap('playbooksOut', () => api('/mission-control/playbooks')); }
function startPlaybook() {
  const template_key = document.getElementById('playbookKey').value;
  const title = document.getElementById('playbookTitle').value;
  return wrap('playbookStartOut', () => api('/mission-control/workflows', { method: 'POST', body: JSON.stringify({ template_key, title, owner: 'CEO', input_payload: { source: 'dashboard' } }) }));
}
function loadWorkflows() { return wrap('workflowsOut', () => api('/mission-control/workflows?status=all')); }
function loadDailyRitual() { return wrap('dailyRitualOut', () => api('/mission-control/daily-ritual')); }
function loadNextBestActions() { return wrap('nextActionsOut', () => api('/mission-control/next-best-actions')); }
function loadCapabilities() { return wrap('capabilitiesOut', () => api('/capabilities')); }
function loadReadiness() { return wrap('readinessOut', () => api('/capabilities/readiness')); }
function loadSOPs() { return wrap('sopsOut', () => api('/mission-control/sops')); }


function evaluateAutonomy() {
  const action = document.getElementById('autonomyAction').value;
  return wrap('autonomyEvalOut', () => api('/autonomy/evaluate', { method: 'POST', body: JSON.stringify({ action, impact_area: 'operations' }) }));
}
function loadPolicies() { return wrap('policiesOut', () => api('/autonomy/policies')); }
function loadWatchRules() { return wrap('watchRulesOut', () => api('/autonomy/watch-rules')); }
function runWatchCycle() { return wrap('watchCycleOut', () => api('/autonomy/watch-cycle', { method: 'POST' })); }
function loadInsights() { return wrap('insightsOut', () => api('/autonomy/insights')); }
function loadEnchantments() { return wrap('enchantmentsOut', () => api('/enchantments/backlog')); }
function loadEnchantmentAudit() { return wrap('enchantmentAuditOut', () => api('/enchantments/audit')); }
function loadBrainstorm() { return wrap('brainstormOut', () => api('/enchantments/brainstorm')); }
function planEnchantments() {
  const focus_categories = document.getElementById('planCategories').value.split(',').map(x => x.trim()).filter(Boolean);
  const capacity_level = document.getElementById('planCapacity').value;
  const include_high_risk = document.getElementById('planHighRisk').checked;
  return wrap('planOut', () => api('/enchantments/plan', { method: 'POST', body: JSON.stringify({ focus_categories, horizon_days: 60, capacity_level, include_high_risk }) }));
}


function loadV5Audit() { return wrap('v5AuditOut', () => api('/v5/audit')); }
function runConstitutionalCheck() { const action = document.getElementById('constitutionalAction').value; return wrap('constitutionalOut', () => api('/v5/constitutional/check', { method: 'POST', body: JSON.stringify({ action }) })); }
function runZeroTrustDecision() { const actor = document.getElementById('ztActor').value; const resource = document.getElementById('ztResource').value; const requested_scope = document.getElementById('ztScope').value; return wrap('zeroTrustOut', () => api('/v5/zero-trust/decision', { method: 'POST', body: JSON.stringify({ actor, resource, requested_scope }) })); }
function chooseCarbonRoute() { const task = document.getElementById('carbonTask').value; return wrap('carbonOut', () => api('/v5/carbon/choose-route', { method: 'POST', body: JSON.stringify({ task, min_quality: 70 }) })); }
function runV5Evaluation() { return wrap('evalOut', () => api('/v5/evaluation/run', { method: 'POST', body: JSON.stringify({}) })); }
function loadV5ContextBundle() { const task = document.getElementById('contextTask').value; return wrap('v5ContextOut', () => api('/v5/context/bundle', { method: 'POST', body: JSON.stringify({ task, scope: 'ceo' }) })); }
function loadWorkforceMarketplace() { return wrap('marketplaceOut', () => api('/v5/workforce/marketplace')); }
function loadCompanyEcosystem() { return wrap('ecosystemOut', () => api('/v5/company/ecosystem')); }
function runBoardVote() { const proposal = document.getElementById('boardProposal').value; return wrap('boardVoteOut', () => api('/v5/board/vote', { method: 'POST', body: JSON.stringify({ proposal }) })); }
function proposeTeam() { const demand_signal = document.getElementById('teamSignal').value; return wrap('teamProposalOut', () => api('/v5/teams/propose', { method: 'POST', body: JSON.stringify({ demand_signal }) })); }
function loadRnDLab() { return wrap('rndOut', () => api('/v5/rnd/lab')); }
function loadEngineeringCatalog() { return wrap('engineeringCatalogOut', () => api('/v5/engineering/catalog')); }
function loadComplianceAutomation() { return wrap('complianceOut', () => api('/v5/compliance/automation')); }
function loadCultureIntelligence() { return wrap('cultureOut', () => api('/v5/culture/intelligence')); }

function loadFederationSystems() { return wrap('federationSystemsOut', () => api('/federation/systems')); }
function loadFederationBriefing() { const focus = document.getElementById('federationFocus').value; return wrap('federationBriefingOut', () => api('/federation/briefing', { method: 'POST', body: JSON.stringify({ focus, include_sources: ['paperclip', 'hermes', 'pi', 'opencode'] }) })); }
function routeFederationTask() { const task = document.getElementById('federationRouteTask').value; const preferred_system = document.getElementById('federationRouteSystem').value; const allow_execution = document.getElementById('federationAllowExecution').checked; return wrap('federationRouteOut', () => api('/federation/route', { method: 'POST', body: JSON.stringify({ task, preferred_system, allow_execution, context: { source: 'dashboard' } }) })); }
function executeFederationTask() { const task = document.getElementById('federationExecuteTask').value; const target_system = document.getElementById('federationExecuteSystem').value; const approved = document.getElementById('federationApproved').checked; return wrap('federationExecuteOut', () => api('/federation/execute', { method: 'POST', body: JSON.stringify({ task, target_system, approved, context: { source: 'dashboard' } }) })); }
function loadFederationTraces() { return wrap('federationTracesOut', () => api('/federation/traces?limit=20')); }
