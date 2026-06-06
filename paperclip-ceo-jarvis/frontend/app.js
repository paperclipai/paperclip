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
  if (id === 'overview') {
    loadUnifiedDashboard();
  }
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
  healthForecast: null,
  v5Audit: null,
  loadedAt: null,
  selectedAlertId: null,
  loading: false,
  seededDefaults: false,
};

const unifiedState = {
  snapshot: null,
  agents: [],
  briefing: null,
  ritual: null,
  providers: [],
  healthForecast: null,
  v5Audit: null,
  integrations: [],
  approvals: [],
  workflows: [],
  insights: [],
  loadedAt: null,
  loading: false,
  selectedProviderId: null,
  selectedModelId: null,
  providerQuery: '',
  seededDefaults: false,
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

function jarvis2Percent(value, digits = 0) {
  const num = Number(value);
  if (Number.isNaN(num)) return '0%';
  return `${(num * 100).toFixed(digits)}%`;
}

function jarvis2SeedLiveDefaults(snapshot, healthForecast) {
  const recommendations = Array.isArray(snapshot?.ceo_recommendations) ? snapshot.ceo_recommendations : [];
  const alerts = Array.isArray(snapshot?.governance?.alerts) ? snapshot.governance.alerts : [];
  const approvals = Array.isArray(snapshot?.governance?.pending_approvals) ? snapshot.governance.pending_approvals : [];
  const companies = Array.isArray(snapshot?.portfolio?.companies) ? snapshot.portfolio.companies : [];
  const workflows = Array.isArray(snapshot?.mission_control?.active_workflows) ? snapshot.mission_control.active_workflows : [];
  const insights = Array.isArray(snapshot?.autonomy_kernel?.open_insights) ? snapshot.autonomy_kernel.open_insights : [];
  const systemStatuses = Array.isArray(snapshot?.cross_system_orchestration?.system_statuses) ? snapshot.cross_system_orchestration.system_statuses : [];
  const topEnchantmentCategories = Array.isArray(snapshot?.enchantment_lab?.top_candidates)
    ? [...new Set(snapshot.enchantment_lab.top_candidates.map((item) => item.category).filter(Boolean))].join(',')
    : '';
  const fieldValues = {
    decisionTitle: approvals[0]?.title || alerts[0]?.title || recommendations[0] || '',
    decisionBody: approvals[0]?.rationale || alerts[0]?.detail || recommendations[1] || '',
    reasonQuestion: recommendations[0] || '',
    knowledgeQuery: alerts[0]?.title || insights[0]?.title || '',
    swarmTask: recommendations[2] || '',
    approvalTitle: approvals[0]?.title || recommendations[0] || '',
    approvalAction: recommendations[1] || '',
    missionCommand: recommendations[0] || '',
    playbookKey: workflows[0]?.template_key || '',
    playbookTitle: workflows[0]?.title || '',
    federationFocus: systemStatuses.map((status) => `${status.system}: ${status.status}`).join(', '),
    federationRouteTask: recommendations[3] || '',
    federationExecuteTask: recommendations[4] || '',
    contentTopic: companies[0]?.name || '',
    contentFacts: [
      healthForecast?.health_score != null ? `Health forecast: ${healthForecast.health_score}%` : '',
      `Pending approvals: ${approvals.length}`,
      `Open alerts: ${alerts.length}`,
      recommendations[0] || '',
    ].filter(Boolean).join('\n'),
    autonomyAction: recommendations[5] || '',
    carbonTask: recommendations[4] || '',
    contextTask: recommendations[1] || '',
    boardProposal: recommendations[0] || '',
    constitutionalAction: recommendations[0] || '',
    planCategories: topEnchantmentCategories,
    teamSignal: healthForecast?.capability_gap_score != null && healthForecast.capability_gap_score >= 0.3 ? 'Live capability gap detected; propose capacity.' : '',
    ztActor: '',
    ztResource: '',
    ztScope: '',
  };

  for (const [id, value] of Object.entries(fieldValues)) {
    const field = document.getElementById(id);
    if (field && 'value' in field) {
      field.value = String(value || '');
    }
  }
}

function jarvis2List(items, renderItem) {
  return `<div class="jarvis2-list">${items.map(renderItem).join('') || '<div class="jarvis2-empty">Nothing to show.</div>'}</div>`;
}

function jarvis2Sparkline(values) {
  const numbers = values.map((value) => Number(value)).filter((value) => !Number.isNaN(value));
  if (!numbers.length) return '<div class="jarvis2-empty">No graph data.</div>';
  const width = 300;
  const height = 84;
  const max = Math.max(...numbers);
  const min = Math.min(...numbers);
  const span = max - min || 1;
  const points = numbers
    .map((value, index) => {
      const x = numbers.length === 1 ? width / 2 : (index / (numbers.length - 1)) * width;
      const y = height - ((value - min) / span) * (height - 16) - 8;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg class="jarvis2-sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="Sparkline chart"><polyline points="${points}"/></svg>`;
}

function jarvis2ChartBars(items, accentClass = '') {
  const max = Math.max(...items.map((item) => Number(item.value) || 0), 1);
  return `<div class="jarvis2-chart ${accentClass}">${items
    .map((item) => {
      const value = Number(item.value) || 0;
      const width = Math.max(4, (value / max) * 100);
      return `<div class="jarvis2-chart-row"><div class="jarvis2-chart-labels"><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.detail || '')}</small></div><div class="jarvis2-chart-bar"><span style="width:${width}%"></span></div><strong>${escapeHtml(item.value)}</strong></div>`;
    })
    .join('')}</div>`;
}

function unifiedProviderQuery() {
  const input = document.getElementById('providerSearch');
  return String(input?.value ?? unifiedState.providerQuery ?? '').trim().toLowerCase();
}

function unifiedSelectProvider(providerId) {
  unifiedState.selectedProviderId = providerId || null;
  const provider = unifiedState.providers.find((item) => item.id === unifiedState.selectedProviderId);
  unifiedState.selectedModelId = provider?.models?.[0]?.id || null;
  renderUnifiedDashboard();
}

function unifiedSelectModel(modelId) {
  unifiedState.selectedModelId = modelId || null;
  renderUnifiedDashboard();
}

function unifiedProviderSearchChanged() {
  unifiedState.providerQuery = unifiedProviderQuery();
  renderUnifiedDashboard();
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

function unifiedVisibleProviders() {
  const query = unifiedProviderQuery();
  const providers = Array.isArray(unifiedState.providers) ? unifiedState.providers : [];
  return providers.filter((provider) => {
    if (!query) return true;
    const haystack = [
      provider.name,
      provider.category,
      provider.description,
      ...(Array.isArray(provider.models) ? provider.models.map((model) => `${model.id} ${model.name} ${model.notes || ''}`) : []),
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

function unifiedCategoryCounts(providers) {
  const counts = new Map();
  for (const provider of providers) {
    counts.set(provider.category, (counts.get(provider.category) || 0) + 1);
  }
  return [...counts.entries()].map(([label, value]) => ({ label, value }));
}

function unifiedModelCountByProvider(providers) {
  return providers.map((provider) => ({ label: provider.name, value: Array.isArray(provider.models) ? provider.models.length : 0, detail: provider.category }));
}

function unifiedProviderChooserHtml() {
  const filteredProviders = unifiedVisibleProviders();
  if (!filteredProviders.length) {
    return '<div class="jarvis2-empty">No providers match your search.</div>';
  }
  const selectedProvider = filteredProviders.find((provider) => provider.id === unifiedState.selectedProviderId) || filteredProviders[0];
  if (selectedProvider && selectedProvider.id !== unifiedState.selectedProviderId) {
    unifiedState.selectedProviderId = selectedProvider.id;
  }
  const models = Array.isArray(selectedProvider?.models) ? selectedProvider.models : [];
  const selectedModel = models.find((model) => model.id === unifiedState.selectedModelId) || models[0] || null;
  if (selectedModel && selectedModel.id !== unifiedState.selectedModelId) {
    unifiedState.selectedModelId = selectedModel.id;
  }
  return `
    <div class="jarvis2-provider-grid">
      <article class="jarvis2-provider-list card">
        <h3>Providers</h3>
        ${jarvis2List(filteredProviders, (provider) => `
          <div class="jarvis2-item ${provider.id === selectedProvider.id ? 'selected' : ''}" onclick="unifiedSelectProvider('${escapeHtml(provider.id)}')">
            <div class="jarvis2-item-head">
              <strong>${escapeHtml(provider.name)}</strong>
              <span class="jarvis2-badge info">${escapeHtml(provider.category)}</span>
            </div>
            <p>${escapeHtml(provider.description)}</p>
            <div class="jarvis2-item-foot">${escapeHtml(Array.isArray(provider.models) ? provider.models.length : 0)} models</div>
          </div>
        `)}
      </article>
      <article class="jarvis2-provider-detail card">
        <h3>${escapeHtml(selectedProvider.name)}</h3>
        <p class="jarvis2-label">${escapeHtml(selectedProvider.category)}</p>
        <p>${escapeHtml(selectedProvider.description)}</p>
        <p class="jarvis2-detail">Website: ${escapeHtml(selectedProvider.website || '')}</p>
        <div class="jarvis2-feature">
          <span class="jarvis2-badge good">${escapeHtml(selectedProvider.models.length)} models</span>
          <span class="jarvis2-badge info">${escapeHtml(selectedProvider.refresh_mode || 'catalog')}</span>
        </div>
        <div class="jarvis2-list">${models.map((model) => `
          <div class="jarvis2-item ${model.id === unifiedState.selectedModelId ? 'selected' : ''}" onclick="unifiedSelectModel('${escapeHtml(model.id)}')">
            <div class="jarvis2-item-head">
              <strong>${escapeHtml(model.name)}</strong>
              <span class="jarvis2-badge warn">${escapeHtml(model.context_window)}</span>
            </div>
            <p>${escapeHtml(model.notes || '')}</p>
            <div class="jarvis2-item-foot">${escapeHtml((model.modalities || []).join(' · '))}</div>
          </div>
        `).join('')}</div>
        ${selectedModel ? `<div class="jarvis2-detail">Selected model: <strong>${escapeHtml(selectedModel.name)}</strong> (${escapeHtml(selectedModel.id)})</div>` : ''}
      </article>
    </div>`;
}

function unifiedAnalyticsHtml() {
  const snapshot = unifiedState.snapshot || {};
  const portfolio = snapshot.portfolio || {};
  const governance = snapshot.governance || {};
  const missionControl = snapshot.mission_control || {};
  const people = snapshot.people_and_agents || {};
  const orchestration = snapshot.cross_system_orchestration || {};
  const health = unifiedState.healthForecast || {};
  const providers = Array.isArray(unifiedState.providers) ? unifiedState.providers : [];
  const providerCategoryCounts = unifiedCategoryCounts(providers);
  const pressureChart = jarvis2ChartBars([
    { label: 'Tasks', value: portfolio.open_tasks || 0, detail: 'Open tasks' },
    { label: 'Approvals', value: Array.isArray(governance.pending_approvals) ? governance.pending_approvals.length : 0, detail: 'Pending approvals' },
    { label: 'Alerts', value: Array.isArray(governance.alerts) ? governance.alerts.length : 0, detail: 'Open alerts' },
    { label: 'Workflows', value: Array.isArray(missionControl.active_workflows) ? missionControl.active_workflows.length : 0, detail: 'Running workflows' },
    { label: 'Traces', value: orchestration.trace_count || 0, detail: 'Federation traces' },
  ]);
  const providerModelChart = jarvis2ChartBars(unifiedModelCountByProvider(providers).slice(0, 10));
  return `
    <div class="jarvis2-analytics-grid">
      <article class="card jarvis2-card">
        <h3>Corporate Health</h3>
        ${jarvis2Metric('Health Score', `${health.health_score ?? 0}%`, `Horizon ${health.horizon_days ?? 90} days`)}
        ${jarvis2Sparkline([health.health_score ?? 0, 100 - (Number(health.burnout_risk ?? 0) * 100), 100 - (Number(health.strategic_risk ?? 0) * 100), 100 - (Number(health.capability_gap_score ?? 0) * 100)])}
      </article>
      <article class="card jarvis2-card wide">
        <h3>Corporate Pressure</h3>
        ${pressureChart}
      </article>
      <article class="card jarvis2-card">
        <h3>Provider Categories</h3>
        ${jarvis2ChartBars(providerCategoryCounts)}
      </article>
      <article class="card jarvis2-card">
        <h3>Provider Depth</h3>
        ${providerModelChart}
      </article>
      <article class="card jarvis2-card wide">
        <h3>Operational Overview</h3>
        <div class="jarvis2-mini-grid">
          ${jarvis2Metric('Companies', `${portfolio.company_count ?? 0}`, `${portfolio.average_health ?? 0}% average health`)}
          ${jarvis2Metric('Active Agents', `${people.federated_agents ?? 0}`, `${people.agent_health ?? 0}% agent health`)}
          ${jarvis2Metric('Open Insights', `${Array.isArray(snapshot.autonomy_kernel?.open_insights) ? snapshot.autonomy_kernel.open_insights.length : 0}`, 'Autonomy kernel')}
          ${jarvis2Metric('V5 Coverage', `${unifiedState.v5Audit?.score ?? 0}%`, `${Array.isArray(unifiedState.v5Audit?.remaining_gaps) ? unifiedState.v5Audit.remaining_gaps.length : 0} gaps`)}
        </div>
      </article>
    </div>`;
}

function unifiedSummaryHtml() {
  const snapshot = unifiedState.snapshot || {};
  const portfolio = snapshot.portfolio || {};
  const governance = snapshot.governance || {};
  const missionControl = snapshot.mission_control || {};
  const integrations = Array.isArray(unifiedState.integrations.integrations) ? unifiedState.integrations.integrations : [];
  const approvals = Array.isArray(unifiedState.approvals.approvals) ? unifiedState.approvals.approvals : [];
  const workflows = Array.isArray(unifiedState.workflows.workflows) ? unifiedState.workflows.workflows : [];
  const insights = Array.isArray(unifiedState.insights.insights) ? unifiedState.insights.insights : [];
  const alerts = Array.isArray(governance.alerts) ? governance.alerts : [];
  const providers = Array.isArray(unifiedState.providers) ? unifiedState.providers : [];
  const providerModels = providers.reduce((sum, provider) => sum + (Array.isArray(provider.models) ? provider.models.length : 0), 0);
  return `
    <div class="jarvis2-mini-grid">
      ${jarvis2Metric('Companies', `${portfolio.company_count ?? 0}`, `${portfolio.average_health ?? 0}% avg health`)}
      ${jarvis2Metric('Agents', `${unifiedState.agents.length}`, `${Array.isArray(snapshot.people_and_agents?.workload?.by_role) ? snapshot.people_and_agents.workload.by_role.length : 0} workload buckets`)}
      ${jarvis2Metric('Approvals', `${approvals.length}`, `${alerts.length} alerts`)}
      ${jarvis2Metric('Workflows', `${workflows.length}`, `${integrations.length} integrations`)}
      ${jarvis2Metric('Providers', `${providers.length}`, `${providerModels} models`)}
      ${jarvis2Metric('Insights', `${insights.length}`, `${unifiedState.loadedAt ? unifiedState.loadedAt.toLocaleTimeString() : 'not loaded'}`)}
    </div>
    <div class="jarvis2-grid">
      <article class="card jarvis2-card wide">
        <h3>Live Summary</h3>
        <p class="jarvis2-detail">${escapeHtml(snapshot.ceo_recommendations?.[0] || 'Live data is loaded from platform, workers, provider catalog, and corporate metrics endpoints.')}</p>
        ${jarvis2List([
          { title: 'Open tasks', summary: String(portfolio.open_tasks ?? 0) },
          { title: 'Pending approvals', summary: String(approvals.length) },
          { title: 'Open alerts', summary: String(alerts.length) },
          { title: 'Queued workflows', summary: String(workflows.length) },
        ], (item) => `<div class="jarvis2-item"><div class="jarvis2-item-head"><strong>${escapeHtml(item.title)}</strong><span class="jarvis2-badge info">live</span></div><p>${escapeHtml(item.summary)}</p></div>`)}
      </article>
    </div>`;
}

function renderUnifiedDashboard() {
  const dashboard = document.getElementById('unifiedDashboard');
  const providerCatalog = document.getElementById('providerCatalog');
  const corpAnalytics = document.getElementById('corpAnalytics');
  const snapshot = document.getElementById('snapshot');
  const meta = document.getElementById('jarvis2Meta');
  const providerSearch = document.getElementById('providerSearch');
  const providerSelect = document.getElementById('providerSelect');
  const modelSelect = document.getElementById('modelSelect');
  const filteredProviders = unifiedVisibleProviders();
  const selectedProvider = filteredProviders.find((provider) => provider.id === unifiedState.selectedProviderId) || filteredProviders[0] || null;
  const selectedModels = Array.isArray(selectedProvider?.models) ? selectedProvider.models : [];
  const selectedModel = selectedModels.find((model) => model.id === unifiedState.selectedModelId) || selectedModels[0] || null;
  if (selectedProvider) {
    unifiedState.selectedProviderId = selectedProvider.id;
  }
  if (selectedModel) {
    unifiedState.selectedModelId = selectedModel.id;
  }
  if (providerSearch && providerSearch.value !== unifiedState.providerQuery) {
    providerSearch.value = unifiedState.providerQuery;
  }
  if (providerSelect) {
    providerSelect.innerHTML = filteredProviders.map((provider) => `<option value="${escapeHtml(provider.id)}" ${provider.id === unifiedState.selectedProviderId ? 'selected' : ''}>${escapeHtml(provider.name)} · ${escapeHtml(provider.category)}</option>`).join('');
    providerSelect.value = unifiedState.selectedProviderId || '';
  }
  if (modelSelect) {
    modelSelect.innerHTML = selectedModels.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === unifiedState.selectedModelId ? 'selected' : ''}>${escapeHtml(model.name)} · ${escapeHtml(model.context_window)}</option>`).join('');
    modelSelect.value = unifiedState.selectedModelId || '';
  }
  if (dashboard) dashboard.innerHTML = unifiedSummaryHtml();
  if (providerCatalog) providerCatalog.innerHTML = unifiedProviderChooserHtml();
  if (corpAnalytics) corpAnalytics.innerHTML = unifiedAnalyticsHtml();
  if (snapshot && unifiedState.snapshot) {
    snapshot.textContent = pretty({
      generated_at: unifiedState.loadedAt?.toISOString() || null,
      providers: unifiedState.providers.length,
      models: unifiedState.providers.reduce((sum, provider) => sum + (Array.isArray(provider.models) ? provider.models.length : 0), 0),
      health: unifiedState.healthForecast,
      audit_score: unifiedState.v5Audit?.score ?? null,
    });
  }
  if (meta) {
    meta.textContent = `${unifiedState.providers.length} providers · ${unifiedState.providers.reduce((sum, provider) => sum + (Array.isArray(provider.models) ? provider.models.length : 0), 0)} models · ${unifiedState.integrations.integrations?.length ?? 0} integrations · ${unifiedState.loadedAt ? unifiedState.loadedAt.toLocaleTimeString() : 'loading'}`;
  }
}

async function loadUnifiedDashboard(force = false) {
  if (unifiedState.loading) return;
  if (!force && unifiedState.snapshot) {
    renderUnifiedDashboard();
    return;
  }
  unifiedState.loading = true;
  set('status', 'Loading unified dashboard…');
  try {
    const [snapshot, agents, briefing, ritual, healthForecast, v5Audit, integrations, approvals, workflows, insights, providers] = await Promise.all([
      api('/dashboard/god-view'),
      api('/agents'),
      api('/ceo/morning-briefing'),
      api('/mission-control/daily-ritual'),
      api('/v5/company/health-forecast'),
      api('/v5/audit'),
      api('/integrations'),
      api('/governance/approvals?status=all'),
      api('/mission-control/workflows?status=all'),
      api('/autonomy/insights'),
      api('/providers/catalog'),
    ]);
    unifiedState.snapshot = snapshot;
    unifiedState.agents = Array.isArray(agents.agents) ? agents.agents : [];
    unifiedState.briefing = briefing;
    unifiedState.ritual = ritual;
    unifiedState.healthForecast = healthForecast;
    unifiedState.v5Audit = v5Audit;
    unifiedState.integrations = integrations;
    unifiedState.approvals = approvals;
    unifiedState.workflows = workflows;
    unifiedState.insights = insights;
    unifiedState.providers = Array.isArray(providers.providers) ? providers.providers : [];
    unifiedState.loadedAt = new Date();
    if (!unifiedState.seededDefaults) {
      jarvis2SeedLiveDefaults(snapshot, healthForecast);
      unifiedState.seededDefaults = true;
    }
    if (!unifiedState.selectedProviderId) {
      unifiedState.selectedProviderId = unifiedState.providers[0]?.id || null;
    }
    const selectedProvider = unifiedState.providers.find((provider) => provider.id === unifiedState.selectedProviderId) || unifiedState.providers[0] || null;
    if (selectedProvider && (!Array.isArray(selectedProvider.models) || !selectedProvider.models.find((model) => model.id === unifiedState.selectedModelId))) {
      unifiedState.selectedModelId = selectedProvider.models?.[0]?.id || null;
    }
    renderUnifiedDashboard();
    set('status', `Unified dashboard loaded ${unifiedState.loadedAt.toLocaleTimeString()}`);
  } catch (e) {
    set('status', 'Error: ' + e.message);
    const dashboard = document.getElementById('unifiedDashboard');
    if (dashboard) dashboard.innerHTML = '<div class="jarvis2-empty">Failed to load unified dashboard.</div>';
  } finally {
    unifiedState.loading = false;
  }
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
    const [snapshot, agents, briefing, ritual, healthForecast, v5Audit] = await Promise.all([
      api('/dashboard/god-view'),
      api('/agents'),
      api('/ceo/morning-briefing'),
      api('/mission-control/daily-ritual'),
      api('/v5/company/health-forecast'),
      api('/v5/audit'),
    ]);
    jarvis2State.snapshot = snapshot;
    jarvis2State.agents = Array.isArray(agents.agents) ? agents.agents : [];
    jarvis2State.briefing = briefing;
    jarvis2State.ritual = ritual;
    jarvis2State.healthForecast = healthForecast;
    jarvis2State.v5Audit = v5Audit;
    jarvis2State.loadedAt = new Date();
    const alerts = snapshot?.governance?.alerts || [];
    jarvis2State.selectedAlertId = jarvis2State.selectedAlertId || (alerts[0] ? String(alerts[0].id) : null);
    if (!jarvis2State.seededDefaults) {
      jarvis2SeedLiveDefaults(snapshot, healthForecast);
      jarvis2State.seededDefaults = true;
    }
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
    const health = jarvis2State.healthForecast || {};
    const v5Audit = jarvis2State.v5Audit || {};
    return `
      <div class="jarvis2-mini-grid">
        ${jarvis2Metric('Company Health', `${health.health_score ?? 0}%`, `Forecast horizon ${health.horizon_days ?? 90} days`)}
        ${jarvis2Metric('Burnout Risk', jarvis2Percent(health.burnout_risk), 'Live company forecast')}
        ${jarvis2Metric('Strategic Risk', jarvis2Percent(health.strategic_risk), 'Live company forecast')}
        ${jarvis2Metric('Capability Gap', jarvis2Percent(health.capability_gap_score), 'Live company forecast')}
        ${jarvis2Metric('Ready Capabilities', `${capability.ready ?? 0}/${capability.total ?? 0}`, `${capability.approval_gated ?? 0} approval gated`)}
        ${jarvis2Metric('V5 Coverage', `${v5Audit.score ?? 0}%`, `${Array.isArray(v5Audit.remaining_gaps) ? v5Audit.remaining_gaps.length : 0} remaining gaps`)}
        ${jarvis2Metric('Open Alerts', `${alerts.length}`, `${governance.open_risk_score ?? 0} risk score`)}
        ${jarvis2Metric('Open Insights', `${autonomy.open_insights?.length ?? 0}`, `${orchestration.trace_count ?? 0} trace events`)}
      </div>
      <div class="jarvis2-detail">Live metrics pulled from the dashboard snapshot, company health forecast, and v5 audit.</div>`;
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
loadUnifiedDashboard();
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
