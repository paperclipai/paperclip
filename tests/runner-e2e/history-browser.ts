import { retainedSuiteLabels, type ReportExecution } from "./report-catalog.js";
import type { RunnerE2EHistoryCampaign, RunnerE2EHistoryIndex, RunnerE2ESuiteSummary } from "./types.js";

export function fullSuiteSelection(suite: RunnerE2ESuiteSummary) {
  return suite.complete && suite.expected > 0 && suite.selected === suite.expected;
}

export function historySuiteCoverage(suite: RunnerE2ESuiteSummary) {
  if (fullSuiteSelection(suite)) return suite.executed === suite.selected ? "full" : "unfinished";
  return suite.selected < suite.expected ? "subset" : "unknown";
}

export function historySuiteCatalog(history: RunnerE2EHistoryIndex, catalog: readonly ReportExecution[]) {
  const suites = new Map(catalog.map(row => [row.suite.id, { id: row.suite.id, label: row.suite.label }]));
  for (const campaign of history.campaigns) for (const suite of campaign.suites) {
    if (!suites.has(suite.suiteId)) suites.set(suite.suiteId, {
      id: suite.suiteId, label: retainedSuiteLabels[suite.suiteId] ?? suite.suiteId.replaceAll("-", " "),
    });
  }
  return [...suites.values()].map(suite => ({ ...suite,
    campaignCount: history.campaigns.filter(campaign => campaign.suites.some(row => row.suiteId === suite.id)).length,
  })).sort((a, b) => a.label.localeCompare(b.label));
}

/** Only recorded metadata is searchable; old records keep an explicit unknown target. */
export function historyBrowserCampaign(campaign: RunnerE2EHistoryCampaign) {
  return {
    id: campaign.campaignId, date: campaign.generatedAt, url: campaign.publicUrl,
    search: [campaign.campaignId, campaign.source.sha, campaign.source.ref].filter(Boolean).join(" ").toLowerCase(),
    complete: campaign.complete, selected: campaign.selected, executed: campaign.executed,
    passed: campaign.passed, failed: campaign.failed, incomplete: campaign.incomplete ?? 0,
    cleanup: campaign.cleanupPassed, preset: campaign.preset ?? "",
    coverage: campaign.complete && campaign.selected > 0
      ? campaign.executed === campaign.selected ? "full" : "unfinished"
      : "subset",
    suites: campaign.suites.map(suite => ({ id: suite.suiteId, full: historySuiteCoverage(suite) === "full", coverage: historySuiteCoverage(suite),
      expected: suite.expected, selected: suite.selected, executed: suite.executed, passed: suite.passed,
      failed: suite.failed, incomplete: suite.incomplete ?? 0, cleanup: suite.cleanupPassed, hash: suite.suiteDefinitionHash })),
    executions: campaign.executions.map(execution => {
      let target = "__unknown__";
      try {
        const url = new URL(execution.targetUrl ?? "");
        if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) target = url.origin;
      } catch { /* Historical records did not retain the application URL. */ }
      return { suite: execution.suiteId, profile: execution.profileId, environment: execution.environmentId,
        provider: execution.provider ?? (execution.runtimeMode === "none" ? "__none__" : "__unknown__"),
        model: execution.model ?? (execution.runtimeMode === "none" ? "__none__" : "__unknown__"),
        runtime: execution.runtimeMode ?? "__unknown__", target, case: execution.caseId,
        status: execution.status, cleanup: execution.cleanup, executed: execution.attempt > 0 };
    }),
  };
}

