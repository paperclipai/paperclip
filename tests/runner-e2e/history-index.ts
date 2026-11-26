import { renderReportHistory, reportHistoryStyles } from "./report-history.js";
import { renderReportShell, reportNavigationStyles, reportShellScript } from "./report-navigation.js";
import { runnerMatrix } from "./catalog.js";
import { campaignSuiteSummaryStyles, renderCampaignSuiteSummary } from "./campaign-summary.js";
import { historyBrowserJson, historyBrowserScript, historySuiteCatalog } from "./history-browser.js";
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
  return `<tr data-index-campaign data-index-id="${html(campaign.campaignId)}" data-index-status="${status}">
    <td data-label="Campaign">
      <a class="campaign-link" href="${html(campaign.publicUrl)}">${html(campaign.campaignId)}</a>
      <small>${html(date(campaign.generatedAt))} UTC</small>
    </td>
    <td data-label="Result">
      <span class="status status-${status}" data-index-row-status>${status}</span>
      <small data-index-row-counts>${campaign.passed}/${campaign.selected} passed · ${campaign.executed} executed</small>
      <small data-index-row-coverage>${campaign.complete ? "Full campaign" : "Partial campaign"}</small>
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
  const campaigns = [...history.campaigns].sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt));
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
  const suites = historySuiteCatalog(history, runnerMatrix);
  const allLabels: Record<string, string> = { suite: "All suites", target: "All targets", environment: "All execution environments", provider: "All providers", model: "All models", profile: "All profiles", runtime: "All runtimes", preset: "All presets", status: "All results", coverage: "Any coverage" };
  const filter = (name: string, label: string, choices: readonly [string, string][] = []) => `<label><span>${label}</span><select data-index-filter="${name}" aria-label="${label}"><option value="">${allLabels[name]}</option>${choices.map(([value, text]) => `<option value="${html(value)}">${html(text)}</option>`).join("")}</select></label>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#141413" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="assets/favicon-32x32.png" type="image/png">
  <title>E2E tests · Paperclip</title>
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
    .index-filter-toolbar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin:24px 0 14px; }
    .index-filter-toolbar > div { display:flex; align-items:baseline; gap:10px; }
    .index-filter-toolbar h2 { margin:0; font-size:15px; }
    .index-active-count { color:var(--muted); font-size:12px; }
    .index-active-count[data-active=true],.index-more-count { color:var(--report-filter-active); }
    .index-filters { display: grid; grid-template-columns: minmax(160px,1fr) minmax(140px,.7fr) minmax(180px,1fr) minmax(180px,1fr); gap: 12px; margin: 0 0 12px; }
    .index-filters label,.index-more label { display: grid; gap: 6px; min-width: 0; font-size: 11px; color: var(--muted); }
    .index-filters select,.index-filters input,.index-more select,.index-more input { width: 100%; min-width: 0; min-height: 38px; padding: 8px; background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 5px; font: 12px var(--font); }
    .index-more { margin-bottom: 20px; }
    .index-more summary { color: var(--muted); cursor: pointer; font-size: 12px; }
    .index-more-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; margin-top: 12px; }
    .index-more-count { margin-left:8px; font-size:11px; }
    .index-reset { min-height:36px; padding:8px 12px; border:1px solid var(--border); border-radius:5px; background:var(--raised); color:var(--foreground); font:600 12px var(--font); cursor:pointer; white-space:nowrap; }
    .index-reset[data-active=true] { border-color:var(--report-filter-active); color:var(--report-filter-active); }
    .index-reset:hover { background:var(--report-filter-tint); }
    .index-reset:focus-visible { outline:2px solid var(--report-filter-active); outline-offset:3px; }
    .suite-run-pointers { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; margin: 20px 0; }
    .suite-run-pointers > div { min-width: 0; border: 1px solid var(--border); border-radius: 7px; padding: 14px; }
    .suite-run-pointers strong,.suite-run-pointers a,.suite-run-pointers small { display: block; }
    .suite-run-pointers strong { font-size: 12px; margin-bottom: 8px; }
    .suite-run-pointers a { font: 11px var(--mono); overflow-wrap: anywhere; }
    .suite-run-pointers small { margin-top: 8px; color: var(--muted); font-size: 11px; }
    @media(max-width:1100px) { .index-filters,.index-more-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media(max-width:520px) { .index-filters,.index-more-grid,.suite-run-pointers { grid-template-columns:1fr; } .index-filters input,.index-filters select,.index-more input,.index-more select,.report-suite-catalog input { font-size:16px; } }
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
    td small { display:block; margin-top:4px; color:var(--muted); font-size:10px; overflow-wrap:anywhere; }
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
    @media(max-width:860px) {
      .report-surface table { min-width:0; }
      .report-surface td:not(.open-cell)::before { grid-column:1; grid-row:1 / span 4; }
      .report-surface td:not(.open-cell) > * { grid-column:2; min-width:0; }
      .report-surface td .status { justify-self:start; }
    }
  </style>
</head>
<body>
  ${renderReportShell({ history, historySuites: suites })}
  <main>
    <header>
      <div>
        <p class="eyebrow">Historical test reporting</p>
        <h1 data-index-title>E2E tests</h1>
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
    <section data-index-suite-summary hidden aria-label="Suite run pointers"><div class="suite-run-pointers">
      <div data-index-latest="any"><strong>Latest matching run</strong><a hidden></a><small></small></div>
      <div data-index-latest="full"><strong>Latest full run</strong><a hidden></a><small></small></div>
    </div></section>
    <div class="index-filter-toolbar"><div><h2>Filters</h2><span class="index-active-count" data-index-active-count aria-live="polite">None active</span></div><button class="index-reset" type="button" data-index-reset>Reset all filters</button></div>
    <div class="index-filters" aria-label="Filter campaigns">
      ${filter("suite", "Suite", suites.map(suite => [suite.id, suite.label]))}
      ${filter("coverage", "Campaign coverage", [["full", "Full runs"], ["subset", "Subset selections"], ["unfinished", "Unfinished full selections"], ["unknown", "Coverage not established"]])}
      ${filter("target", "Target")}
      <label><span>Search campaigns</span><input type="search" data-index-filter="q" aria-label="Search campaigns" placeholder="Campaign, revision, branch, or case…"></label>
    </div>
    <details class="index-more" data-index-more><summary><span>More filters</span><span class="index-more-count" data-index-more-count hidden></span></summary><div class="index-more-grid">
      ${filter("environment", "Agent execution")}${filter("provider", "Provider")}${filter("model", "Model")}
      ${filter("profile", "Agent profile")}${filter("runtime", "Runtime")}${filter("preset", "Run preset")}
      ${filter("status", "Result", [["passed", "Passed"], ["failed", "Failed"], ["incomplete", "Incomplete"]])}
      <label><span>From</span><input type="date" data-index-filter="from" aria-label="From"></label>
      <label><span>Through</span><input type="date" data-index-filter="through" aria-label="Through"></label>
    </div></details>
    <h2 data-index-list-title>Campaigns</h2>
    <p class="index-result" data-index-result aria-live="polite"></p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Campaign</th><th>Result</th><th>Source</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="empty" data-index-empty hidden><p data-index-empty-message>No campaigns match these filters.</p><a data-index-empty-suite hidden></a></div>
    <details data-index-trends hidden><summary>Campaign trends</summary>${renderReportHistory(history, { chartsOnly: true })}</details>
    <footer><span>Updated ${html(date(history.updatedAt))} UTC</span><span>Immutable campaign reports · Declared screenshots and normalized results</span></footer>
  </main></div></div>
  <script type="application/json" data-index-data>${historyBrowserJson(history, runnerMatrix)}</script>
  <script>${reportShellScript}${historyBrowserScript}
  </script>
</body>
</html>`;
}
