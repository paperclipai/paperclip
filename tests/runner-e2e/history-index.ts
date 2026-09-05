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

function usd(value: number) {
  return `$${value.toFixed(value < 0.01 ? 6 : 2)}`;
}

function duration(durationMs: number) {
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

function safeRelativeAssetHref(relative: string | undefined) {
  if (!relative || /^(?:[a-z]+:|\/\/|\/)/i.test(relative)) return null;
  const segments = relative.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return segments.map(encodeURIComponent).join("/");
}

function campaignStatus(campaign: RunnerE2EHistoryCampaign) {
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
  return `<tr>
    <td data-label="Campaign">
      <a class="campaign-link" href="${html(campaign.publicUrl)}">${html(campaign.campaignId)}</a>
      <small>${html(date(campaign.generatedAt))} UTC</small>
    </td>
    <td data-label="Status">
      <span class="status status-${status}">${status}</span>
      <small>${campaign.complete ? "Complete campaign" : "Partial campaign"}${campaign.retries > 0 ? ` · ${campaign.retries} retries` : ""}</small>
    </td>
    <td data-label="Source">${sourceCell(campaign)}</td>
    <td data-label="Suites"><div class="suite-list">${suites}</div></td>
    <td data-label="Tests">
      <strong>${campaign.passed}/${campaign.selected} passed</strong>
      <small>${campaign.executed} executed · ${campaign.failed} failed</small>
    </td>
    <td data-label="Tokens">
      <strong>${html(number(billing.llm.totalTokens))}</strong>
      <small>${html(number(billing.llm.inputTokens))} in · ${html(number(billing.llm.outputTokens))} out · ${html(number(billing.llm.cachedInputTokens))} cached</small>
    </td>
    <td data-label="Cost">
      <strong>${html(usd(billing.observedAndEstimatedCostUsd))}</strong>
      <small>${html(usd(billing.reportedLlmCostUsd))} LLM · ${html(usd(billing.estimatedRuntimeCostUsd))} runtime</small>
    </td>
    <td data-label="Time">
      <strong>${html(duration(billing.agentRunDurationMs))}</strong>
      <small>${html(duration(billing.leaseDurationMs))} Daytona lease</small>
    </td>
    <td class="open-cell"><a href="${html(campaign.publicUrl)}" aria-label="Open campaign ${html(campaign.campaignId)}">Open report&nbsp;→</a></td>
  </tr>`;
}

export function renderRunnerHistoryIndex(
  history: RunnerE2EHistoryIndex,
  options: { latestSummaryImageHref?: string } = {},
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
  const totalCost = campaigns.reduce(
    (sum, campaign) => sum + campaign.billing.observedAndEstimatedCostUsd,
    0,
  );
  const rows =
    campaigns.length > 0
      ? campaigns.map(campaignRow).join("")
      : `<tr><td class="empty" colspan="9">No campaigns have been published yet.</td></tr>`;
  const latestSummaryImageHref = safeRelativeAssetHref(
    options.latestSummaryImageHref,
  );

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
    .latest-summary { margin:0 0 24px; padding:12px; border:1px solid var(--border); border-radius:10px; background:var(--raised); }
    .latest-summary img { display:block; width:100%; height:auto; border-radius:6px; }
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
  </style>
</head>
<body>
  <div class="brand-bar">
    <a class="brand-lockup" href="https://paperclip.ing" aria-label="Paperclip home">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/></svg>
      <span>Paperclip</span>
    </a>
    <span class="brand-context">Quality engineering · Runner acceptance</span>
  </div>
  <main>
    <header>
      <div>
        <p class="eyebrow">Historical test reporting</p>
        <h1>Runner E2E campaigns</h1>
        <p class="lede">Each row is one workflow campaign against a Paperclip revision. Open a report for its configuration matrices, matchers, per-test billing, and sanitized structured evidence. Provider-produced visual evidence remains in access-controlled workflow artifacts.</p>
      </div>
      <div class="summary" aria-label="History summary">
        <div class="metric"><strong>${campaigns.length}</strong><span>Campaigns</span></div>
        <div class="metric"><strong>${passed}</strong><span>Passed</span></div>
        <div class="metric"><strong>${html(usd(totalCost))}</strong><span>Recorded cost</span></div>
      </div>
    </header>
    ${latestSummaryImageHref ? `<figure class="latest-summary"><img src="${html(latestSummaryImageHref)}" alt="Latest runner E2E campaign status summary"></figure>` : ""}
    <nav class="pointers" aria-label="Campaign pointers">
      ${latest ? `<a href="${html(latest.publicUrl)}">Latest run · ${html(latest.campaignId)}</a>` : ""}
      ${latestGreen ? `<a href="${html(latestGreen.publicUrl)}">Latest complete green · ${html(latestGreen.campaignId)}</a>` : ""}
    </nav>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Campaign</th><th>Status</th><th>Source</th><th>Suites</th><th>Tests</th><th>Tokens</th><th>Cost</th><th>Agent time</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <footer><span>Updated ${html(date(history.updatedAt))} UTC</span><span>Immutable campaign reports · Trusted synthetic summary image and inert structured evidence</span></footer>
  </main>
</body>
</html>`;
}