export function historyBrowserJson(history: RunnerE2EHistoryIndex, catalog: readonly ReportExecution[]) {
  return JSON.stringify({ suites: historySuiteCatalog(history, catalog),
    campaigns: [...history.campaigns].sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt)).map(historyBrowserCampaign),
  }).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export const historyBrowserScript = String.raw`
(() => {
  const data = JSON.parse(document.querySelector('[data-index-data]').textContent);
  const shell = document.querySelector('.report-shell');
  const rows = new Map([...document.querySelectorAll('[data-index-campaign]')].map(row => [row.dataset.indexId, row]));
  const suiteLabels = new Map(data.suites.map(suite => [suite.id, suite.label]));
  const names = ['suite','coverage','target','environment','provider','model','profile','runtime','preset','status','from','through','q'];
  const executionNames = ['target','environment','provider','model','profile','runtime'];
  const controls = Object.fromEntries(names.map(name => [name, document.querySelector('[data-index-filter="'+name+'"]')]));
  const unknown = value => value === '__none__' ? 'Browser only' : value === '__unknown__' ? 'Not recorded' : value;
  const label = (name, value) => name === 'suite' ? suiteLabels.get(value) || value :
    name === 'target' && value !== '__unknown__' ? (new URL(value).hostname === 'qa.test.paperclip.app' ? 'QA staging · ' : '') + value :
    name === 'preset' && value === 'qa-smoke' ? 'QA smoke' : unknown(value);
  for (const name of [...executionNames, 'preset']) {
    const values = [...new Set(data.campaigns.flatMap(campaign => name === 'preset' ? [campaign.preset].filter(Boolean) : campaign.executions.map(execution => execution[name])))].sort();
    for (const value of values) { const option = document.createElement('option'); option.value = value; option.textContent = label(name, value); controls[name].append(option); }
  }
  let state = {}, view = 'overview';
  const reportHref = campaign => {
    const url = new URL(campaign.url,location.href); url.searchParams.set('view','all');
    for (const name of ['suite','profile','environment']) if (state[name]) url.searchParams.set(name,state[name]);
    if (state.suite) url.hash = 'suite-' + state.suite;
    return url.href;
  };
  const status = counts => counts.failed > 0 || !counts.cleanup || counts.executed < counts.selected ? 'failed' : counts.incomplete > 0 ? 'incomplete' : 'passed';
  const selection = campaign => {
    const suite = state.suite ? campaign.suites.find(suite => suite.id === state.suite) : null;
    if (state.suite && !suite || state.preset && campaign.preset !== state.preset) return null;
    if (state.from && campaign.date.slice(0,10) < state.from || state.through && campaign.date.slice(0,10) > state.through) return null;
    const executions = campaign.executions.filter(execution => (!state.suite || execution.suite === state.suite) && executionNames.every(name => !state[name] || execution[name] === state[name]));
    const narrowed = executionNames.some(name => state[name]);
    if (narrowed && !executions.length) return null;
    const search = [campaign.search, ...executions.flatMap(execution => Object.values(execution)),
      ...campaign.suites.filter(item => !state.suite || item.id === state.suite).map(item => suiteLabels.get(item.id))].join(' ').toLowerCase();
    if (state.q && !search.includes(state.q.trim().toLowerCase())) return null;
    const counts = narrowed ? { selected: executions.length, executed: executions.filter(execution => execution.executed).length,
      passed: executions.filter(execution => execution.status === 'passed' && execution.cleanup === 'passed').length,
      failed: executions.filter(execution => execution.status === 'failed').length,
      incomplete: executions.filter(execution => execution.status === 'incomplete').length,
      cleanup: executions.every(execution => execution.cleanup === 'passed') } : suite || campaign;
    const result = status(counts);
    if (state.status && result !== state.status || view === 'attention' && result === 'passed') return null;
    const coverage = suite ? suite.coverage : campaign.coverage;
    return { campaign, suite, counts, result, full: coverage === 'full', coverage, narrowed };
  };
  const fillPointer = (kind, selected) => {
    const root = document.querySelector('[data-index-latest="'+kind+'"]');
    const link = root.querySelector('a'), detail = root.querySelector('small');
    link.hidden = !selected;
    if (!selected) { detail.textContent = kind === 'full' ? 'No full run recorded for these filters.' : 'No matching run recorded.'; link.removeAttribute('href'); return; }
    link.href = reportHref(selected.campaign);
    link.textContent = selected.campaign.id;
    detail.textContent = new Date(selected.campaign.date).toLocaleString('en-US',{timeZone:'UTC'}) + ' UTC · ' +
      selected.counts.passed + '/' + selected.counts.selected + ' passed' + (selected.suite ? ' · ' + selected.suite.selected + '/' + selected.suite.expected + ' selected · definition ' + selected.suite.hash.slice(0,8) : '') +
      (kind === 'full' && state.coverage && state.coverage !== 'full' ? ' · across coverage selections' : '');
  };
  const apply = () => {
    shell.dataset.view = view;
    const activeCount = names.filter(name => state[name]).length;
    const active = activeCount > 0;
    for (const name of names) controls[name].dataset.filterActive = String(Boolean(state[name]));
    const activeLabel = document.querySelector('[data-index-active-count]');
    activeLabel.textContent = active ? activeCount + ' active' : 'None active';
    activeLabel.dataset.active = String(active);
    document.querySelector('[data-index-reset]').dataset.active = String(active);
    const moreCount = names.filter(name => !['suite','coverage','target','q'].includes(name) && state[name]).length;
    const moreLabel = document.querySelector('[data-index-more-count]');
    moreLabel.hidden = moreCount === 0;
    moreLabel.textContent = moreCount + ' active';
    const selectedLabel = state.suite ? suiteLabels.get(state.suite) || state.suite : '';
    document.querySelector('[data-index-title]').textContent = selectedLabel || (view === 'attention' ? 'Needs attention' : 'E2E tests');
    document.querySelector('[data-index-description]').textContent = state.suite ? 'Campaigns that included this suite. Full runs selected and executed the entire recorded suite definition; failed tests remain visible.' : 'Browse suites and retained campaigns across deployment targets, agent execution environments, and models.';
    document.querySelector('[data-index-overview]').hidden = view !== 'overview' || active;
    document.querySelector('[data-index-trends]').hidden = view !== 'history' || active;
    document.querySelector('.summary').hidden = active;
    document.querySelector('[data-index-suite-summary]').hidden = !state.suite;
    const candidates = data.campaigns.map(selection).filter(Boolean);
    fillPointer('any', candidates.find(row => !state.coverage || row.coverage === state.coverage));
    fillPointer('full', candidates.find(row => row.full));
    let visible = 0;
    for (const campaign of data.campaigns) rows.get(campaign.id).hidden = true;
    for (const selected of candidates) {
      if (state.coverage && state.coverage !== selected.coverage) continue;
      if (view === 'overview' && !active && visible >= 10) continue;
      const row = rows.get(selected.campaign.id); row.hidden = false; visible++;
      for (const link of row.querySelectorAll('.campaign-link,.open-cell > a')) link.href = reportHref(selected.campaign);
      const result = row.querySelector('[data-index-row-status]'); result.textContent = selected.result; result.className = 'status status-' + selected.result;
      row.querySelector('[data-index-row-counts]').textContent = selected.counts.passed + '/' + selected.counts.selected + (selected.narrowed ? ' matching executions passed' : state.suite ? ' suite executions passed' : ' passed') + ' · ' + selected.counts.executed + ' executed';
      const coverageLabel = {full:'Full run',subset:'Subset selection',unfinished:'Unfinished full selection',unknown:'Coverage not established'}[selected.coverage];
      row.querySelector('[data-index-row-coverage]').textContent = coverageLabel + (selected.suite ? ' · ' + selected.suite.selected + '/' + selected.suite.expected + ' selected' : '');
    }
    document.querySelector('[data-index-result]').textContent = visible + ' matching campaign' + (visible === 1 ? '' : 's') + (view === 'overview' && !active && candidates.length > 10 ? ' · Showing the 10 most recent; open Campaign history for all.' : '');
    document.querySelector('[data-index-empty]').hidden = visible !== 0;
    const presetHasSuite = data.campaigns.some(campaign => campaign.preset === state.preset && campaign.suites.some(suite => suite.id === state.suite));
    const incompatiblePreset = state.suite && state.preset && !presetHasSuite;
    document.querySelector('[data-index-empty-message]').textContent = incompatiblePreset
      ? 'No ' + selectedLabel + ' campaigns are included in ' + label('preset', state.preset) + '.'
      : 'No campaigns match these filters.';
    const suiteRuns = document.querySelector('[data-index-empty-suite]');
    suiteRuns.hidden = !incompatiblePreset;
    if (incompatiblePreset) {
      suiteRuns.href = '?view=history&suite=' + encodeURIComponent(state.suite);
      suiteRuns.textContent = 'View ' + selectedLabel + ' runs';
    }
    controls.coverage.closest('label').querySelector('span').textContent = state.suite ? 'Suite coverage' : 'Campaign coverage';
    controls.coverage.setAttribute('aria-label',state.suite ? 'Suite coverage' : 'Campaign coverage');
    document.querySelectorAll('[data-index-suite-link]').forEach(link => { if (link.dataset.indexSuiteLink === state.suite) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
    document.querySelectorAll('[data-nav-view]').forEach(link => { if (link.dataset.navView === view && !state.suite) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
    document.querySelectorAll('[data-index-preset-link]').forEach(link => { if (link.dataset.indexPresetLink === state.preset) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
    document.querySelectorAll('[data-history-suite-trends]').forEach(section => { section.hidden = Boolean(state.suite) && section.dataset.historySuiteTrends !== state.suite; });
    const crumbs = document.querySelector('[data-nav-breadcrumbs]'); crumbs.replaceChildren();
    const home = document.createElement('a'); home.href = '?view=history'; home.textContent = 'E2E tests'; crumbs.append(home);
    const separator = document.createElement('span'); separator.textContent = '/'; separator.setAttribute('aria-hidden','true'); crumbs.append(separator);
    const current = document.createElement('span'); current.textContent = selectedLabel || (view === 'attention' ? 'Needs attention' : view === 'overview' ? 'Overview' : 'Campaign history'); current.setAttribute('aria-current','page'); crumbs.append(current);
  };
  const write = push => {
    const url = new URL(location.href); url.search = ''; url.searchParams.set('view',view);
    for (const name of names) if (state[name]) url.searchParams.set(name,state[name]);
    history[push ? 'pushState' : 'replaceState'](null,'',url); read();
  };
  const read = () => {
    const params = new URLSearchParams(location.search); view = ['history','attention'].includes(params.get('view')) ? params.get('view') : 'overview';
    state = Object.fromEntries(names.map(name => [name,params.get(name) || '']));
    for (const name of names) {
      const control = controls[name];
      if (control.tagName === 'SELECT' && state[name] && ![...control.options].some(option => option.value === state[name])) {
        const option = document.createElement('option'); option.value = state[name]; option.textContent = 'Unknown: ' + state[name]; control.append(option);
      }
      control.value = state[name];
    }
    if (names.filter(name => !['suite','coverage','target','q'].includes(name)).some(name => state[name])) document.querySelector('[data-index-more]').open = true;
    apply();
  };
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('[data-index-suite-link],[data-index-preset-link],[data-nav-view]'); if (!link) return;
    event.preventDefault();
    if (link.hasAttribute('data-index-suite-link')) { state = { suite: link.dataset.indexSuiteLink }; view = 'history'; }
    else if (link.hasAttribute('data-index-preset-link')) { state = {}; state.preset = link.dataset.indexPresetLink; view = 'history'; }
    else { view = link.dataset.navView; if (view === 'overview') state = {}; }
    write(true); window.scrollTo({top:0,behavior:'instant'});
  });
  for (const name of names) controls[name].addEventListener(name === 'q' ? 'input' : 'change', () => { state[name] = controls[name].value; write(name !== 'q'); });
  document.querySelector('[data-index-reset]').addEventListener('click', () => {
    state = {}; view = 'history';
    const suiteSearch = document.querySelector('[data-index-suite-query]');
    suiteSearch.value = ''; suiteSearch.dataset.filterActive = 'false';
    document.querySelectorAll('.report-suite-catalog a').forEach(link => { link.hidden = false; });
    write(true);
  });
  const suiteSearch = document.querySelector('[data-index-suite-query]');
  suiteSearch.addEventListener('input', () => {
    suiteSearch.dataset.filterActive = String(Boolean(suiteSearch.value));
    for (const link of document.querySelectorAll('.report-suite-catalog a')) link.hidden = !link.textContent.toLowerCase().includes(suiteSearch.value.trim().toLowerCase());
  });
  window.addEventListener('popstate',read); read();
})();
`;
