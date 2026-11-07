import type { RunnerE2EHistoryIndex } from "./types.js";
import { html, durationLabel, tokenLabel, llmCostLabel, usdLabel } from "./report-format.js";

function renderTrendChart(input: {
  history: RunnerE2EHistoryIndex;
  label: string;
  value(campaign: RunnerE2EHistoryIndex["campaigns"][number]): number | null;
  format(value: number): string;
  include?(campaign: RunnerE2EHistoryIndex["campaigns"][number]): boolean;
  fingerprint?(campaign: RunnerE2EHistoryIndex["campaigns"][number]): string;
}) {
  const campaigns = input.history.campaigns
    .filter(input.include ?? ((campaign) => campaign.complete))
    .slice(0, 20)
    .reverse();
  if (campaigns.length === 0) {
    return `<article class="trend-card"><span>${html(input.label)}</span><strong>No complete campaigns</strong></article>`;
  }
  const rawValues = campaigns.map(input.value);
  const values = rawValues.filter((value): value is number => value !== null);
  if (values.length !== rawValues.length) {
    const latest = rawValues.at(-1);
    return `<article class="trend-card"><span>${html(input.label)}</span><strong>${latest == null ? "Unknown" : html(input.format(latest))}</strong><small>Unknown measurements are not plotted. Inspect campaign billing and reserved judge budgets.</small></article>`;
  }
  const maximum = Math.max(...values, 1);
  const pointRows = values.map((value, index) => {
    const x =
      campaigns.length === 1 ? 50 : (index / (campaigns.length - 1)) * 100;
    const y = 96 - (value / maximum) * 88;
    return {
      point: `${x.toFixed(2)},${y.toFixed(2)}`,
      x,
      y,
      fingerprint: input.fingerprint?.(campaigns[index]!) ?? "stable",
    };
  });
  const segments = pointRows.reduce<Array<typeof pointRows>>(
    (groups, point) => {
      const current = groups.at(-1);
      if (!current || current.at(-1)?.fingerprint !== point.fingerprint) {
        groups.push([point]);
      } else {
        current.push(point);
      }
      return groups;
    },
    [],
  );
  const definitionCount = new Set(pointRows.map((point) => point.fingerprint))
    .size;
  const latest = values.at(-1) ?? 0;
  return `<article class="trend-card">
    <span>${html(input.label)}</span>
    <strong>${html(input.format(latest))}</strong>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${html(input.label)} across ${campaigns.length} complete campaign(s)">
      ${segments.map((segment) => `<polyline points="${segment.map((point) => point.point).join(" ")}" fill="none" vector-effect="non-scaling-stroke" />`).join("")}
      ${pointRows.map((point) => `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="1.3" vector-effect="non-scaling-stroke" />`).join("")}
    </svg>
    <small>${campaigns.length} complete campaign${campaigns.length === 1 ? "" : "s"} · ${definitionCount} definition${definitionCount === 1 ? "" : "s"}</small>
  </article>`;
}

function suiteSummaryFor(
  campaign: RunnerE2EHistoryIndex["campaigns"][number],
  suiteId: string,
) {
  return campaign.suites.find((suite) => suite.suiteId === suiteId);
}

