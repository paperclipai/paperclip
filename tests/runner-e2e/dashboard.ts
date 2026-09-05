import type {
  MatrixExecution,
  RunnerE2ECampaign,
  RunnerE2EHistoryIndex,
  RunnerE2EResult,
  RunnerE2ESuiteSummary,
} from "./types.js";
import {
  aggregateCampaignBilling,
  summarizeExecutionBilling,
} from "./billing.js";

export interface RunnerDashboardEntry {
  result: RunnerE2EResult;
  valid: boolean;
  errors: readonly string[];
  evidenceBaseHref?: string;
  evidenceFiles?: readonly string[];
}

export interface RunnerDashboardInput {
  title: string;
  generatedAt: string;
  expected: readonly string[];
  catalog: readonly MatrixExecution[];
  entries: readonly RunnerDashboardEntry[];
  campaign?: RunnerE2ECampaign;
  history?: RunnerE2EHistoryIndex;
  publicSummaryImageHref?: string;
}

interface ResolvedScreenshot {
  id: string;
  label: string;
  file: string;
  href: string;
}

function html(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function durationLabel(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function tokenLabel(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function usdLabel(value: number) {
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

function safeEvidenceHref(base: string | undefined, relative: string) {
  if (!base || /^(?:[a-z]+:|\/\/)/i.test(base)) return null;
  const cleanBase = base
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map(encodeURIComponent)
    .join("/");
  const cleanRelative = relative
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map(encodeURIComponent)
    .join("/");
  return `${cleanBase}/${cleanRelative}`;
}

function safePublicAssetHref(relative: string | undefined) {
  if (!relative || /^(?:[a-z]+:|\/\/|\/)/i.test(relative)) return null;
  const segments = relative.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return segments.map(encodeURIComponent).join("/");
}

function compactJson(value: unknown) {
  const serialized = JSON.stringify(value);
  return serialized && serialized.length > 1_200
    ? `${serialized.slice(0, 1_200)}…`
    : serialized;
}

function resolveScreenshots(
  entry: RunnerDashboardEntry | undefined,
): ResolvedScreenshot[] {
  const declaredScreenshots = entry?.result.screenshots?.length
    ? entry.result.screenshots
    : entry
      ? [
          {
            id: "final-state",
            label: "Final visible task state",
            file: "final-state.png",
          },
        ]
      : [];
  const availableFiles = entry?.evidenceFiles
    ? new Set(entry.evidenceFiles)
    : null;
  const screenshots = declaredScreenshots
    .filter((item) => !availableFiles || availableFiles.has(item.file))
    .flatMap((item) => {
      const href = safeEvidenceHref(entry?.evidenceBaseHref, item.file);
      return href ? [{ ...item, href }] : [];
    });
  if (
    entry?.result.status === "failed" &&
    !screenshots.some((item) => item.file === "failure.png") &&
    (!availableFiles || availableFiles.has("failure.png"))
  ) {
    const href = safeEvidenceHref(entry.evidenceBaseHref, "failure.png");
    if (href) {
      screenshots.push({
        id: "failure",
        label: "Failure state",
        file: "failure.png",
        href,
      });
    }
  }
  return screenshots;
}

function renderCase(
  execution: MatrixExecution,
  expected: ReadonlySet<string>,
  entryById: ReadonlyMap<string, RunnerDashboardEntry>,
) {
  const selected = expected.has(execution.id);
  const entry = entryById.get(execution.id);
  const state = !selected
    ? "not-selected"
    : !entry
      ? "missing"
      : entry.valid
        ? "passed"
        : "failed";
  const label = state.replace("-", " ");
  const detail =
    entry?.errors.join("; ") ||
    (entry?.valid ? "All invariants passed" : "Not selected");
  const screenshots = resolveScreenshots(entry);
  const billing = entry ? summarizeExecutionBilling(entry.result) : null;
  const matcherResults = entry?.result.matcherResults ?? [];
  const passedMatchers = matcherResults.filter(
    (result) => result.passed,
  ).length;
  const searchText = [
    execution.id,
    execution.task.label,
    execution.profile.label,
    execution.profile.generation,
    execution.profile.provider,
    execution.profile.model,
    execution.environment.label,
    execution.environment.provider,
    execution.suite.label,
    label,
  ]
    .join(" ")
    .toLowerCase();
  const availableFiles = entry?.evidenceFiles
    ? new Set(entry.evidenceFiles)
    : null;
  const playwright =
    !availableFiles || availableFiles.has("html-report/index.html")
      ? safeEvidenceHref(entry?.evidenceBaseHref, "html-report/index.html")
      : null;
  const links =
    screenshots.length > 0 || playwright
      ? `<nav class="evidence-links" aria-label="Evidence for ${html(execution.id)}">
          ${screenshots.map((item) => `<a href="${html(item.href)}" target="_blank" rel="noreferrer">Open ${html(item.label.toLowerCase())}</a>`).join("")}
          ${playwright ? `<a href="${html(playwright)}">Open Playwright report</a>` : ""}
        </nav>`
      : "";
  const matcherRows = (entry?.result.matcherResults ?? [])
    .map(
      (result) => `<tr class="matcher-${result.passed ? "passed" : "failed"}">
        <td><span class="matcher-state" aria-label="${result.passed ? "Passed" : "Failed"}">${result.passed ? "Pass" : "Fail"}</span></td>
        <td><code>${html(result.matcher.kind)}</code></td>
        <td>${html(compactJson(result.matcher))}</td>
        <td>${html(result.detail)}</td>
      </tr>`,
    )
    .join("");
  const gallery = screenshots.length
    ? `<div class="gallery" aria-label="Screenshots for ${html(execution.id)}">${screenshots
        .map(
          (item) => `<button
            class="screenshot-trigger"
            type="button"
            data-gallery-item
            data-gallery-href="${html(item.href)}"
            data-gallery-label="${html(item.label)}"
            data-gallery-execution="${html(execution.id)}"
            data-gallery-case="${html(execution.task.label)}"
            data-gallery-profile="${html(execution.profile.label)}"
            data-gallery-generation="${html(execution.profile.generation)}"
            data-gallery-provider="${html(execution.profile.provider)}"
            data-gallery-model="${html(execution.profile.model)}"
            data-gallery-environment="${html(execution.environment.label)}"
            data-gallery-environment-provider="${html(execution.environment.provider)}"
            data-gallery-execution-target="${html(execution.environment.expectedExecutionTarget.kind)}"
            data-gallery-runtime="${html(entry?.result.runtimeMode ?? execution.profile.expectedRuntimeMode)}"
            data-gallery-status="${html(label)}"
            data-gallery-duration="${html(entry ? durationLabel(entry.result.durationMs) : "Not run")}"
            data-gallery-tokens="${html(billing ? `${tokenLabel(billing.llm.inputTokens)} in · ${tokenLabel(billing.llm.outputTokens)} out` : "Unavailable")}"
            data-gallery-matchers="${html(matcherResults.length > 0 ? `${passedMatchers}/${matcherResults.length} matchers passed` : "No matchers recorded")}"
            aria-label="Open ${html(item.label)} for ${html(execution.id)} in gallery"
          >
            <span class="screenshot-frame"><img src="${html(item.href)}" loading="lazy" alt="${html(item.label)} for ${html(execution.id)}"></span>
            <span class="screenshot-caption"><span>${html(item.label)}</span><span aria-hidden="true">View</span></span>
          </button>`,
        )
        .join("")}</div>`
    : "";
  const billingStrip = billing
    ? `<div class="billing-strip" aria-label="Billing for ${html(execution.id)}">
        <div><span>Tokens</span><strong>${html(tokenLabel(billing.llm.inputTokens))} in · ${html(tokenLabel(billing.llm.outputTokens))} out</strong><small>${html(tokenLabel(billing.llm.cachedInputTokens))} cached · ${billing.llm.runsWithTokenUsage}/${billing.llm.runCount} runs covered</small></div>
        <div><span>LLM spend</span><strong>${billing.llm.runsWithReportedCost > 0 ? html(usdLabel(billing.reportedCostUsd)) : html(billing.llm.costStatus)}</strong><small>${billing.llm.runsWithReportedCost}/${billing.llm.runCount} runs provider-priced</small></div>
        <div><span>Execution</span><strong>${billing.runtime.estimatedListCostUsd === undefined ? html(billing.runtime.costStatus === "not_metered" ? "Local · not metered" : "Cost unavailable") : `${html(usdLabel(billing.runtime.estimatedListCostUsd))} est.`}</strong><small>${html(durationLabel(billing.runtime.agentRunDurationMs))} agent${billing.runtime.leaseDurationMs === null ? "" : ` · ${html(durationLabel(billing.runtime.leaseDurationMs))} lease`}</small></div>
      </div>`
    : "";
  return `<article
    class="case case-${state}"
    data-execution-id="${html(execution.id)}"
    data-report-case
    data-report-suite="${html(execution.suite.id)}"
    data-report-profile="${html(execution.profile.id)}"
    data-report-environment="${html(execution.environment.id)}"
    data-report-status="${html(state)}"
    data-report-search="${html(searchText)}"
  >
    <div class="case-heading">
      <strong>${html(execution.task.label)}</strong>
      <span class="status">${html(label)}</span>
    </div>
    ${gallery}
    ${billingStrip}
    <code class="execution-id">${html(execution.id)}</code>
    <details class="case-context">
      <summary>Matchers and test context</summary>
    ${
      entry
        ? `<dl>
            <div><dt>Attempt</dt><dd>${entry.result.attempt}</dd></div>
            <div><dt>Duration</dt><dd>${html(durationLabel(entry.result.durationMs))}</dd></div>
            <div><dt>Agent runtime</dt><dd>${html(durationLabel(billing!.runtime.agentRunDurationMs))}</dd></div>
            ${billing!.runtime.leaseDurationMs === null ? "" : `<div><dt>Environment lease</dt><dd>${html(durationLabel(billing!.runtime.leaseDurationMs))}</dd></div>`}
            <div><dt>Runtime</dt><dd>${html(entry.result.runtimeMode)}</dd></div>
            <div><dt>Provider</dt><dd>${html(entry.result.provider)}</dd></div>
            <div><dt>Model</dt><dd>${html(entry.result.model)}</dd></div>
            ${entry.result.issueIdentifier ? `<div><dt>Issue</dt><dd>${html(entry.result.issueIdentifier)}</dd></div>` : ""}
          </dl>`
        : ""
    }
    <p class="detail">${html(detail)}</p>
    ${matcherRows ? `<div class="matcher-wrap"><table class="matchers"><thead><tr><th>Result</th><th>Matcher</th><th>Expectation</th><th>Detail</th></tr></thead><tbody>${matcherRows}</tbody></table></div>` : `<p class="detail">No matcher result was recorded.</p>`}
    ${entry ? `<details class="usage"><summary>Usage and billing metadata</summary><pre>${html(JSON.stringify({ billing, rawUsage: entry.result.usage ?? null }, null, 2))}</pre></details>` : ""}
    ${links}
    </details>
  </article>`;
}

function renderTrendChart(input: {
  history: RunnerE2EHistoryIndex;
  label: string;
  value(campaign: RunnerE2EHistoryIndex["campaigns"][number]): number;
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
  const values = campaigns.map(input.value);
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

function renderHistory(history: RunnerE2EHistoryIndex | undefined) {
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
      const status = campaign.failed === 0 ? "passed" : "failed";
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
        <td><span class="status history-${status}">${status}</span><small>${campaign.passed}/${campaign.passed + campaign.failed} passed · ${campaign.complete ? "complete" : "partial"}</small></td>
        <td>${html(tokenLabel(campaign.billing.llm.inputTokens))} / ${html(tokenLabel(campaign.billing.llm.outputTokens))}<small>input / output · ${html(tokenLabel(campaign.billing.llm.cachedInputTokens))} cached</small></td>
        <td>${html(usdLabel(campaign.billing.reportedLlmCostUsd))}<small>${html(usdLabel(campaign.billing.estimatedRuntimeCostUsd))} runtime estimate</small></td>
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
    <div class="history-filters">
      <label>Search <input type="search" data-history-query placeholder="SHA, model, profile, case"></label>
      <label>Suite <select data-history-suite><option value="">All suites</option>${suiteIds.map((suiteId) => `<option value="${html(suiteId)}">${html(suiteId)}</option>`).join("")}</select></label>
      <label>Status <select data-history-status><option value="">All statuses</option><option value="passed">Passed</option><option value="failed">Failed</option></select></label>
      <label>From <input type="date" data-history-from></label>
      <label>Through <input type="date" data-history-through></label>
      <label class="history-checkbox"><input type="checkbox" data-history-partial> Include partial campaigns</label>
    </div>
    <div class="history-table-wrap"><table class="history-table"><thead><tr><th>Campaign</th><th>Paperclip SHA</th><th>Result</th><th>Tokens</th><th>Cost</th><th>Execution</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="history-empty" data-history-empty hidden>No campaigns match these filters.</p>
  </section>`;
}

function renderSuiteMatrix(input: {
  suiteCatalog: readonly MatrixExecution[];
  expected: ReadonlySet<string>;
  entryById: ReadonlyMap<string, RunnerDashboardEntry>;
  summary?: RunnerE2ESuiteSummary;
}) {
  const suite = input.suiteCatalog[0]?.suite;
  if (!suite) return "";
  const profiles = [
    ...new Map(
      input.suiteCatalog.map((execution) => [
        execution.profile.id,
        execution.profile,
      ]),
    ).values(),
  ];
  const environments = [
    ...new Map(
      input.suiteCatalog.map((execution) => [
        execution.environment.id,
        execution.environment,
      ]),
    ).values(),
  ];
  const rows = profiles
    .map((profile, profileIndex) => {
      const columns = environments
        .map((environment) => {
          const executions = input.suiteCatalog.filter(
            (execution) =>
              execution.profile.id === profile.id &&
              execution.environment.id === environment.id,
          );
          return `<td>
            <div class="mobile-environment-header"><strong>${html(environment.label)}</strong><span>${html(environment.provider)} · ${html(environment.expectedExecutionTarget.kind)}</span></div>
            <div class="case-stack">${executions.map((execution) => renderCase(execution, input.expected, input.entryById)).join("")}</div>
          </td>`;
        })
        .join("");
      return `<tr data-report-profile-row><th scope="row" class="profile-cell"><div class="profile-sticky">
        <span class="agent-capsule agent-${(profileIndex % 10) + 1}" aria-hidden="true"></span>
        <span class="profile-copy"><span><strong>${html(profile.label)}</strong><span class="generation">${html(profile.generation)}</span></span><small>${html(profile.provider)} · ${html(profile.model)}</small></span>
      </div></th>${columns}</tr>`;
    })
    .join("");
  const environmentHeaders = environments
    .map(
      (environment) =>
        `<th scope="col"><span class="environment-label">${html(environment.label)}</span><small>${html(environment.provider)} · ${html(environment.expectedExecutionTarget.kind)}</small></th>`,
    )
    .join("");
  const selected = input.suiteCatalog.filter((execution) =>
    input.expected.has(execution.id),
  ).length;
  const summary = input.summary;
  const summaryHtml = summary
    ? `<div class="suite-summary" aria-label="${html(suite.label)} current campaign summary">
        <div><span>Pass rate</span><strong>${summary.selected > 0 ? ((summary.passed / summary.selected) * 100).toFixed(1) : "0.0"}%</strong><small>${summary.passed}/${summary.selected} passed</small></div>
        <div><span>Tokens</span><strong>${html(tokenLabel(summary.billing.llm.totalTokens))}</strong><small>${html(tokenLabel(summary.billing.llm.inputTokens))} input · ${html(tokenLabel(summary.billing.llm.outputTokens))} output</small></div>
        <div><span>Cost</span><strong>${html(usdLabel(summary.billing.observedAndEstimatedCostUsd))}</strong><small>reported LLM + runtime estimate</small></div>
        <div><span>Agent time</span><strong>${html(durationLabel(summary.billing.agentRunDurationMs))}</strong><small>${html(durationLabel(summary.billing.leaseDurationMs))} lease</small></div>
        <div><span>Execution</span><strong>${summary.executed}/${summary.selected}</strong><small>${summary.retries} retries · cleanup ${summary.cleanupPassed ? "passed" : "failed"}</small></div>
      </div>`
    : "";
  return `<section class="suite-section" id="suite-${html(suite.id)}">
    <div class="section-heading"><div><p class="eyebrow">Test suite</p><h2>${html(suite.label)}</h2></div><p>${html(suite.description)}</p></div>
    ${summaryHtml}
    <div class="table-kicker"><strong>Configuration matrix</strong><span>${profiles.length} profiles · ${environments.length} environments · ${selected} selected</span></div>
    <div class="table-wrap"><table class="matrix"><colgroup><col class="profile-column">${environments.map(() => '<col class="environment-column">').join("")}</colgroup><thead><tr><th scope="col">Agent profile</th>${environmentHeaders}</tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

export function renderRunnerE2EDashboard(input: RunnerDashboardInput) {
  const expected = new Set(input.expected);
  const entryById = new Map(
    input.entries.map((entry) => [entry.result.executionId, entry]),
  );
  const selectedEntries = input.entries.filter((entry) =>
    expected.has(entry.result.executionId),
  );
  const passed = selectedEntries.filter((entry) => entry.valid).length;
  const failed = input.expected.length - passed;
  const totalDuration = selectedEntries.reduce(
    (total, entry) => total + entry.result.durationMs,
    0,
  );
  const screenshotCount = selectedEntries.reduce(
    (total, entry) => total + resolveScreenshots(entry).length,
    0,
  );
  const campaignBilling = aggregateCampaignBilling(
    selectedEntries.map((entry) => entry.result),
  );
  const suites = [
    ...new Map(
      input.catalog.map((execution) => [execution.suite.id, execution.suite]),
    ).values(),
  ];
  const suiteSections = suites
    .map((suite) =>
      renderSuiteMatrix({
        suiteCatalog: input.catalog.filter(
          (execution) => execution.suite.id === suite.id,
        ),
        expected,
        entryById,
        summary: input.campaign?.suites.find(
          (summary) => summary.suiteId === suite.id,
        ),
      }),
    )
    .join("");
  const historySection = renderHistory(input.history);
  const publicSummaryImageHref = safePublicAssetHref(
    input.publicSummaryImageHref,
  );
  const filterProfiles = [
    ...new Map(
      input.catalog.map((execution) => [
        execution.profile.id,
        execution.profile,
      ]),
    ).values(),
  ];
  const filterEnvironments = [
    ...new Map(
      input.catalog.map((execution) => [
        execution.environment.id,
        execution.environment,
      ]),
    ).values(),
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#141413" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="assets/favicon-32x32.png" type="image/png">
  <title>${html(input.title)} · Paperclip</title>
  <style>
    @font-face { font-family: "Paperclip Inter"; src: url("assets/InterVariable.woff2") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; }
    :root {
      color-scheme: light dark;
      --background: #ffffff;
      --foreground: #0a0a0a;
      --card: #ffffff;
      --raised: #fafafa;
      --muted-foreground: #52585d;
      --quiet: #70767a;
      --border: #e5e5e5;
      --border-strong: #a8aeb2;
      --primary: #0a0a0a;
      --primary-foreground: #fafafa;
      --overlay: rgb(10 10 10 / 84%);
      --pass-bg: #dcfce7;
      --pass-text: #188a3c;
      --pass-border: #22c55e;
      --fail-bg: #fee2e2;
      --fail-text: #991b1b;
      --fail-border: #dc2626;
      --missing-bg: #fef3c7;
      --missing-text: #b45309;
      --missing-border: #f59e0b;
      --idle-bg: #f5f3f0;
      --idle-text: #52585d;
      --idle-border: #a8aeb2;
      --radius: 8px;
      --navigation-sticky-offset: 58px;
      --font-sans: "Paperclip Inter", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: #141413;
        --foreground: #fafafa;
        --card: #1c1c1b;
        --raised: #20201f;
        --muted-foreground: #a3a3a3;
        --quiet: #8c8c89;
        --border: rgb(255 255 255 / 10%);
        --border-strong: rgb(255 255 255 / 24%);
        --primary: #fafafa;
        --primary-foreground: #141413;
        --overlay: rgb(0 0 0 / 88%);
        --pass-bg: #22c55e1f;
        --pass-text: #34d06f;
        --pass-border: #22c55e73;
        --fail-bg: #dc26262e;
        --fail-text: #ef4444;
        --fail-border: #dc262673;
        --missing-bg: #f59e0b24;
        --missing-text: #f59e0b;
        --missing-border: #f59e0b73;
        --idle-bg: #6e696024;
        --idle-text: #9a958a;
        --idle-border: #9e958a73;
      }
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--background); color: var(--foreground); font: 14px/1.5 var(--font-sans); font-feature-settings: "ss01", "cv11"; }
    button, summary, a { -webkit-tap-highlight-color: transparent; }
    button, input, textarea, select { font: inherit; }
    a { color: inherit; text-underline-offset: 3px; }
    a:hover { text-decoration-thickness: 2px; }
    .brand-bar { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 0 max(24px, calc((100vw - 1560px) / 2)); border-bottom: 1px solid var(--border); }
    .brand-lockup { display: inline-flex; align-items: center; gap: 10px; color: var(--foreground); font-size: 16px; font-weight: 650; letter-spacing: -.02em; text-decoration: none; }
    .brand-lockup svg { width: 24px; height: 24px; flex: none; }
    .brand-context { color: var(--muted-foreground); font-size: 12px; }
    main { width: min(1560px, calc(100% - 48px)); margin: 48px auto 72px; }
    .report-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 40px; padding-bottom: 32px; }
    .eyebrow { margin: 0 0 12px; color: var(--muted-foreground); font: 500 11px/1.4 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
    h1 { max-width: 760px; margin: 0; font-size: clamp(32px, 4vw, 56px); font-weight: 650; line-height: 1.03; letter-spacing: -.04em; }
    .lede { max-width: 720px; margin: 16px 0 0; color: var(--muted-foreground); font-size: 16px; }
    .report-actions { display: flex; align-items: stretch; gap: 8px; }
    .summary { display: flex; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
    .metric { min-width: 108px; padding: 13px 16px; border-right: 1px solid var(--border); }
    .metric:last-child { border-right: 0; }
    .metric strong { display: block; font: 500 19px/1.2 var(--font-mono); font-variant-numeric: tabular-nums; }
    .metric span { display: block; margin-top: 4px; color: var(--muted-foreground); font-size: 11px; letter-spacing: .07em; text-transform: uppercase; }
    .gallery-launch, .gallery-control, .gallery-close { border: 1px solid var(--border-strong); border-radius: calc(var(--radius) * .8); background: var(--background); color: var(--foreground); cursor: pointer; font-weight: 600; transition: background 150ms ease, color 150ms ease, border-color 150ms ease; }
    .gallery-launch { min-width: 138px; padding: 10px 15px; }
    .gallery-launch:hover, .gallery-control:hover, .gallery-close:hover { border-color: var(--foreground); background: var(--primary); color: var(--primary-foreground); }
    .gallery-launch:focus-visible, .gallery-control:focus-visible, .gallery-close:focus-visible, .screenshot-trigger:focus-visible, .report-filters input:focus-visible, .report-filters select:focus-visible, .filter-reset:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
    .report-filters { display: grid; grid-template-columns: minmax(240px, 1.6fr) repeat(4, minmax(130px, .7fr)) auto; align-items: end; gap: 10px; margin: 0 0 40px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
    .report-filters label { display: grid; gap: 5px; min-width: 0; }
    .report-filters label > span { color: var(--muted-foreground); font-size: 10px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
    .report-filters input, .report-filters select, .filter-reset { width: 100%; min-height: 38px; padding: 7px 9px; border: 1px solid var(--border-strong); border-radius: calc(var(--radius) * .8); background: var(--background); color: var(--foreground); }
    .filter-reset { width: auto; cursor: pointer; font-weight: 600; }
    .filter-reset:hover { border-color: var(--foreground); }
    .filter-result { grid-column: 1 / -1; margin: 0; color: var(--muted-foreground); font: 10px/1.4 var(--font-mono); }
    .table-kicker { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-top: 1px solid var(--border); color: var(--muted-foreground); }
    .table-kicker strong { color: var(--foreground); font-weight: 600; }
    .table-kicker span { font: 11px/1.4 var(--font-mono); font-variant-numeric: tabular-nums; }
    .table-wrap { overflow: visible; }
    .matrix { width: 100%; min-width: 1120px; table-layout: fixed; border-collapse: separate; border-spacing: 0; }
    .matrix .profile-column { width: 260px; }
    .matrix .environment-column { width: auto; }
    .matrix th, .matrix td { padding: 16px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); vertical-align: top; text-align: left; }
    .matrix tr:last-child th, .matrix tr:last-child td { border-bottom: 0; }
    .matrix th:last-child, .matrix td:last-child { border-right: 0; }
    .matrix thead th { position: sticky; top: var(--navigation-sticky-offset); z-index: 4; background: var(--raised); }
    .matrix thead th:first-child { left: 0; z-index: 6; width: 260px; }
    .matrix thead small, .matrix tbody th small { display: block; margin-top: 4px; color: var(--muted-foreground); font-weight: 400; }
    .environment-label { font-size: 15px; font-weight: 650; }
    .mobile-environment-header { display: none; }
    .profile-cell { position: sticky; left: 0; z-index: 3; width: 260px; background: var(--card); }
    .profile-cell { display: table-cell; }
    .profile-sticky { position: sticky; top: calc(var(--navigation-sticky-offset) + 76px); display: flex; align-items: flex-start; min-width: 0; }
    .profile-sticky > .agent-capsule { flex: none; margin: 2px 12px 18px 0; }
    .profile-copy { display: block; min-width: 0; }
    .profile-copy strong { font-size: 14px; }
    .profile-copy small { overflow-wrap: anywhere; }
    .agent-capsule { display: inline-block; width: 10px; height: 22px; border-radius: 999px; }
    .agent-1 { background: linear-gradient(to bottom, #f7cfdc, #1f7a3a); }
    .agent-2 { background: linear-gradient(to bottom, #c9a9e8, #ee79a1); }
    .agent-3 { background: linear-gradient(to bottom, #28164b, #7a1530); }
    .agent-4 { background: linear-gradient(to bottom, #f3e6c4, #e3a21a); }
    .agent-5 { background: linear-gradient(to bottom, #1f4dd6, #3aa35c); }
    .agent-6 { background: linear-gradient(to bottom, #e94b27, #5a1122); }
    .agent-7 { background: linear-gradient(to bottom, #7eb6e3, #ee79a1); }
    .agent-8 { background: linear-gradient(to bottom, #9ce8a7, #bd7ff0); }
    .agent-9 { background: linear-gradient(to bottom, #f3b49e, #1f4ed4); }
    .agent-10 { background: linear-gradient(to bottom, #f2d95f, #4fbcba); }
    .generation { display: inline-block; margin-left: 7px; padding: 2px 7px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted-foreground); font: 500 10px/1.4 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
    .case-stack { display: grid; gap: 12px; }
    .case { min-width: 0; max-width: 100%; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); overflow: hidden; }
    .case-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    .case-heading strong { font-size: 14px; font-weight: 650; }
    .status, .matcher-state { display: inline-block; flex: none; padding: 3px 8px; border: 1px solid; border-radius: 999px; font: 600 10px/1.4 var(--font-sans); letter-spacing: .05em; text-transform: uppercase; }
    .case-passed .status, .matcher-passed .matcher-state { border-color: var(--pass-border); background: var(--pass-bg); color: var(--pass-text); }
    .case-failed .status, .matcher-failed .matcher-state { border-color: var(--fail-border); background: var(--fail-bg); color: var(--fail-text); }
    .case-missing .status { border-color: var(--missing-border); background: var(--missing-bg); color: var(--missing-text); }
    .case-not-selected { opacity: .68; }
    .case-not-selected .status { border-color: var(--idle-border); background: var(--idle-bg); color: var(--idle-text); }
    code, pre, .execution-id { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .execution-id { display: block; margin: 10px 0; color: var(--muted-foreground); font-size: 11px; overflow-wrap: anywhere; }
    dl { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 12px 0; }
    dl div { display: flex; gap: 6px; }
    dt { color: var(--muted-foreground); }
    dd { margin: 0; font-family: var(--font-mono); font-size: 12px; }
    .detail { margin: 12px 0; color: var(--muted-foreground); font-size: 12px; overflow-wrap: anywhere; }
    .evidence-links { display: flex; flex-wrap: wrap; gap: 12px; padding-top: 4px; }
    .evidence-links a { color: var(--foreground); font-size: 12px; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 14px 0 10px; }
    .screenshot-trigger { min-width: 0; padding: 0; border: 1px solid var(--border); border-radius: calc(var(--radius) * .8); overflow: hidden; background: var(--background); color: var(--foreground); text-align: left; cursor: zoom-in; transition: border-color 150ms ease; }
    .screenshot-trigger:hover { border-color: var(--foreground); }
    .screenshot-frame { display: block; aspect-ratio: 16 / 10; overflow: hidden; border-bottom: 1px solid var(--border); background: #0a0a0a; }
    .screenshot-frame img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
    .screenshot-caption { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 9px; }
    .screenshot-caption span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground); font-size: 10px; }
    .screenshot-caption span:last-child { font-size: 10px; font-weight: 650; }
    .case-context { display: block; max-width: 100%; }
    .matcher-wrap { width: 100%; max-width: 100%; overflow-x: auto; margin: 12px 0; border: 1px solid var(--border); border-radius: calc(var(--radius) * .8); }
    .matchers { width: 100%; min-width: 680px; table-layout: fixed; border-collapse: collapse; font-size: 11px; }
    .matchers th:nth-child(1) { width: 72px; }
    .matchers th:nth-child(2) { width: 144px; }
    .matchers th:nth-child(4) { width: 110px; }
    .matchers th, .matchers td { padding: 8px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); vertical-align: top; }
    .matchers tr:last-child td { border-bottom: 0; }
    .matchers th:last-child, .matchers td:last-child { border-right: 0; }
    .matchers th { background: var(--raised); color: var(--muted-foreground); font-weight: 600; }
    .matchers code { display: inline; color: var(--foreground); }
    .matchers td { overflow-wrap: anywhere; }
    .usage { margin: 12px 0; color: var(--muted-foreground); }
    .billing-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 12px 0 10px; border: 1px solid var(--border); border-radius: calc(var(--radius) * .8); background: var(--raised); }
    .billing-strip > div { min-width: 0; padding: 9px 10px; border-right: 1px solid var(--border); }
    .billing-strip > div:last-child { border-right: 0; }
    .billing-strip span, .billing-strip small { display: block; color: var(--muted-foreground); font-size: 9px; }
    .billing-strip span { letter-spacing: .06em; text-transform: uppercase; }
    .billing-strip strong { display: block; margin: 3px 0 1px; overflow-wrap: anywhere; font: 550 11px/1.35 var(--font-mono); font-variant-numeric: tabular-nums; }
    .billing-overview { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0 0 32px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
    .billing-metric { min-width: 0; padding: 14px 16px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
    .billing-metric:nth-child(4n) { border-right: 0; }
    .billing-metric:nth-child(n + 5) { border-bottom: 0; }
    .billing-metric strong { display: block; overflow-wrap: anywhere; font: 550 17px/1.25 var(--font-mono); font-variant-numeric: tabular-nums; }
    .billing-metric span { display: block; margin-top: 4px; color: var(--muted-foreground); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
    .billing-note { grid-column: 1 / -1; margin: 0; padding: 11px 16px; border-top: 1px solid var(--border); color: var(--muted-foreground); font-size: 11px; }
    .suite-nav { position: sticky; top: 0; z-index: 12; display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 24px; padding: 10px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--background); }
    .suite-nav a { padding: 7px 10px; border-radius: calc(var(--radius) * .8); color: var(--muted-foreground); font-size: 12px; font-weight: 600; text-decoration: none; }
    .suite-nav a:hover { background: var(--raised); color: var(--foreground); }
    .suite-section, .history-section { scroll-margin-top: calc(var(--navigation-sticky-offset) + 16px); margin-top: 64px; }
    .section-heading { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 520px); align-items: end; gap: 32px; margin-bottom: 24px; }
    .section-heading h2 { margin: 0; font-size: clamp(25px, 3vw, 38px); line-height: 1.05; letter-spacing: -.035em; }
    .section-heading > p { margin: 0; color: var(--muted-foreground); }
    .suite-summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); margin: 0 0 24px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
    .suite-summary > div { min-width: 0; padding: 12px 14px; border-right: 1px solid var(--border); }
    .suite-summary > div:last-child { border-right: 0; }
    .suite-summary span, .suite-summary strong, .suite-summary small { display: block; }
    .suite-summary span, .suite-summary small { color: var(--muted-foreground); font-size: 9px; }
    .suite-summary span { letter-spacing: .06em; text-transform: uppercase; }
    .suite-summary strong { margin: 3px 0 1px; font: 550 15px/1.3 var(--font-mono); }
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
    .history-failed { border-color: var(--fail-border); background: var(--fail-bg); color: var(--fail-text); }
    .history-empty { padding: 24px 0; color: var(--muted-foreground); text-align: center; }
    .case-context > summary, .usage > summary { width: fit-content; cursor: pointer; color: var(--foreground); font-size: 12px; font-weight: 600; }
    pre { max-height: 240px; overflow: auto; padding: 12px; border: 1px solid var(--border); border-radius: calc(var(--radius) * .8); background: var(--raised); color: var(--foreground); font-size: 10px; white-space: pre-wrap; }
    footer { display: flex; justify-content: space-between; gap: 16px; padding-top: 16px; color: var(--muted-foreground); font: 11px/1.4 var(--font-mono); }
    dialog.gallery-dialog { width: 100vw; max-width: none; height: 100dvh; max-height: none; margin: 0; padding: 0; border: 0; background: transparent; color: #fafafa; }
    dialog.gallery-dialog::backdrop { background: var(--overlay); }
    .gallery-shell { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; width: 100%; height: 100%; background: var(--overlay); }
    .gallery-toolbar, .gallery-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 24px; border-color: rgb(255 255 255 / 18%); }
    .gallery-toolbar { border-bottom: 1px solid rgb(255 255 255 / 18%); }
    .gallery-footer { border-top: 1px solid rgb(255 255 255 / 18%); }
    .gallery-meta { min-width: 0; }
    .gallery-meta > strong, .gallery-execution { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gallery-meta > strong { font-size: 14px; }
    .gallery-context { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-top: 5px; }
    .gallery-context span { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; }
    .gallery-context strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .gallery-context em { color: #b8b8b5; font: 10px/1.4 var(--font-mono); font-style: normal; white-space: nowrap; }
    .gallery-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; margin-top: 8px; }
    .gallery-facts > span { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; }
    .gallery-facts em { color: #b8b8b5; font: 10px/1.4 var(--font-mono); font-style: normal; text-transform: uppercase; }
    .gallery-facts strong { font: 600 11px/1.4 var(--font-mono); }
    .gallery-status { padding: 3px 8px; border: 1px solid rgb(255 255 255 / 36%); border-radius: 999px; font: 650 10px/1.4 var(--font-sans); letter-spacing: .05em; text-transform: uppercase; }
    .gallery-status[data-status="passed"] { border-color: var(--pass-border); background: var(--pass-bg); color: #6ee79a; }
    .gallery-status[data-status="failed"] { border-color: var(--fail-border); background: var(--fail-bg); color: #ff8181; }
    .gallery-execution { margin-top: 3px; color: #b8b8b5; font: 10px/1.4 var(--font-mono); }
    .gallery-close, .gallery-control { min-height: 38px; padding: 8px 12px; border-color: rgb(255 255 255 / 32%); background: transparent; color: #fafafa; }
    .gallery-stage { position: relative; display: grid; place-items: center; min-height: 0; padding: 24px 88px; overflow: hidden; touch-action: pan-y; }
    .gallery-stage img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; border: 1px solid rgb(255 255 255 / 18%); background: #0a0a0a; }
    .gallery-control { position: absolute; top: 50%; z-index: 2; width: 48px; height: 64px; padding: 0; transform: translateY(-50%); font-size: 22px; }
    .gallery-previous { left: 24px; }
    .gallery-next { right: 24px; }
    .gallery-position { color: #b8b8b5; font: 12px/1.4 var(--font-mono); font-variant-numeric: tabular-nums; }
    @media (max-width: 1180px) {
      .matrix { display: block; min-width: 0; }
      .matrix thead { display: none; }
      .matrix tbody { display: grid; gap: 40px; }
      .matrix tbody, .matrix tr, .matrix th, .matrix td { width: 100%; }
      .matrix tr, .matrix th, .matrix td { display: block; }
      .matrix th, .matrix td { padding: 0; border: 0; }
      .profile-cell { position: static; width: auto; padding: 12px 14px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--raised); }
      .profile-sticky { position: static; }
      .matrix td { padding-top: 18px; }
      .mobile-environment-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; padding: 9px 12px; background: var(--raised); }
      .mobile-environment-header strong { font-size: 14px; }
      .mobile-environment-header span { color: var(--muted-foreground); font: 10px/1.4 var(--font-mono); }
    }
    @media (max-width: 980px) {
      main { width: min(100% - 32px, 1560px); margin-top: 32px; }
      .report-header { grid-template-columns: 1fr; gap: 24px; }
      .report-actions { flex-wrap: wrap; }
      .billing-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .suite-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .suite-summary > div { border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
      .suite-summary > div:nth-child(even) { border-right: 0; }
      .suite-summary > div:last-child { border-bottom: 0; }
      .billing-metric, .billing-metric:nth-child(4n) { border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
      .billing-metric:nth-child(even) { border-right: 0; }
      .billing-metric:nth-child(n + 7) { border-bottom: 0; }
      .section-heading { grid-template-columns: 1fr; gap: 12px; }
      .trend-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .history-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .report-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .report-search, .filter-result { grid-column: 1 / -1; }
      .suite-nav { top: 0; }
      .suite-section, .history-section { scroll-margin-top: 72px; }
    }
    @media (max-width: 640px) {
      .brand-bar { min-height: 56px; padding: 0 16px; }
      .brand-context { display: none; }
      main { width: min(100% - 24px, 1560px); margin-top: 28px; }
      .report-header { padding-bottom: 24px; }
      .report-actions { display: grid; }
      .summary { width: 100%; }
      .metric { min-width: 0; flex: 1; padding: 11px; }
      .metric strong { font-size: 16px; }
      .gallery-launch { width: 100%; }
      .billing-strip { grid-template-columns: 1fr; }
      .billing-strip > div { border-right: 0; border-bottom: 1px solid var(--border); }
      .billing-strip > div:last-child { border-bottom: 0; }
      .gallery-toolbar, .gallery-footer { padding: 12px; }
      .gallery-stage { padding: 12px 56px; }
      .gallery-control { width: 40px; height: 56px; }
      .gallery-previous { left: 8px; }
      .gallery-next { right: 8px; }
      .suite-nav { top: 0; overflow-x: auto; flex-wrap: nowrap; }
      .suite-nav a { white-space: nowrap; }
      .history-pointers, .trend-grid, .history-filters { grid-template-columns: 1fr; }
      .report-filters { grid-template-columns: 1fr; }
      .report-search, .filter-result { grid-column: auto; }
      .suite-summary { grid-template-columns: 1fr; }
      .suite-summary > div, .suite-summary > div:nth-child(even) { border-right: 0; border-bottom: 1px solid var(--border); }
      .suite-summary > div:last-child { border-bottom: 0; }
      .suite-trends-heading { display: block; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 100ms !important; }
    }
    .public-summary { margin: 0 0 32px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--raised); }
    .public-summary img { display: block; width: 100%; height: auto; border-radius: 6px; }
    @media print {
      .brand-bar, .gallery-launch, dialog { display: none; }
      main { width: 100%; margin: 0; }
      .table-wrap { max-height: none; overflow: visible; }
      .matrix thead th, .profile-cell, .profile-sticky { position: static; }
    }
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
  <main id="overview">
    <header class="report-header">
      <div>
        <p class="eyebrow">Full-stack acceptance campaign</p>
        <h1>${html(input.title)}</h1>
        <p class="lede">A browser-verified matrix of runner profiles, execution environments, and deterministic task contracts. Visual evidence is retained in the access-controlled workflow artifact; public history contains inert structured evidence and a trusted synthetic campaign summary.</p>
      </div>
      <div class="report-actions">
        <div class="summary" aria-label="Campaign summary">
          <div class="metric"><strong>${passed}/${input.expected.length}</strong><span>Passed</span></div>
          <div class="metric"><strong>${failed}</strong><span>Failed</span></div>
          <div class="metric"><strong>${html(durationLabel(totalDuration))}</strong><span>Test time</span></div>
        </div>
        <button class="gallery-launch" type="button" data-gallery-open ${screenshotCount === 0 ? "disabled" : ""}>${screenshotCount === 0 ? "Visual evidence · workflow artifact only" : `View gallery · ${screenshotCount}`}</button>
      </div>
    </header>
    ${publicSummaryImageHref ? `<figure class="public-summary"><img src="${html(publicSummaryImageHref)}" alt="Runner E2E campaign status summary"></figure>` : ""}
    <section class="billing-overview" aria-label="Campaign billing summary">
      <div class="billing-metric"><strong>${html(tokenLabel(campaignBilling.llm.inputTokens))}</strong><span>Input tokens</span></div>
      <div class="billing-metric"><strong>${html(tokenLabel(campaignBilling.llm.outputTokens))}</strong><span>Output tokens</span></div>
      <div class="billing-metric"><strong>${html(tokenLabel(campaignBilling.llm.cachedInputTokens))}</strong><span>Cached tokens</span></div>
      <div class="billing-metric"><strong>${html(usdLabel(campaignBilling.reportedLlmCostUsd))}</strong><span>LLM reported subtotal</span></div>
      <div class="billing-metric"><strong>${html(usdLabel(campaignBilling.estimatedRuntimeCostUsd))}</strong><span>Daytona list estimate</span></div>
      <div class="billing-metric"><strong>${html(durationLabel(campaignBilling.agentRunDurationMs))}</strong><span>Agent execution time</span></div>
      <div class="billing-metric"><strong>${html(durationLabel(campaignBilling.leaseDurationMs))}</strong><span>Daytona lease time</span></div>
      <div class="billing-metric"><strong>${campaignBilling.llm.runsWithReportedCost}/${campaignBilling.llm.runCount}</strong><span>Runs provider-priced</span></div>
      <p class="billing-note">Model spend is the provider-reported subtotal; unpriced or unavailable runs are excluded, never counted as free. Daytona runtime is a public-list-price estimate from captured lease time and pinned resources, before credits, discounts, storage allowance, or invoice adjustments. Local execution has no external runtime meter.</p>
    </section>
    <nav class="suite-nav" aria-label="Report sections">
      <a href="#overview">Overview</a>
      ${suites.map((suite) => `<a href="#suite-${html(suite.id)}">${html(suite.label)}</a>`).join("")}
      <a href="#history">History</a>
    </nav>
    <section class="report-filters" aria-label="Filter test results">
      <label class="report-search"><span>Search tests</span><input type="search" placeholder="Test, model, provider, execution ID…" autocomplete="off" data-report-query></label>
      <label><span>Agent profile</span><select data-report-profile><option value="">All profiles</option>${filterProfiles.map((profile) => `<option value="${html(profile.id)}">${html(profile.label)}</option>`).join("")}</select></label>
      <label><span>Environment</span><select data-report-environment><option value="">All environments</option>${filterEnvironments.map((environment) => `<option value="${html(environment.id)}">${html(environment.label)}</option>`).join("")}</select></label>
      <label><span>Suite</span><select data-report-suite><option value="">All suites</option>${suites.map((suite) => `<option value="${html(suite.id)}">${html(suite.label)}</option>`).join("")}</select></label>
      <label><span>Status</span><select data-report-status><option value="">All statuses</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="missing">Missing</option><option value="not-selected">Not selected</option></select></label>
      <button class="filter-reset" type="button" data-report-reset>Reset</button>
      <p class="filter-result" data-report-result aria-live="polite"></p>
    </section>
    ${suiteSections}
    ${historySection}
    <footer><span>Generated ${html(input.generatedAt)}</span><span>${input.catalog.length} catalog executions · Public history excludes provider-produced visual evidence</span></footer>
  </main>
  <dialog class="gallery-dialog" data-gallery-dialog aria-labelledby="gallery-title">
    <div class="gallery-shell">
      <div class="gallery-toolbar">
        <div class="gallery-meta">
          <strong id="gallery-title" data-gallery-title>Screenshot evidence</strong>
          <div class="gallery-context">
            <span><strong data-gallery-profile></strong><em data-gallery-profile-detail></em></span>
            <span><strong data-gallery-environment></strong><em data-gallery-environment-detail></em></span>
            <span><strong data-gallery-case></strong><em data-gallery-runtime></em></span>
          </div>
          <div class="gallery-facts">
            <span class="gallery-status" data-gallery-status></span>
            <span><em>Duration</em><strong data-gallery-duration></strong></span>
            <span><em>Tokens</em><strong data-gallery-tokens></strong></span>
            <span><em>Tests</em><strong data-gallery-matchers></strong></span>
          </div>
          <code class="gallery-execution" data-gallery-execution></code>
        </div>
        <button class="gallery-close" type="button" data-gallery-close>Close</button>
      </div>
      <div class="gallery-stage" data-gallery-stage>
        <button class="gallery-control gallery-previous" type="button" data-gallery-previous aria-label="Previous">&#8592;</button>
        <img data-gallery-image alt="">
        <button class="gallery-control gallery-next" type="button" data-gallery-next aria-label="Next">&#8594;</button>
      </div>
      <div class="gallery-footer">
        <span class="gallery-position" data-gallery-position aria-live="polite"></span>
      </div>
    </div>
  </dialog>
  <script>
    (() => {
      const dialog = document.querySelector("[data-gallery-dialog]");
      const items = Array.from(document.querySelectorAll("[data-gallery-item]"));
      if (!dialog || items.length === 0) return;
      const image = dialog.querySelector("[data-gallery-image]");
      const title = dialog.querySelector("[data-gallery-title]");
      const execution = dialog.querySelector("[data-gallery-execution]");
      const profile = dialog.querySelector("[data-gallery-profile]");
      const profileDetail = dialog.querySelector("[data-gallery-profile-detail]");
      const environment = dialog.querySelector("[data-gallery-environment]");
      const environmentDetail = dialog.querySelector("[data-gallery-environment-detail]");
      const caseLabel = dialog.querySelector("[data-gallery-case]");
      const runtime = dialog.querySelector("[data-gallery-runtime]");
      const status = dialog.querySelector("[data-gallery-status]");
      const duration = dialog.querySelector("[data-gallery-duration]");
      const tokens = dialog.querySelector("[data-gallery-tokens]");
      const matchers = dialog.querySelector("[data-gallery-matchers]");
      const position = dialog.querySelector("[data-gallery-position]");
      const stage = dialog.querySelector("[data-gallery-stage]");
      let activeItem = items[0];
      let pointerStartX = null;

      const render = () => {
        const visibleItems = items.filter((item) => !item.closest("[data-report-case]").hidden);
        if (visibleItems.length === 0) return;
        let activeIndex = visibleItems.indexOf(activeItem);
        if (activeIndex < 0) {
          activeIndex = 0;
          activeItem = visibleItems[0];
        }
        const item = activeItem;
        image.src = item.dataset.galleryHref;
        image.alt = item.dataset.galleryLabel + " for " + item.dataset.galleryExecution;
        title.textContent = item.dataset.galleryLabel;
        execution.textContent = item.dataset.galleryExecution;
        profile.textContent = item.dataset.galleryProfile;
        profileDetail.textContent = item.dataset.galleryGeneration + " · " + item.dataset.galleryProvider + " · " + item.dataset.galleryModel;
        environment.textContent = item.dataset.galleryEnvironment;
        environmentDetail.textContent = item.dataset.galleryEnvironmentProvider + " · " + item.dataset.galleryExecutionTarget;
        caseLabel.textContent = item.dataset.galleryCase;
        runtime.textContent = item.dataset.galleryRuntime + " runtime";
        status.textContent = item.dataset.galleryStatus;
        status.dataset.status = item.dataset.galleryStatus;
        duration.textContent = item.dataset.galleryDuration;
        tokens.textContent = item.dataset.galleryTokens;
        matchers.textContent = item.dataset.galleryMatchers;
        position.textContent = "Image " + (activeIndex + 1) + " of " + visibleItems.length;
      };
      const move = (amount) => {
        const visibleItems = items.filter((item) => !item.closest("[data-report-case]").hidden);
        if (visibleItems.length === 0) return;
        const activeIndex = Math.max(0, visibleItems.indexOf(activeItem));
        activeItem = visibleItems[(activeIndex + amount + visibleItems.length) % visibleItems.length];
        render();
      };
      const open = (item) => {
        if (!item) return;
        activeItem = item;
        render();
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      };
      const close = () => {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      };

      items.forEach((item) => item.addEventListener("click", () => open(item)));
      document.querySelectorAll("[data-gallery-open]").forEach((button) => button.addEventListener("click", () => open(items.find((item) => !item.closest("[data-report-case]").hidden))));
      dialog.querySelector("[data-gallery-previous]").addEventListener("click", () => move(-1));
      dialog.querySelector("[data-gallery-next]").addEventListener("click", () => move(1));
      dialog.querySelector("[data-gallery-close]").addEventListener("click", close);
      dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
      dialog.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
        if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
      });
      stage.addEventListener("pointerdown", (event) => { pointerStartX = event.clientX; });
      stage.addEventListener("pointerup", (event) => {
        if (pointerStartX === null) return;
        const distance = event.clientX - pointerStartX;
        pointerStartX = null;
        if (Math.abs(distance) < 60) return;
        move(distance > 0 ? -1 : 1);
      });
      stage.addEventListener("pointercancel", () => { pointerStartX = null; });
    })();
  </script>
  <script>
    (() => {
      const cases = Array.from(document.querySelectorAll("[data-report-case]"));
      if (cases.length === 0) return;
      const query = document.querySelector("[data-report-query]");
      const profile = document.querySelector("[data-report-profile]");
      const environment = document.querySelector("[data-report-environment]");
      const suite = document.querySelector("[data-report-suite]");
      const status = document.querySelector("[data-report-status]");
      const reset = document.querySelector("[data-report-reset]");
      const result = document.querySelector("[data-report-result]");
      const galleryLaunch = document.querySelector("[data-gallery-open]");
      const apply = () => {
        const search = query.value.trim().toLowerCase();
        let visible = 0;
        cases.forEach((item) => {
          const matches =
            (!search || item.dataset.reportSearch.includes(search)) &&
            (!profile.value || item.dataset.reportProfile === profile.value) &&
            (!environment.value || item.dataset.reportEnvironment === environment.value) &&
            (!suite.value || item.dataset.reportSuite === suite.value) &&
            (!status.value || item.dataset.reportStatus === status.value);
          item.hidden = !matches;
          if (matches) visible += 1;
        });
        document.querySelectorAll("[data-report-profile-row]").forEach((row) => {
          row.hidden = !row.querySelector("[data-report-case]:not([hidden])");
        });
        document.querySelectorAll(".suite-section").forEach((section) => {
          section.hidden = !section.querySelector("[data-report-case]:not([hidden])");
        });
        const visibleImages = cases.reduce(
          (total, item) => total + (item.hidden ? 0 : item.querySelectorAll("[data-gallery-item]").length),
          0,
        );
        result.textContent = visible + " of " + cases.length + " tests shown";
        if (galleryLaunch) {
          galleryLaunch.disabled = visibleImages === 0;
          galleryLaunch.textContent = visibleImages === 0 ? "No visual evidence in selection" : "View gallery · " + visibleImages;
        }
      };
      [query, profile, environment, suite, status].forEach((control) => {
        control.addEventListener(control === query ? "input" : "change", apply);
      });
      reset.addEventListener("click", () => {
        query.value = "";
        profile.value = "";
        environment.value = "";
        suite.value = "";
        status.value = "";
        apply();
        query.focus();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        query.focus();
      });
      apply();
    })();
  </script>
  <script>
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
  </script>
</body>
</html>
`;
}
