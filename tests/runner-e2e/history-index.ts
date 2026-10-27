import { renderReportHistory, reportHistoryStyles, reportHistoryScript } from "./report-history.js";
import { renderReportShell, reportNavigationStyles, reportShellScript } from "./report-navigation.js";
import { runnerMatrix } from "./catalog.js";
import { campaignSuiteSummaryStyles, renderCampaignSuiteSummary } from "./campaign-summary.js";
import type {
  RunnerE2EHistoryCampaign,
  RunnerE2EHistoryIndex,
} from "./types.js";

function html(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function number(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function usd(value: number | null) {
  if (value === null) return "Unknown";
  return `$${value.toFixed(value < 0.01 ? 6 : 2)}`;
}

function duration(durationMs: number | null) {
  if (durationMs === null) return "Unknown";
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function date(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function campaignStatus(campaign: RunnerE2EHistoryCampaign) {
  if (campaign.failed === 0 && (campaign.incomplete ?? 0) > 0) return "incomplete";
  return campaign.failed === 0 &&
    campaign.passed === campaign.selected &&
    campaign.executed === campaign.selected &&
    campaign.cleanupPassed
    ? "passed"
    : "failed";
}

function sourceCell(campaign: RunnerE2EHistoryCampaign) {
  const sha = campaign.source.sha;
  const shortSha = sha?.slice(0, 8) ?? "Unknown";
  const shaLabel = /^[0-9a-f]{40}$/i.test(sha ?? "")
    ? `<a href="https://github.com/paperclipai/paperclip/commit/${html(sha)}">${html(shortSha)}</a>`
    : html(shortSha);
  const workflow = campaign.source.workflowRunUrl
    ? `<a class="secondary-link" href="${html(campaign.source.workflowRunUrl)}">Workflow run</a>`
    : "";
  return `${shaLabel}<small>${html(campaign.source.ref ?? "Unknown ref")}${workflow}</small>`;
}

function campaignRow(campaign: RunnerE2EHistoryCampaign) {
  const status = campaignStatus(campaign);
  const suites = campaign.suites
    .map(
      (suite) =>
        `<span>${html(suite.suiteId)} · ${suite.passed}/${suite.selected}</span>`,
    )
    .join("");
  const billing = campaign.billing;
  return `<tr data-index-campaign data-index-status="${status}" data-index-search="${html([campaign.campaignId, campaign.source.ref, campaign.source.sha].join(" ").toLowerCase())}">
    <td data-label="Campaign">
      <a class="campaign-link" href="${html(campaign.publicUrl)}">${html(campaign.campaignId)}</a>
      <small>${html(date(campaign.generatedAt))} UTC</small>
    </td>
    <td data-label="Result">
      <span class="status status-${status}">${status}</span>
      <small>${campaign.passed}/${campaign.selected} passed · ${campaign.executed} executed</small>
    </td>
    <td data-label="Source">${sourceCell(campaign)}</td>
    <td class="open-cell" data-label="Details"><a href="${html(campaign.publicUrl)}" aria-label="Open campaign ${html(campaign.campaignId)}">Open report&nbsp;→</a>
      <details class="campaign-row-details"><summary>Suites &amp; billing</summary>
        <div class="suite-list">${suites}</div>
        <p>${campaign.complete ? "Complete campaign" : "Partial campaign"} · ${campaign.retries} retries · cleanup ${campaign.cleanupPassed ? "passed" : "failed"}</p>
        <p>${campaign.failed} failed${campaign.incomplete ? ` · ${campaign.incomplete} incomplete` : ""}</p>
        <p>${html(number(billing.llm.totalTokens))} tokens · ${html(number(billing.llm.inputTokens))} in · ${html(number(billing.llm.outputTokens))} out · ${html(number(billing.llm.cachedInputTokens))} cached</p>
        <p>${html(usd(billing.observedAndEstimatedCostUsd))} recorded cost · ${html(usd(billing.reportedLlmCostUsd))} LLM · ${html(usd(billing.estimatedRuntimeCostUsd))} runtime</p>
        <p>${html(duration(billing.agentRunDurationMs))} agent · ${html(duration(billing.leaseDurationMs))} Daytona lease</p>
      </details>
    </td>
  </tr>`;
}

export function renderRunnerHistoryIndex(
  history: RunnerE2EHistoryIndex,
) {
  const campaigns = [...history.campaigns].sort((left, right) =>
    right.generatedAt.localeCompare(left.generatedAt),
  );
  const passed = campaigns.filter(
    (campaign) => campaignStatus(campaign) === "passed",
  ).length;
  const latest = campaigns.find(
    (campaign) => campaign.campaignId === history.latestCampaignId,
  );
  const latestGreen = campaigns.find(
    (campaign) => campaign.campaignId === history.latestGreenCampaignId,
  );
  const totalCost = campaigns.some(c => c.billing.observedAndEstimatedCostUsd === null) ? null : campaigns.reduce(
    (sum, campaign) => sum + (campaign.billing.observedAndEstimatedCostUsd ?? 0),
    0,
  );
  const rows =
    campaigns.length > 0
      ? campaigns.map(campaignRow).join("")
      : `<tr><td class="empty" colspan="4">No campaigns have been published yet.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#141413" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="assets/favicon-32x32.png" type="image/png">
  <title>Runner E2E Campaigns · Paperclip</title>
  <style>
    @font-face { font-family: "Paperclip Inter"; src: url("assets/InterVariable.woff2") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; }
    :root { color-scheme: light dark; --background:#fff; --foreground:#0a0a0a; --muted:#60666a; --border:#e5e5e5; --raised:#fafafa; --pass:#188a3c; --pass-bg:#dcfce7; --fail:#991b1b; --fail-bg:#fee2e2; --font:"Paperclip Inter",Inter,ui-sans-serif,system-ui,-apple-system,sans-serif; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
    @media (prefers-color-scheme: dark) { :root { --background:#141413; --foreground:#fafafa; --muted:#a3a3a3; --border:rgb(255 255 255 / 12%); --raised:#1c1c1b; --pass:#34d06f; --pass-bg:#22c55e1f; --fail:#ef4444; --fail-bg:#dc26262e; } }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--background); color:var(--foreground); font:14px/1.45 var(--font); }
    a { color:inherit; text-underline-offset:3px; }
    .brand-bar { min-height:64px; display:flex; align-items:center; justify-content:space-between; gap:24px; padding:0 max(24px,calc((100vw - 1560px)/2)); border-bottom:1px solid var(--border); }
    .brand-lockup { display:inline-flex; align-items:center; gap:10px; font-size:16px; font-weight:650; text-decoration:none; }
    .brand-lockup svg { width:24px; height:24px; }
    .brand-context { color:var(--muted); font-size:12px; }
    main { width:min(1560px,calc(100% - 48px)); margin:48px auto 72px; }
    header { display:flex; align-items:end; justify-content:space-between; gap:32px; margin-bottom:36px; }
    .eyebrow { margin:0 0 10px; color:var(--muted); font:500 11px/1.4 var(--mono); letter-spacing:.08em; text-transform:uppercase; }
    h1 { margin:0; font-size:clamp(34px,4vw,56px); line-height:1.04; letter-spacing:-.04em; }
    .lede { max-width:680px; margin:14px 0 0; color:var(--muted); font-size:16px; }
    .summary { display:flex; border:1px solid var(--border); border-radius:8px; background:var(--raised); }
    .metric { min-width:112px; padding:13px 16px; border-right:1px solid var(--border); }
    .metric:last-child { border:0; }
    .metric strong,.metric span { display:block; }
    .metric strong { font:600 19px/1.2 var(--mono); }
    .metric span { margin-top:4px; color:var(--muted); font-size:10px; letter-spacing:.06em; text-transform:uppercase; }
    .pointers { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
    .pointers a { padding:8px 11px; border:1px solid var(--border); border-radius:7px; background:var(--raised); font-size:12px; text-decoration:none; }
    .pointers a:hover,.campaign-link:hover,.open-cell a:hover { text-decoration:underline; }
    .latest-campaign { margin-bottom:32px; }
    .latest-campaign-heading { display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; margin-bottom:20px; }
    .latest-campaign-heading h2 { margin:0; font-size:18px; font-weight:600; }
    .latest-metrics { display:flex; flex-wrap:wrap; gap:24px 48px; margin:0 0 16px; }
    .latest-metrics dt { color:var(--muted); font-size:11px; }
    .latest-metrics dd { margin:4px 0 0; font:600 24px/1.2 var(--mono); }
    ${campaignSuiteSummaryStyles}
    .table-wrap { border-top:1px solid var(--border); border-bottom:1px solid var(--border); }
    table { width:100%; border-collapse:collapse; }
    th,td { padding:14px 12px; border-bottom:1px solid var(--border); text-align:left; vertical-align:top; }
    tr:last-child td { border-bottom:0; }
    th { background:var(--raised); color:var(--muted); font-size:10px; letter-spacing:.06em; text-transform:uppercase; white-space:nowrap; }
    td strong,.campaign-link { font-weight:650; }
    td small { display:block; margin-top:4px; color:var(--muted); font-size:10px; }
    td a.secondary-link { display:block; margin-top:3px; }
    .campaign-link { font:600 11px/1.4 var(--mono); overflow-wrap:anywhere; }
    .status { display:inline-block; padding:3px 8px; border-radius:999px; font-size:10px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; }
    .status-passed { color:var(--pass); background:var(--pass-bg); }
    .status-incomplete { color:var(--muted); }
    .status-failed { color:var(--fail); background:var(--fail-bg); }
    .suite-list { display:grid; gap:3px; font-size:11px; white-space:nowrap; }
    .open-cell { text-align:right; white-space:nowrap; font-weight:650; }
    .empty { padding:48px; color:var(--muted); text-align:center; }
    footer { display:flex; justify-content:space-between; gap:16px; margin-top:20px; color:var(--muted); font-size:11px; }
    @media (max-width:1100px) { header { align-items:start; flex-direction:column; } .summary { width:100%; } .metric { flex:1; } }
    @media (max-width:860px) {
      .brand-context { display:none; } main { width:min(100% - 28px,1560px); margin-top:32px; }
      .summary { display:grid; grid-template-columns:repeat(3,1fr); } .metric { min-width:0; border-bottom:1px solid var(--border); }
      .table-wrap { border:0; } thead { display:none; } table,tbody,tr,td { display:block; width:100%; }
      tr { margin-bottom:14px; padding:8px 14px; border:1px solid var(--border); border-radius:8px; background:var(--raised); }
      td { display:grid; grid-template-columns:105px minmax(0,1fr); gap:12px; padding:10px 0; }
      td::before { content:attr(data-label); color:var(--muted); font-size:10px; letter-spacing:.06em; text-transform:uppercase; }
      .open-cell { display:block; padding-top:14px; text-align:left; } .open-cell::before { display:none; }
    }
    @media (max-width:520px) { .summary { grid-template-columns:1fr; } .metric { border-right:0; } footer { flex-direction:column; } }
    :root { --muted-foreground:var(--muted); --card:var(--raised); --border-strong:var(--border); --font-sans:var(--font); --font-mono:var(--mono); --radius:8px; --pass-text:var(--pass); --pass-border:var(--pass); --fail-text:var(--fail); --fail-border:var(--fail); --missing-text:#b45309; --missing-bg:#fef3c7; --missing-border:#f59e0b; }
    .index-search { display:flex; justify-content:space-between; align-items:center; gap:20px; margin:28px 0 14px; }
    .index-search h2 { margin:0; font-size:15px; }
    .index-search input { width:300px; max-width:65%; min-height:36px; padding:8px 10px; background:var(--background); border:1px solid var(--border); border-radius:5px; color:var(--foreground); font:inherit; }
    .index-result { color:var(--muted); font-size:11px; }
    .report-surface h1 { font-size:32px; }
    .report-surface .lede { font-size:12px; }
    .report-surface .table-wrap { overflow-x:auto; }
    .report-surface table { table-layout:fixed; }
    .report-surface th:first-child { width:29%; }
    .report-surface th:nth-child(2) { width:20%; }
    .report-surface th:nth-child(3) { width:28%; }
    .report-surface td { overflow-wrap:anywhere; }
    .campaign-row-details { margin-top:8px; color:var(--muted); font-size:11px; text-align:left; font-weight:400; }
    .campaign-row-details summary { cursor:pointer; text-align:right; }
    .campaign-row-details p { margin:10px 0; }
    .campaign-row-details .suite-list { white-space:normal; }
    ${reportNavigationStyles}
    ${reportHistoryStyles}
    @media(max-width:860px) { .report-surface table { min-width:0; } }
  </style>
</head>
<body>
  ${renderReportShell({ history })}
  <main>
    <header>
      <div>
        <p class="eyebrow">Historical test reporting</p>
        <h1 data-index-title>Runner E2E campaigns</h1>
        <p class="lede" data-index-description>${campaigns.length} retained campaigns. Open a report for test outcomes, per-test billing, declared screenshots, and normalized results.</p>
      </div>
      <div class="summary" aria-label="History summary">
        <div class="metric"><strong>${campaigns.length}</strong><span>Campaigns</span></div>
        <div class="metric"><strong>${passed}</strong><span>Passed</span></div>
        <div class="metric"><strong>${html(usd(totalCost))}</strong><span>Recorded cost</span></div>
      </div>
    </header>
    <section data-index-overview>
    ${latest ? `<section class="latest-campaign" aria-label="Latest campaign summary">
      <div class="latest-campaign-heading"><h2>Latest campaign</h2><a class="campaign-link" href="${html(latest.publicUrl)}">${html(latest.campaignId)}</a></div>
      <dl class="latest-metrics">
        <div><dt>Passed</dt><dd>${latest.passed}/${latest.selected}</dd></div>
        <div><dt>Failed or incomplete</dt><dd>${latest.failed + (latest.incomplete ?? 0)}</dd></div>
        <div><dt>Test time</dt><dd>${html(duration(latest.suites.reduce((total, suite) => total + suite.durationMs, 0)))}</dd></div>
      </dl>
      ${renderCampaignSuiteSummary(latest.suites, runnerMatrix, latest.publicUrl)}
    </section>` : ""}
    <nav class="pointers" aria-label="Campaign pointers">
      ${latest ? `<a href="${html(latest.publicUrl)}">Latest run · ${html(latest.campaignId)}</a>` : ""}
      ${latestGreen ? `<a href="${html(latestGreen.publicUrl)}">Latest complete green · ${html(latestGreen.campaignId)}</a>` : ""}
    </nav>
    </section>
    <div class="index-search"><h2 data-index-list-title>Recent campaigns</h2><input type="search" data-index-query aria-label="Search campaigns" placeholder="Find a campaign, revision, or branch…"></div>
    <p class="index-result" data-index-result aria-live="polite"></p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Campaign</th><th>Result</th><th>Source</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <details data-index-trends hidden><summary>Trends and detailed history</summary>${renderReportHistory(history)}</details>
    <footer><span>Updated ${html(date(history.updatedAt))} UTC</span><span>Immutable campaign reports · Declared screenshots and normalized results</span></footer>
  </main></div></div>
  <script>${reportShellScript}${reportHistoryScript}
  (() => {
    const shell = document.querySelector('.report-shell');
    const rows = [...document.querySelectorAll('[data-index-campaign]')];
    const query = document.querySelector('[data-index-query]');
    const crumbs = document.querySelector('[data-nav-breadcrumbs]');
    const originalDescription = document.querySelector('[data-index-description]').textContent;
    const apply = () => {
      const params = new URLSearchParams(location.search);
      const view = ['history','attention'].includes(params.get('view')) ? params.get('view') : 'overview';
      const title = {overview:'Runner E2E campaigns',history:'Campaign history',attention:'Needs attention'}[view];
      shell.dataset.view = view;
      document.querySelector('[data-index-title]').textContent = title;
      document.querySelector('[data-index-overview]').hidden = view !== 'overview';
      document.querySelector('[data-index-trends]').hidden = view !== 'history';
      document.querySelector('[data-index-description]').textContent = view === 'attention' ? 'Campaigns with failed or incomplete executions, missing results, or cleanup failures.' : originalDescription;
      document.querySelector('[data-index-list-title]').textContent = view === 'overview' ? 'Recent campaigns' : 'Campaigns';
      crumbs.replaceChildren();
      const root = document.createElement('a'); root.href = '?view=history'; root.textContent = 'Campaigns'; root.dataset.navView = 'history'; crumbs.append(root);
      const separator = document.createElement('span');separator.setAttribute('aria-hidden','true');separator.textContent='/';crumbs.append(separator);
      const current = document.createElement('span');current.setAttribute('aria-current','page');current.textContent = view === 'overview' ? 'Overview' : title;crumbs.append(current);
      document.querySelectorAll('[data-nav-view]').forEach(link => { if(link.dataset.navView===view)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current'); });
      const search=query.value.trim().toLowerCase(); let visible=0,matching=0;
      rows.forEach(row => { const match=(!search||row.dataset.indexSearch.includes(search))&&(view!=='attention'||row.dataset.indexStatus!=='passed');if(match)matching++;row.hidden=!match||(view==='overview'&&!search&&visible>=10);if(!row.hidden)visible++; });
      document.querySelector('[data-index-result]').textContent=visible+' of '+matching+' campaigns'+(view==='overview'&&!search&&matching>10?' · Open Campaign history for all retained reports':'');
    };
    document.addEventListener('click',event=>{ const link=event.target.closest('[data-nav-view]');if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();const url=new URL(location.href);url.searchParams.set('view',link.dataset.navView);url.searchParams.delete('q');history.pushState(null,'',url);query.value='';apply();window.scrollTo({top:0,behavior:'instant'}); });
    query.addEventListener('input',()=>{const url=new URL(location.href);if(query.value)url.searchParams.set('q',query.value);else url.searchParams.delete('q');history.replaceState(null,'',url);apply();});
    const read=()=>{query.value=new URLSearchParams(location.search).get('q')||'';apply();};window.addEventListener('popstate',read);read();
  })();
  </script>
</body>
</html>`;
}