export function renderReportHistory(history: RunnerE2EHistoryIndex | undefined, options: { chartsOnly?: boolean } = {}) {
  if (!history || history.campaigns.length === 0) {
    return `<section class="history-section" id="history"><div class="section-heading"><div><p class="eyebrow">History</p><h2>Campaign trends</h2></div><p>No historical campaigns have been published yet.</p></div></section>`;
  }
  const suiteIds = [
    ...new Set(
      history.campaigns.flatMap((campaign) =>
        campaign.suites.map((suite) => suite.suiteId),
      ),
    ),
  ];
  const charts = [
    renderTrendChart({
      history,
      label: "Observed + estimated cost",
      value: (campaign) => campaign.billing.observedAndEstimatedCostUsd,
      format: usdLabel,
      fingerprint: (campaign) =>
        campaign.suites
          .map((suite) => `${suite.suiteId}:${suite.suiteDefinitionHash}`)
          .sort()
          .join("|"),
    }),
    renderTrendChart({
      history,
      label: "Total tokens",
      value: (campaign) => campaign.billing.llm.totalTokens,
      format: tokenLabel,
      fingerprint: (campaign) =>
        campaign.suites
          .map((suite) => `${suite.suiteId}:${suite.suiteDefinitionHash}`)
          .sort()
          .join("|"),
    }),
    renderTrendChart({
      history,
      label: "Agent execution time",
      value: (campaign) => campaign.billing.agentRunDurationMs,
      format: durationLabel,
      fingerprint: (campaign) =>
        campaign.suites
          .map((suite) => `${suite.suiteId}:${suite.suiteDefinitionHash}`)
          .sort()
          .join("|"),
    }),
    renderTrendChart({
      history,
      label: "Daytona lease time",
      value: (campaign) => campaign.billing.leaseDurationMs,
      format: durationLabel,
      fingerprint: (campaign) =>
        campaign.suites
          .map((suite) => `${suite.suiteId}:${suite.suiteDefinitionHash}`)
          .sort()
          .join("|"),
    }),
    renderTrendChart({
      history,
      label: "Pass rate",
      value: (campaign) =>
        campaign.selected > 0 ? (campaign.passed / campaign.selected) * 100 : 0,
      format: (value) => `${value.toFixed(1)}%`,
      fingerprint: (campaign) =>
        campaign.suites
          .map((suite) => `${suite.suiteId}:${suite.suiteDefinitionHash}`)
          .sort()
          .join("|"),
    }),
  ].join("");
  const suiteCharts = suiteIds
    .map((suiteId) => {
      const include = (campaign: RunnerE2EHistoryIndex["campaigns"][number]) =>
        suiteSummaryFor(campaign, suiteId)?.complete === true;
      const value = (
        campaign: RunnerE2EHistoryIndex["campaigns"][number],
        metric: "cost" | "tokens" | "agent" | "lease" | "passRate",
      ) => {
        const suite = suiteSummaryFor(campaign, suiteId);
        if (!suite) return 0;
        if (metric === "cost") return suite.billing.observedAndEstimatedCostUsd;
        if (metric === "tokens") return suite.billing.llm.totalTokens;
        if (metric === "agent") return suite.billing.agentRunDurationMs;
        if (metric === "lease") return suite.billing.leaseDurationMs;
        return suite.selected > 0 ? (suite.passed / suite.selected) * 100 : 0;
      };
      const fingerprint = (
        campaign: RunnerE2EHistoryIndex["campaigns"][number],
      ) => suiteSummaryFor(campaign, suiteId)?.suiteDefinitionHash ?? "unknown";
      return `<section class="suite-trends" data-history-suite-trends="${html(suiteId)}">
        <div class="suite-trends-heading"><h3>${html(suiteId)}</h3><span>Complete suite selections only; lines break at definition changes.</span></div>
        <div class="trend-grid">
          ${renderTrendChart({ history, label: "Suite cost", value: (campaign) => value(campaign, "cost"), format: usdLabel, include, fingerprint })}
          ${renderTrendChart({ history, label: "Suite tokens", value: (campaign) => value(campaign, "tokens"), format: tokenLabel, include, fingerprint })}
          ${renderTrendChart({ history, label: "Suite agent time", value: (campaign) => value(campaign, "agent"), format: durationLabel, include, fingerprint })}
          ${renderTrendChart({ history, label: "Suite lease time", value: (campaign) => value(campaign, "lease"), format: durationLabel, include, fingerprint })}
          ${renderTrendChart({ history, label: "Suite pass rate", value: (campaign) => value(campaign, "passRate"), format: (metric) => `${metric.toFixed(1)}%`, include, fingerprint })}
        </div>
      </section>`;
    })
    .join("");
  const rows = history.campaigns
    .map((campaign) => {
      const status = campaign.failed > 0 ? "failed" : (campaign.incomplete ?? 0) > 0 ? "incomplete" : "passed";
      const sha = campaign.source.sha;
      const searchable = [
        campaign.campaignId,
        sha,
        campaign.source.ref,
        ...campaign.executions.flatMap((execution) => [
          execution.suiteId,
          execution.profileId,
          execution.model,
          execution.environmentId,
          execution.caseId,
          execution.status,
        ]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return `<tr data-history-campaign data-history-date="${html(campaign.generatedAt.slice(0, 10))}" data-history-status="${status}" data-history-complete="${campaign.complete}" data-history-suites="${html(campaign.suites.map((suite) => suite.suiteId).join(" "))}" data-history-search="${html(searchable)}">
        <td><a href="${html(campaign.publicUrl)}">${html(campaign.campaignId)}</a><small>${html(new Date(campaign.generatedAt).toLocaleString("en-US", { timeZone: "UTC" }))} UTC</small></td>
        <td>${sha ? `<code>${html(sha.slice(0, 10))}</code>` : "Unknown"}<small>${html(campaign.source.ref ?? "unknown ref")}</small></td>
        <td><span class="status history-${status}">${status}</span><small>${campaign.passed}/${campaign.selected} passed${campaign.incomplete ? ` · ${campaign.incomplete} incomplete` : ""} · ${campaign.complete ? "complete" : "partial"}</small></td>
        <td>${html(tokenLabel(campaign.billing.llm.inputTokens, campaign.billing.llm))} / ${html(tokenLabel(campaign.billing.llm.outputTokens, campaign.billing.llm))}<small>input / output · ${html(tokenLabel(campaign.billing.llm.cachedInputTokens, campaign.billing.llm))} cached</small></td>
        <td>${html(llmCostLabel(campaign.billing.reportedLlmCostUsd, campaign.billing.llm))}<small>${html(usdLabel(campaign.billing.estimatedRuntimeCostUsd))} runtime estimate</small></td>
        <td>${html(durationLabel(campaign.billing.agentRunDurationMs))}<small>${html(durationLabel(campaign.billing.leaseDurationMs))} lease</small></td>
      </tr>`;
    })
    .join("");
  const latest = history.campaigns.find(
    (campaign) => campaign.campaignId === history.latestCampaignId,
  );
  const latestGreen = history.campaigns.find(
    (campaign) => campaign.campaignId === history.latestGreenCampaignId,
  );
  return `<section class="history-section" id="history">
    <div class="section-heading"><div><p class="eyebrow">History</p><h2>Campaign trends</h2></div><p>Complete campaigns are compared by default. Partial smoke runs remain searchable and are labeled explicitly.</p></div>
    <nav class="history-pointers" aria-label="Campaign pointers">
      ${latest ? `<a href="${html(latest.publicUrl)}"><span>Latest run</span><strong>${html(latest.campaignId)}</strong></a>` : ""}
      ${latestGreen ? `<a href="${html(latestGreen.publicUrl)}"><span>Latest green</span><strong>${html(latestGreen.campaignId)}</strong></a>` : ""}
    </nav>
    <div class="trend-grid">${charts}</div>
    ${suiteCharts}
    ${options.chartsOnly ? "" : `<div class="history-filters">
      <label>Search <input type="search" data-history-query placeholder="SHA, model, profile, case"></label>
      <label>Suite <select data-history-suite><option value="">All suites</option>${suiteIds.map((suiteId) => `<option value="${html(suiteId)}">${html(suiteId)}</option>`).join("")}</select></label>
      <label>Status <select data-history-status><option value="">All statuses</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="incomplete">Incomplete</option></select></label>
      <label>From <input type="date" data-history-from></label>
      <label>Through <input type="date" data-history-through></label>
      <label class="history-checkbox"><input type="checkbox" data-history-partial> Include partial campaigns</label>
    </div>
    <div class="history-table-wrap"><table class="history-table"><thead><tr><th>Campaign</th><th>Paperclip SHA</th><th>Result</th><th>Tokens</th><th>Cost</th><th>Execution</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="history-empty" data-history-empty hidden>No campaigns match these filters.</p>`}
  </section>`;
}

export const reportHistoryStyles = `
    .history-pointers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .history-pointers a { padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); text-decoration: none; }
    .history-pointers span, .history-pointers strong { display: block; }
    .history-pointers span { color: var(--muted-foreground); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
    .history-pointers strong { margin-top: 4px; font: 550 12px/1.4 var(--font-mono); overflow-wrap: anywhere; }
    .trend-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .trend-card { min-width: 0; padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
    .trend-card > span, .trend-card > strong, .trend-card > small { display: block; }
    .trend-card > span, .trend-card > small { color: var(--muted-foreground); font-size: 10px; }
    .trend-card > span { letter-spacing: .06em; text-transform: uppercase; }
    .trend-card > strong { margin-top: 4px; font: 550 17px/1.3 var(--font-mono); }
    .trend-card svg { width: 100%; height: 72px; margin: 10px 0 4px; overflow: visible; }
    .trend-card polyline { stroke: var(--foreground); stroke-width: 1.6; }
    .trend-card circle { fill: var(--background); stroke: var(--foreground); stroke-width: 1; }
    .suite-trends { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--border); }
    .suite-trends-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
    .suite-trends-heading h3 { margin: 0; font: 600 14px/1.4 var(--font-mono); }
    .suite-trends-heading span { color: var(--muted-foreground); font-size: 10px; }
    .history-filters { display: grid; grid-template-columns: minmax(220px, 1fr) repeat(4, minmax(130px, 180px)) auto; align-items: end; gap: 12px; margin: 24px 0 12px; }
    .history-filters label { display: grid; gap: 5px; color: var(--muted-foreground); font-size: 10px; letter-spacing: .05em; text-transform: uppercase; }
    .history-filters input, .history-filters select { width: 100%; min-height: 38px; padding: 7px 9px; border: 1px solid var(--border-strong); border-radius: calc(var(--radius) * .8); background: var(--background); color: var(--foreground); }
    .history-filters .history-checkbox { display: flex; align-items: center; min-height: 38px; padding-bottom: 7px; white-space: nowrap; }
    .history-checkbox input { width: 16px; min-height: 16px; }
    .history-table-wrap { overflow-x: auto; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
    .history-table { width: 100%; min-width: 1020px; border-collapse: collapse; }
    .history-table th, .history-table td { padding: 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    .history-table tr:last-child td { border-bottom: 0; }
    .history-table th { background: var(--raised); color: var(--muted-foreground); font-size: 10px; letter-spacing: .05em; text-transform: uppercase; }
    .history-table td small { display: block; margin-top: 3px; color: var(--muted-foreground); font-size: 10px; }
    .history-table .status { margin-bottom: 2px; }
    .history-passed { border-color: var(--pass-border); background: var(--pass-bg); color: var(--pass-text); }
    .history-incomplete { border-color: var(--missing-border); background: var(--missing-bg); color: var(--missing-text); }
    .history-failed { border-color: var(--fail-border); background: var(--fail-bg); color: var(--fail-text); }
    .history-empty { padding: 24px 0; color: var(--muted-foreground); text-align: center; }
  .history-section .section-heading { display:block; margin:24px 0; }
  .history-section .section-heading h2 { font-size:24px; margin:0; }
  .history-section .section-heading p { color:var(--muted-foreground); font-size:12px; }
  .history-section .status { border:1px solid; }
  [data-index-trends] { margin-top:32px; }
  [data-index-trends] > summary { cursor:pointer; color:var(--muted-foreground); font-size:12px; }
  @media(max-width:1100px) { .trend-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }.history-filters { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media(max-width:760px) { .trend-grid,.history-pointers,.history-filters { grid-template-columns:1fr; }.history-table-wrap .history-table { display:table; min-width:1020px; }.history-table tbody { display:table-row-group; }.history-table tr { display:table-row; }.history-table th,.history-table td { display:table-cell; }.history-table td::before { display:none; } }
`;

export const reportHistoryScript = `
    (() => {
      const rows = Array.from(document.querySelectorAll("[data-history-campaign]"));
      if (rows.length === 0) return;
      const query = document.querySelector("[data-history-query]");
      const suite = document.querySelector("[data-history-suite]");
      const status = document.querySelector("[data-history-status]");
      const from = document.querySelector("[data-history-from]");
      const through = document.querySelector("[data-history-through]");
      const partial = document.querySelector("[data-history-partial]");
      const empty = document.querySelector("[data-history-empty]");
      const suiteTrends = [...document.querySelectorAll("[data-history-suite-trends]")];
      const apply = () => {
        const search = query.value.trim().toLowerCase();
        let visible = 0;
        rows.forEach((row) => {
          const matches =
            (!search || row.dataset.historySearch.includes(search)) &&
            (!suite.value || row.dataset.historySuites.split(" ").includes(suite.value)) &&
            (!status.value || row.dataset.historyStatus === status.value) &&
            (!from.value || row.dataset.historyDate >= from.value) &&
            (!through.value || row.dataset.historyDate <= through.value) &&
            (partial.checked || row.dataset.historyComplete === "true");
          row.hidden = !matches;
          if (matches) visible += 1;
        });
        suiteTrends.forEach((section) => {
          section.hidden = Boolean(suite.value) && section.dataset.historySuiteTrends !== suite.value;
        });
        empty.hidden = visible !== 0;
      };
      query.addEventListener("input", apply);
      suite.addEventListener("change", apply);
      status.addEventListener("change", apply);
      from.addEventListener("change", apply);
      through.addEventListener("change", apply);
      partial.addEventListener("change", apply);
      apply();
    })();
`;
