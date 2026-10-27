import { campaignAttemptTimeLabel, campaignTimingScope, renderWorkerPhaseTiming, summarizeCampaignTiming, summarizeWorkerPhaseTiming } from "./campaign-timing.js";
import { html, durationLabel, tokenLabel, llmCostLabel, usdLabel } from "./report-format.js";
import { renderReportShell, reportNavigationStyles, reportShellScript } from "./report-navigation.js";
import { reportBrowserScript } from "./report-browser.js";
import { isIncompleteFirstTaskResult, renderCaseOutcome } from "./case-outcome.js";
import { latencyIntervalLabel } from "./latency-timing.js";
import { campaignSuiteSummaryStyles, renderCampaignSuiteSummary, renderSuiteCaseIndex } from "./campaign-summary.js";
import { journeyCapabilities, journeyFeatureIds } from "./journey-features.js";
import { journeyFeatureStyles, renderJourneyFeatureCoverage, renderJourneyFeatureOptions } from "./feature-coverage.js";
import { STARTUP_REUSE_LAYERS, summarizeStartupReuse } from "../../packages/adapter-utils/src/startup-reuse.js";
import { renderFirstTaskDetails } from "./first-task-report.js";
import { summarizeCampaignFeedback } from "./feedback.js";
import { renderCampaignFeedbackReview } from "./feedback-dispositions.js";
import { renderEvalOperationsReport } from "./operations-report.js";
import { renderBraintrustExperiment } from "./braintrust-experiment.js";
import {
  discoverReportCatalog,
  type ReportExecution,
} from "./report-catalog.js";
import type {
  RunnerE2ECampaign,
  RunnerE2EHistoryIndex,
  RunnerE2EResult,
  RunnerE2ESuiteSummary,
} from "./types.js";
import {
  aggregateCampaignBilling,
  billingCoverageLabel,
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
  catalog: readonly ReportExecution[];
  entries: readonly RunnerDashboardEntry[];
  campaign?: RunnerE2ECampaign;
  history?: RunnerE2EHistoryIndex;
}

interface ResolvedScreenshot {
  id: string;
  label: string;
  file: string;
  href: string;
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
  execution: ReportExecution,
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
        : isIncompleteFirstTaskResult(entry.result, entry.errors)
          ? "incomplete"
          : "failed";
  const label = state.replace("-", " ");
  const detail =
    entry?.errors.join("; ") ||
    (entry?.valid
      ? "All invariants passed"
      : selected
        ? "No result artifact was uploaded"
        : "Not selected");
  const screenshots = resolveScreenshots(entry).map((item) =>
    state === "incomplete" && /failure/i.test(item.label)
      ? { ...item, label: "Task state when recording stopped" }
      : item,
  );
  const billing = entry ? summarizeExecutionBilling(entry.result) : null;
  const capabilities = journeyCapabilities(execution);
  const features = [...new Map(capabilities.map((capability) => [capability.feature.id, capability.feature])).values()];
  const outcome = entry ? renderCaseOutcome(entry.result, entry.valid, entry.errors) : "";
  const passed = state === "passed" && entry?.result.status === "passed";
  const firstTaskChecks = entry?.result.firstTask?.checks;
  const productChecks = entry?.result.productJourney?.checks;
  const notReached = firstTaskChecks?.filter((c) => c.notReached).length ?? 0;
  const matcherResults = firstTaskChecks?.length
    ? firstTaskChecks.filter((c) => !c.notReached).map((c) => ({
        matcher: { kind: "json_path" as const, path: `firstTask.checks.${c.id}`, expected: true },
        passed: c.passed,
        detail: c.detail,
      }))
    : productChecks?.length ? productChecks.map(c => ({
        matcher: { kind: "json_path" as const, path: `productJourney.checks.${c.id}`, expected: true },
        passed: c.passed, detail: c.id.replaceAll("-", " "),
      })) : entry?.result.matcherResults ?? [];
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
    ...capabilities.flatMap((capability) => [capability.id, capability.label, capability.feature.title]),
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
  const structuredLinks = [
    ["snapshots/first-task.json", "Full conversation and instruction JSON"],
    ["snapshots/first-task-run-evidence.json", "Full run / tool-event JSON"],
    ["regraded-result.json", "Regraded result JSON"],
    ["result.json", availableFiles?.has("regraded-result.json") ? "Original result JSON" : "Complete result JSON"],
  ].flatMap(([file, label]) => {
    if (!availableFiles?.has(file)) return [];
    const href = safeEvidenceHref(entry?.evidenceBaseHref, file);
    return href ? [`<a href="${html(href)}">${html(label)}</a>`] : [];
  });
  const links =
    playwright || structuredLinks.length > 0
      ? `<nav class="evidence-links" aria-label="Evidence for ${html(execution.id)}">
          ${playwright ? `<a href="${html(playwright)}">Open Playwright report</a>` : ""}
          ${structuredLinks.join("")}
        </nav>`
      : "";
  const matcherRows = matcherResults
    .map(
      (result) => `<tr class="matcher-${result.passed ? "passed" : "failed"}">
        <td><span class="matcher-state" aria-label="${result.passed ? "Passed" : "Failed"}">${result.passed ? "Pass" : "Fail"}</span></td>
        <td><code>${html(result.matcher.kind)}</code></td>
        <td>${html(compactJson(result.matcher))}</td>
        <td>${html(result.detail)}</td>
      </tr>`,
    )
    .join("");
  const turnTimingRows = (entry?.result.turnTimings ?? [])
    .map(
      (timing) => `<tr>
        <td>${timing.turn}</td>
        <td><code>${html(timing.runId)}</code></td>
        <td>${html(timing.leaseAcquisitionOutcome)}</td>
        <td>${html(timing.schedulerLatencyMs === null ? "unavailable" : durationLabel(timing.schedulerLatencyMs))}</td>
        <td>${html(timing.runDurationMs === null ? "unavailable" : durationLabel(timing.runDurationMs))}</td>
        <td>${html(timing.responseLatencyMs === null ? "unavailable" : durationLabel(timing.responseLatencyMs))}</td>
      </tr>`,
    )
    .join("");
  const latencyRows = (entry?.result.latencyProbes ?? []).map(probe => `<tr>
    <td>${html(probe.event)}</td><td>${html(probe.verdict)}</td>
    <td>${html(latencyIntervalLabel(probe))}</td><td>${html(`${probe.target.operator} ${probe.target.ms} ms`)}</td>
    <td>${html(probe.resolutionMs === null ? "unknown" : `${probe.resolutionMs} ms`)}</td>
    </tr>`).join("");
  const startupReuseRows = (entry?.result.startupReuse ?? (entry?.result.runIds ?? []).map(runId => ({
    runId, ...summarizeStartupReuse([]),
  }))).map(reuse => `<tr>
    <td><code>${html(reuse.runId)}</code></td><td>${html(reuse.warmth)}</td>
    ${STARTUP_REUSE_LAYERS.map(layer => `<td>${html(reuse.layers[layer].state)} (${html(reuse.layers[layer].reason)})</td>`).join("")}
    <td>${html(reuse.providerLaunchCount === null ? "unknown" : reuse.providerLaunchCount)}</td>
  </tr>`).join("");
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
            data-gallery-model="${html(entry?.result.model ?? (execution.suite.id === "first-task" ? "Production onboarding default" : execution.profile.model))}"
            data-gallery-environment="${html(execution.environment.label)}"
            data-gallery-environment-provider="${html(execution.environment.provider)}"
            data-gallery-execution-target="${html(execution.environment.expectedExecutionTarget.kind)}"
            data-gallery-runtime="${html(entry?.result.runtimeMode ?? execution.profile.expectedRuntimeMode)}"
            data-gallery-status="${html(label)}"
            data-gallery-duration="${html(entry ? durationLabel(entry.result.durationMs) : "Not run")}"
            data-gallery-tokens="${html(billing ? `${tokenLabel(billing.llm.inputTokens, billing.llm)} in · ${tokenLabel(billing.llm.outputTokens, billing.llm)} out` : "Unavailable")}"
            data-gallery-matchers="${html(matcherResults.length > 0 ? `${passedMatchers}/${matcherResults.length} matchers passed${notReached ? ` · ${notReached} not reached` : ""}` : "No matchers recorded")}"
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
        <div><span>Tokens</span><strong>${html(tokenLabel(billing.llm.inputTokens, billing.llm))} in · ${html(tokenLabel(billing.llm.outputTokens, billing.llm))} out</strong><small>${html(tokenLabel(billing.llm.cachedInputTokens, billing.llm))} cached · ${billing.llm.runsWithTokenUsage}/${billing.llm.runCount} runs covered</small></div>
        <div><span>LLM spend</span><strong>${html(llmCostLabel(billing.reportedCostUsd, billing.llm))}</strong><small>${billing.llm.runsWithReportedCost}/${billing.llm.runCount} runs provider-priced</small></div>
        ${(billing.llm.runsWithEstimatedCost ?? 0) > 0 ? `<div><span>LLM estimate</span><strong>${html(billingCoverageLabel(usdLabel(billing.llm.estimatedCostUsd ?? 0), billing.llm.runsWithEstimatedCost ?? 0, billing.llm.runCount))}</strong><small>Estimated from captured usage</small></div>` : ""}
        <div><span>Execution</span><strong>${billing.runtime.estimatedListCostUsd === undefined ? html(billing.runtime.costStatus === "not_metered" ? "Local · not metered" : "Cost unavailable") : `${html(usdLabel(billing.runtime.estimatedListCostUsd))} est.`}</strong><small>${html(durationLabel(billing.runtime.agentRunDurationMs))} agent${billing.runtime.leaseDurationMs === null ? "" : ` · ${html(durationLabel(billing.runtime.leaseDurationMs))} lease`}</small></div>
        ${billing.assistant ? `<div><span>External assistant</span><strong>${html(usdLabel(billing.assistant.estimatedCostUsd))} est.</strong><small>${html(billing.assistant.model)} · ${billing.assistant.requests} requests · ${html(tokenLabel(billing.assistant.inputTokens + billing.assistant.cachedInputTokens))} in / ${html(tokenLabel(billing.assistant.outputTokens))} out</small></div>` : ""}
      </div>`
    : "";
  return `<article
    id="execution-${html(execution.id)}"
    class="case case-${state}"
    data-execution-id="${html(execution.id)}"
    data-report-case
    data-report-label="${html(execution.task.label)}"
    data-report-case-key="${html(`${execution.suite.id}.${execution.task.id}`)}"
    data-report-suite="${html(execution.suite.id)}"
    data-report-features="${html(journeyFeatureIds(execution).join(" "))}"
    data-report-profile="${html(execution.profile.id)}"
    data-report-environment="${html(execution.environment.id)}"
    data-report-status="${html(state)}"
    data-report-search="${html(searchText)}"
  >
    <div class="case-heading">
      <strong><a class="case-open" data-nav-case="${html(`${execution.suite.id}.${execution.task.id}`)}" href="?view=case&amp;case=${encodeURIComponent(`${execution.suite.id}.${execution.task.id}`)}#execution-${html(execution.id)}">${html(execution.task.label)}</a></strong>
      <span class="status">${html(label)}</span>
    </div>
    ${features.length ? `<div class="case-features">${features.map((feature) =>
      `<button type="button" class="feature-choice" data-report-feature-choice="${html(feature.id)}" title="${html(capabilities.filter((capability) => capability.feature.id === feature.id).map((capability) => capability.id).join(", "))}">${html(feature.title)}</button>`,
    ).join("")}</div>` : ""}
    ${passed ? "" : outcome}
    ${!entry ? `<p class="case-empty">No result artifact was uploaded.</p>` : ""}
    ${gallery}
    <details class="case-context case-diagnostics">
      <summary><span>Test details</span><span class="case-detail-summary">${matcherResults.length ? `${passedMatchers}/${matcherResults.length} checks${notReached ? ` · ${notReached} not reached` : ""}` : "No checks recorded"}${entry ? ` · ${html(durationLabel(entry.result.durationMs))}` : ""}</span></summary>
    ${passed ? outcome : ""}
    ${billingStrip}
    ${entry ? `<p class="detail">Worker phase timing: ${entry.result.workerTiming ? html(entry.result.workerTiming.status === "unavailable" ? `unavailable (${entry.result.workerTiming.reason})` : entry.result.workerTiming.status) : "not captured"}. ${entry.result.workerTiming?.status === "partial" ? "Only completed phases have observed durations." : ""}</p>` : ""}
    ${entry?.result.feedback ? `<p class="detail">Feedback: ${entry.result.feedback.complaints} complaints · ${entry.result.feedback.suggestions} suggestions · ${entry.result.feedback.review.length} distinct items; see campaign feedback review. Saved-feedback collection: ${html(entry.result.feedback.collection)}; invocation coverage: ${html(entry.result.feedback.invocationCollection)}. Tool receipts: ${entry.result.feedback.invocations.failed} failed · ${entry.result.feedback.invocations.unknown} unresolved. Full bodies: access-controlled snapshots/agent-feedback.json or snapshots/agent-feedback-recovered.json.</p>` : entry ? `<p class="detail">Feedback was not captured for this attempt.</p>` : ""}
    ${entry?.result.tracing ? `<p class="detail">Braintrust worker export: ${html(entry.result.tracing.status)}; native configuration: ${html(entry.result.tracing.nativeConfiguration)}. ${entry.result.tracing.finalization ? `Supervisor outcome: ${html(entry.result.tracing.finalization.outcome)}; finalization export: ${html(entry.result.tracing.finalization.status)}.` : "Supervisor finalization was not captured."} Trace ${html(entry.result.tracing.traceId)} in project ${html(entry.result.tracing.projectId)}. Indexing and native-span correlation require independent verification.</p>` : ""}
    ${links}
    ${renderFirstTaskDetails(entry?.result)}
    <code class="execution-id">${html(execution.id)}</code>
    ${capabilities.length ? `<ul class="case-capabilities" aria-label="Capabilities tested">${capabilities.map((capability) => `<li>${html(capability.feature.title)} · ${html(capability.label)}</li>`).join("")}</ul>` : ""}
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
    ${turnTimingRows ? `<div class="matcher-wrap"><table class="matchers"><thead><tr><th>Turn</th><th>Run</th><th>Lease</th><th>Scheduler</th><th>Run duration</th><th>Final settlement (legacy response field)</th></tr></thead><tbody>${turnTimingRows}</tbody></table></div>` : ""}
    ${latencyRows ? `<div class="matcher-wrap"><table class="matchers"><thead><tr><th>Event</th><th>Timing verdict</th><th>Possible latency</th><th>Target</th><th>Resolution</th></tr></thead><tbody>${latencyRows}</tbody></table></div>` : ""}
    ${startupReuseRows ? `<div class="matcher-wrap"><table class="matchers"><caption>Startup reuse evidence</caption><thead><tr><th>Run</th><th>Warmth</th><th>Environment/lease</th><th>Workspace</th><th>Runner</th><th>Provider process</th><th>Provider session</th><th>Provider launches</th></tr></thead><tbody>${startupReuseRows}</tbody></table></div>` : ""}
    ${matcherRows ? `<div class="matcher-wrap"><table class="matchers"><thead><tr><th>Result</th><th>Matcher</th><th>Expectation</th><th>Detail</th></tr></thead><tbody>${matcherRows}</tbody></table></div>` : `<p class="detail">No matcher result was recorded.</p>`}
    ${entry ? `<details class="usage"><summary>Usage, billing and timing metadata</summary><pre>${html(JSON.stringify({ billing, rawUsage: entry.result.usage ?? null, workerTiming: entry.result.workerTiming ?? null }, null, 2))}</pre></details>` : ""}
    </details>
  </article>`;
}

function renderSuiteResults(input: {
  suiteCatalog: readonly ReportExecution[];
  expected: ReadonlySet<string>;
  entryById: ReadonlyMap<string, RunnerDashboardEntry>;
  summary?: RunnerE2ESuiteSummary;
}) {
  const suite = input.suiteCatalog[0]?.suite;
  if (!suite) return "";
  const summary = input.summary;
  const summaryHtml = summary
    ? `<div class="suite-summary" aria-label="${html(suite.label)} current campaign summary">
        <div><span>Pass rate</span><strong>${summary.selected > 0 ? ((summary.passed / summary.selected) * 100).toFixed(1) : "0.0"}%</strong><small>${summary.passed}/${summary.selected} passed${summary.incomplete ? ` · ${summary.incomplete} incomplete` : ""}</small></div>
        <div><span>Tokens</span><strong>${html(tokenLabel(summary.billing.llm.totalTokens, summary.billing.llm))}</strong><small>${html(tokenLabel(summary.billing.llm.inputTokens, summary.billing.llm))} input · ${html(tokenLabel(summary.billing.llm.outputTokens, summary.billing.llm))} output</small></div>
        <div><span>Known spend</span><strong>${html(summary.billing.llm.runsWithReportedCost > 0 || (summary.billing.llm.runsWithEstimatedCost ?? 0) > 0 || summary.billing.estimatedRuntimeCostUsd > 0 || summary.billing.judge || summary.billing.assistant ? `${usdLabel(summary.billing.observedAndEstimatedCostUsd)}${summary.billing.testsWithCompleteBilling < summary.billing.testCount ? " (partial)" : ""}` : "Unavailable")}</strong><small>reported LLM + model/runtime estimates${summary.billing.judge ? " + judge" : ""} estimate</small></div>
        <div><span>Agent time</span><strong>${html(durationLabel(summary.billing.agentRunDurationMs))}</strong><small>${html(durationLabel(summary.billing.leaseDurationMs))} lease</small></div>
        <div><span>Execution</span><strong>${summary.executed}/${summary.selected}</strong><small>${summary.retries} retries · cleanup ${summary.cleanupPassed ? "passed" : "failed"}</small></div>
      </div>`
    : "";
  const journeys = [...new Map(input.suiteCatalog.map(row => [row.task.id, row.task])).values()];
  return `<section class="suite-section" id="suite-${html(suite.id)}" data-report-suite-section="${html(suite.id)}" data-suite-label="${html(suite.label)}">
    <div class="section-heading"><div><p class="eyebrow">Test suite</p><h2>${html(suite.label)}</h2></div><p>${html(suite.description)}</p></div>
    ${summaryHtml}
    <nav class="suite-case-toc" aria-label="${html(suite.label)} cases">
      <div class="suite-case-toc-heading"><h3>Cases</h3><a href="#overview">Back to overview ↑</a></div>
      ${renderSuiteCaseIndex(input.suiteCatalog)}
    </nav>
    ${journeys.map(task => {
      const key = `${suite.id}.${task.id}`;
      const executions = input.suiteCatalog.filter(row => row.task.id === task.id);
      const href = `?view=case&case=${encodeURIComponent(key)}`;
      return `<section class="report-journey" id="journey-${html(key)}" data-report-journey="${html(key)}">
        <div class="report-journey-heading"><h3><a href="${html(href)}" data-nav-case="${html(key)}" data-report-case-link="${html(key)}">${html(task.label)}</a></h3><a href="${html(href)}" data-nav-case="${html(key)}" data-report-case-link="${html(key)}">Inspect case ↗</a></div>
        <div class="case-config-options" aria-label="Execution configurations" hidden>${executions.map(row => `<button type="button" data-nav-configuration="${html(row.id)}" aria-pressed="false"><span class="case-status-dot" aria-hidden="true"></span>${html(row.profile.label)} · ${html(row.environment.label)}</button>`).join("")}</div>
        <div class="execution-previews">${executions.map(row => `<div class="execution-preview"><div class="execution-preview-label"><strong>${html(row.profile.label)}</strong><span>${html(row.environment.label)}</span><span>${html(row.profile.provider)} · ${html(row.profile.model)}</span></div>${renderCase(row, input.expected, input.entryById)}</div>`).join("")}</div>
      </section>`;
    }).join("")}
  </section>`;
}

export function renderRunnerE2EDashboard(input: RunnerDashboardInput) {
  const expected = new Set(input.expected);
  const catalog = discoverReportCatalog({
    catalog: input.catalog,
    expected: input.expected,
    results: input.entries.map((entry) => entry.result),
  }).filter((execution) => expected.has(execution.id));
  const entryById = new Map(
    input.entries.map((entry) => [entry.result.executionId, entry]),
  );
  const selectedEntries = input.entries.filter((entry) =>
    expected.has(entry.result.executionId),
  );
  const passed = selectedEntries.filter((entry) => entry.valid).length;
  const incomplete = selectedEntries.filter((entry) =>
    !entry.valid && isIncompleteFirstTaskResult(entry.result, entry.errors),
  ).length;
  const failed = input.expected.length - passed - incomplete;
  const timing = summarizeCampaignTiming(selectedEntries.map(entry => entry.result), input.campaign?.accounting);
  const screenshotCount = selectedEntries.reduce(
    (total, entry) => total + resolveScreenshots(entry).length,
    0,
  );
  const campaignFeedback = summarizeCampaignFeedback(input.campaign?.accounting?.attempts ?? input.entries.map(entry => entry.result));
  const campaignBilling = input.campaign?.billing ?? aggregateCampaignBilling(
    selectedEntries.map((entry) => entry.result),
  );
  const suites = [
    ...new Map(
      catalog.map((execution) => [execution.suite.id, execution.suite]),
    ).values(),
  ];
  const suiteSections = suites
    .map((suite) =>
      renderSuiteResults({
        suiteCatalog: catalog.filter(
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
  const filterProfiles = [
    ...new Map(
      catalog.map((execution) => [execution.profile.id, execution.profile]),
    ).values(),
  ];
  const filterEnvironments = [
    ...new Map(
      catalog.map((execution) => [
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
      /* TaskChatBubble: right-aligned human bubbles use Paperclip's liveness blue. */
      --chat-human-background: #2563eb;
      --chat-human-foreground: #ffffff;
      --chat-bubble-radius: 1rem;
      --chat-body-size: 0.875rem;
      --navigation-sticky-offset: 0px;
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
    [hidden] { display: none !important; }
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
    .report-filters { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); align-items: end; gap: 10px; margin: 0 0 40px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
    .report-search { grid-column: span 5; }
    .report-feature { grid-column: span 2; }
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
    .case { min-width: 0; max-width: 100%; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); overflow: hidden; scroll-margin-top: 80px; }
    .case-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    .case-heading strong { font-size: 14px; font-weight: 650; }
    .case-empty { margin: 12px 0; color: var(--muted-foreground); font-size: 12px; }
    .status, .matcher-state { display: inline-block; flex: none; padding: 3px 8px; border: 1px solid; border-radius: 999px; font: 600 10px/1.4 var(--font-sans); letter-spacing: .05em; text-transform: uppercase; }
    .case-passed .status, .matcher-passed .matcher-state { border-color: var(--pass-border); background: var(--pass-bg); color: var(--pass-text); }
    .case-failed .status, .matcher-failed .matcher-state { border-color: var(--fail-border); background: var(--fail-bg); color: var(--fail-text); }
    .case-incomplete .status, .gallery-status[data-status="incomplete"], .case-missing .status { border-color: var(--missing-border); background: var(--missing-bg); color: var(--missing-text); }
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
    .results-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin: 40px 0 20px; }
    .results-heading h2 { margin: 0; font-size: 24px; }
    .results-heading a { color: var(--muted-foreground); font-size: 12px; }
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
    .suite-case-toc { margin: 0 0 24px; }
    .suite-case-toc-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
    .suite-case-toc-heading h3 { margin: 0; font-size: 13px; font-weight: 600; }
    .suite-case-toc-heading > a { color: var(--muted-foreground); font-size: 11px; }

    .case-context > summary, .usage > summary { width: fit-content; cursor: pointer; color: var(--foreground); font-size: 12px; font-weight: 600; }
    .case-diagnostics { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
    .case-diagnostics > summary { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; width: 100%; list-style: none; }
    .case-diagnostics > summary::-webkit-details-marker { display: none; }
    .case-diagnostics > summary::before { content: "›"; color: var(--muted-foreground); font-size: 16px; line-height: 1; }
    .case-diagnostics[open] > summary::before { transform: rotate(90deg); }
    .case-detail-summary { margin-left: auto; color: var(--muted-foreground); font: 400 11px/1.5 var(--font-mono); }
    .case-capabilities { padding-left: 16px; color: var(--muted-foreground); font-size: 11px; }
    .case-outcome { margin: 12px 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--raised); font-size: 12px; }
    .case-incomplete > .case-outcome { border-color: var(--missing-border); }
    .case-failed > .case-outcome { border-color: var(--fail-border); }
    .case-outcome p { margin: 8px 0; }
    .failure-reason { white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.6 var(--font-mono); }
    .conversation-details { margin: 16px 0; }
    .transcript { display: flex; flex-direction: column; gap: 22px; max-width: 56rem; margin: 18px auto; }
    .transcript-about { color: var(--muted-foreground); font-size: 11px; }
    .transcript summary { cursor: pointer; }
    .transcript-entry { min-width: 0; width: 100%; align-self: flex-start; }
    .transcript-entry header { display: flex; align-items: center; gap: 8px; padding: 0 4px; font-size: 12px; overflow-wrap: anywhere; }
    .transcript-avatar { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 24px; height: 24px; border-radius: 50%; background: var(--raised); border: 1px solid var(--border); font-size: 10px; }
    .transcript-bubble { min-width: 0; padding: 8px 4px; font-size: var(--chat-body-size); line-height: 1.65; }
    .transcript-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .transcript-text + .transcript-text { margin-top: 10px; }
    .transcript-entry ul { padding-left: 20px; margin: 8px 0; }
    .transcript-entry footer { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: flex-start; gap: 6px 12px; margin: 4px 0 0; padding: 0 4px; color: var(--muted-foreground); font: 10px/1.5 var(--font-sans); overflow-wrap: anywhere; }
    .transcript-entry footer a { color: inherit; text-decoration: none; }
    .transcript-entry footer a:hover { text-decoration: underline; }
    .transcript-task code { display: block; padding-top: 4px; overflow-wrap: anywhere; }
    .transcript-human { width: fit-content; max-width: 85%; align-self: flex-end; }
    .transcript-human header { justify-content: flex-end; margin-bottom: 5px; color: var(--muted-foreground); font-size: 11px; }
    .transcript-human .transcript-bubble { padding: 10px 14px; border-radius: var(--chat-bubble-radius) var(--chat-bubble-radius) 4px var(--chat-bubble-radius); background: var(--chat-human-background); color: var(--chat-human-foreground); }
    .transcript-human footer { justify-content: flex-end; }
    .transcript-answer .transcript-text:first-child { font-size: 12px; font-weight: 600; }
    .transcript-card { padding: 14px; border: 1px solid var(--border); border-radius: calc(var(--radius) * 1.5); background: var(--raised); }
    .transcript-card header { font-size: 12px; }
    .transcript-event { color: var(--muted-foreground); border-left: 2px solid var(--border); padding-left: 12px; }
    .transcript-event header, .transcript-event .transcript-bubble { font-size: 11px; }
    .transcript-event .transcript-bubble { padding-top: 0; padding-bottom: 0; }
    .transcript-raw { margin-top: 8px; font-size: 11px; }
    .report-interaction { display: flex; flex-direction: column; gap: 12px; }
    .interaction-heading, .interaction-question-heading, .interaction-tags, .interaction-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
    .interaction-heading, .interaction-question-heading { color: var(--muted-foreground); font-size: 11px; justify-content: space-between; }
    .interaction-badge { display: inline-block; border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 500; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
    .interaction-title { font-size: 14px; font-weight: 600; white-space: pre-wrap; overflow-wrap: anywhere; }
    .interaction-copy, .interaction-help { white-space: pre-wrap; overflow-wrap: anywhere; }
    .interaction-help { font-size: 12px; color: var(--muted-foreground); margin: 4px 0; }
    .interaction-question { display: flex; flex-direction: column; gap: 8px; padding: 14px; background: var(--card); border: 1px solid var(--border); border-radius: calc(var(--radius) * 1.5); }
    .interaction-option { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--background); font-size: 13px; overflow-wrap: anywhere; }
    .interaction-option > span { min-width: 0; flex: 1; }
    .interaction-option input { flex: 0 0 auto; margin-top: 4px; accent-color: var(--chat-human-background); }
    .interaction-option .interaction-badge { margin-left: 8px; }
    .interaction-option.is-selected { border-color: var(--chat-human-background); background: color-mix(in srgb, var(--chat-human-background) 8%, var(--card)); }
    .interaction-textbox { padding: 12px; min-height: 58px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--background); white-space: pre-wrap; overflow-wrap: anywhere; }
    .interaction-textbox.is-placeholder { color: var(--muted-foreground); font-size: 12px; }
    .interaction-action { padding: 7px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); color: var(--foreground); font: 500 12px var(--font-sans); white-space: normal; }
    .interaction-action:disabled { opacity: 1; cursor: default; }
    .interaction-action.is-primary { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }
    .interaction-action.is-selected { outline: 2px solid var(--chat-human-background); outline-offset: 2px; }
    .interaction-target, .interaction-resolution { padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); }
    .interaction-target > strong { margin-left: 8px; font-size: 12px; }
    .interaction-field { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; overflow-wrap: anywhere; }
    .interaction-field > span { color: var(--muted-foreground); min-width: 80px; }
    .interaction-arguments { font-size: 12px; }
    .transcript a:focus-visible, .transcript summary:focus-visible { outline: 2px solid var(--border-strong); outline-offset: 3px; border-radius: 2px; }
    @media (max-width: 600px) { .transcript { gap: 18px; } .transcript-human { max-width: 92%; } .transcript-card { padding: 10px; } }
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
    .gallery-original { color: #fafafa; font-size: 12px; }
    .back-to-top { position: fixed; right: max(24px, env(safe-area-inset-right)); bottom: max(24px, env(safe-area-inset-bottom)); z-index: 10; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 10px 16px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--foreground); color: var(--background); font: 600 12px/1.4 var(--font-sans); text-decoration: none; }
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
      .report-search, .report-feature, .filter-result { grid-column: 1 / -1; }
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
      .history-pointers, .trend-grid, .history-filters { grid-template-columns: 1fr; }
      .report-filters { grid-template-columns: 1fr; }
      .report-search, .report-feature, .filter-result { grid-column: auto; }
      .suite-summary { grid-template-columns: 1fr; }
      .suite-summary > div, .suite-summary > div:nth-child(even) { border-right: 0; border-bottom: 1px solid var(--border); }
      .suite-summary > div:last-child { border-bottom: 0; }
      .suite-trends-heading { display: block; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 100ms !important; }
    }
    ${campaignSuiteSummaryStyles}
    ${journeyFeatureStyles}
    @media print {
      .brand-bar, .gallery-launch, dialog { display: none; }
      main { width: 100%; margin: 0; }
      .table-wrap { max-height: none; overflow: visible; }
      .matrix thead th, .profile-cell, .profile-sticky { position: static; }
    }
    ${reportNavigationStyles}
  </style>
</head>
<body id="top">
  ${renderReportShell({ campaignId: input.campaign?.campaignId, catalog, history: input.history })}
  <main id="overview">
    <section class="case-page-heading" data-case-page-heading hidden><p class="eyebrow">Test case</p><h1 data-case-page-title tabindex="-1"></h1><a href="?view=all" data-nav-return>← Back to campaign results</a></section>
    <section data-campaign-overview>
    <header class="report-header">
      <div>
        <p class="eyebrow">Full-stack acceptance campaign</p>
        <h1 tabindex="-1">${html(input.title)}</h1>
        <p class="lede">Results across runner profiles and execution environments. Declared PNG screenshots and normalized results are retained with every published campaign; additional diagnostic evidence remains in the access-controlled workflow artifact.</p>
        ${input.campaign ? `<p class="report-source"><span>${html(input.generatedAt)}</span>${input.campaign.source.sha ? `<code>${html(input.campaign.source.sha.slice(0,8))}</code>` : ""}${input.campaign.source.workflowRunUrl ? `<a href="${html(input.campaign.source.workflowRunUrl)}">Source run ↗</a>` : ""}</p>` : ""}
      </div>
      <div class="report-actions">
        <div class="summary" aria-label="Campaign summary">
          <div class="metric"><strong>${passed}/${input.expected.length}</strong><span>Passed</span></div>
          <div class="metric"><strong>${failed}</strong><span>Failed</span></div>
          ${incomplete ? `<div class="metric"><strong>${incomplete}</strong><span>Incomplete</span></div>` : ""}
          <div class="metric"><strong>${html(campaignAttemptTimeLabel(timing))}</strong><span>Summed attempt time</span></div>
        </div>
        <button class="gallery-launch" type="button" data-gallery-open ${screenshotCount === 0 ? "disabled" : ""}>${screenshotCount === 0 ? "Visual evidence · workflow artifact only" : `View gallery · ${screenshotCount}`}</button>
      </div>
    </header>
    ${renderCampaignSuiteSummary(input.campaign?.suites ?? [], catalog, "", false)}
    <details class="campaign-billing-details"><summary>Campaign usage and spend</summary>
    <section class="billing-overview" aria-label="Campaign billing summary">
      <div class="billing-metric"><strong>${campaignFeedback.complaints} / ${campaignFeedback.suggestions}</strong><span>Complaints / suggestions · retained attempts</span><small>${campaignFeedback.review.length} distinct items · ${campaignFeedback.incomplete} attempts with incomplete collection · ${campaignFeedback.failedSubmissions} failed submissions · ${campaignFeedback.unknownSubmissions} unresolved submissions</small></div>
      ${input.campaign?.accounting ? `<div class="billing-metric"><strong>${input.campaign.accounting.attempts.length}</strong><span>${input.campaign.accounting.scope === "retained_attempts" ? "Retained attempts" : "Selected results only"}</span><small>${input.campaign.accounting.missingAttempts} missing attempts · ${input.campaign.accounting.excludedArtifacts} out-of-scope artifacts</small></div>` : ""}
      <div class="billing-metric"><strong>${html(tokenLabel(campaignBilling.llm.inputTokens, campaignBilling.llm))}</strong><span>Input tokens</span></div>
      <div class="billing-metric"><strong>${html(tokenLabel(campaignBilling.llm.outputTokens, campaignBilling.llm))}</strong><span>Output tokens</span></div>
      <div class="billing-metric"><strong>${html(tokenLabel(campaignBilling.llm.cachedInputTokens, campaignBilling.llm))}</strong><span>Cached tokens</span></div>
      <div class="billing-metric"><strong>${html(llmCostLabel(campaignBilling.reportedLlmCostUsd, campaignBilling.llm))}</strong><span>LLM reported subtotal</span></div>
      ${(campaignBilling.llm.runsWithEstimatedCost ?? 0) > 0 ? `<div class="billing-metric"><strong>${html(billingCoverageLabel(usdLabel(campaignBilling.estimatedLlmCostUsd ?? 0), campaignBilling.llm.runsWithEstimatedCost ?? 0, campaignBilling.llm.runCount))}</strong><span>LLM estimated subtotal</span></div>` : ""}
      <div class="billing-metric"><strong>${html(usdLabel(campaignBilling.estimatedRuntimeCostUsd))}</strong><span>Daytona list estimate</span></div>
      ${campaignBilling.judge ? `<div class="billing-metric"><strong>${html(usdLabel(campaignBilling.judge.estimatedCostUsd))}</strong><span>Judge estimate · ${campaignBilling.judge.attempts} attempts · ${campaignBilling.judge.attemptsWithUnknownUsage} unknown usage</span><small>${html(tokenLabel(campaignBilling.judge.inputTokens))} in / ${html(tokenLabel(campaignBilling.judge.outputTokens))} out · $${campaignBilling.judge.reservedCostUsd.toFixed(6)} reserved</small></div>` : ""}
      ${campaignBilling.assistant ? `<div class="billing-metric"><strong>${html(usdLabel(campaignBilling.assistant.estimatedCostUsd))}</strong><span>External assistant estimate · ${campaignBilling.assistant.requests} requests</span><small>${html(tokenLabel(campaignBilling.assistant.inputTokens + campaignBilling.assistant.cachedInputTokens))} in / ${html(tokenLabel(campaignBilling.assistant.outputTokens))} out</small></div>` : ""}
      <div class="billing-metric"><strong>${html(durationLabel(timing.observedWindowMs))}</strong><span>Observed attempt window</span><small>${timing.retainedAttempts} retained attempts · ${timing.missingAttempts} missing attempts</small></div>
      <p class="billing-note">${html(campaignTimingScope)}</p>
      <div class="billing-metric"><strong>${html(durationLabel(campaignBilling.agentRunDurationMs))}</strong><span>Agent execution time</span></div>
      <div class="billing-metric"><strong>${html(durationLabel(campaignBilling.leaseDurationMs))}</strong><span>Daytona lease time</span></div>
      <div class="billing-metric"><strong>${campaignBilling.llm.runsWithReportedCost}/${campaignBilling.llm.runCount}</strong><span>Runs provider-priced</span></div>
      <p class="billing-note">Campaign costs include retained attempts, including failed retries. Result cards show the selected attempt. Provider-reported amounts and model estimates are separate; unpriced or unavailable runs are excluded, never counted as free. Coverage describes captured usage; unobserved setup, subscriptions, tools, CI and storage require additional accounting. Daytona runtime is a public-list-price estimate from captured lease time and pinned resources, before credits, discounts, storage allowance, or invoice adjustments. Local execution has no external runtime meter.</p>
    </section>${renderWorkerPhaseTiming(summarizeWorkerPhaseTiming(selectedEntries.map(entry => entry.result), input.campaign?.accounting))}${input.campaign?.operations ? renderEvalOperationsReport(input.campaign.operations) : ""}${input.campaign ? renderCampaignFeedbackReview(input.campaign) + renderBraintrustExperiment(input.campaign) : ""}</details>
    </section>
    <div class="results-heading" id="results"><h2 data-results-title>All results</h2><span data-results-description></span></div>
    <div data-feature-coverage>${renderJourneyFeatureCoverage(catalog, entryById)}</div>
    <section class="report-filters" aria-label="Filter test results">
      <label class="report-search"><span>Search tests</span><input type="search" placeholder="Test, model, provider, execution ID…" autocomplete="off" data-report-query></label>
      <button class="filter-reset" type="button" data-report-reset>Reset</button>
      <label class="report-feature"><span>Feature</span><select data-report-feature><option value="">All features</option>${renderJourneyFeatureOptions(catalog)}</select></label>
      <label><span>Agent profile</span><select data-report-profile><option value="">All profiles</option>${filterProfiles.map((profile) => `<option value="${html(profile.id)}">${html(profile.label)}</option>`).join("")}</select></label>
      <label><span>Environment</span><select data-report-environment><option value="">All environments</option>${filterEnvironments.map((environment) => `<option value="${html(environment.id)}">${html(environment.label)}</option>`).join("")}</select></label>
      <label><span>Suite</span><select data-report-suite><option value="">All suites</option>${suites.map((suite) => `<option value="${html(suite.id)}">${html(suite.label)}</option>`).join("")}</select></label>
      <label><span>Status</span><select data-report-status><option value="">All statuses</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="incomplete">Incomplete</option><option value="missing">Missing</option></select></label>
      <p class="filter-result" data-report-result aria-live="polite"></p>
    </section>
    ${suiteSections}
    <footer><span>Generated ${html(input.generatedAt)}</span><span>${catalog.length} selected executions · Declared screenshots and normalized results published</span></footer>
  </main>
  </div></div>
  <a class="back-to-top" href="#top" data-back-to-top hidden><span aria-hidden="true">↑</span>Back to top</a>
  <dialog class="gallery-dialog" data-gallery-dialog aria-labelledby="gallery-title">
    <div class="gallery-shell">
      <div class="gallery-toolbar">
        <div class="gallery-meta">
          <strong id="gallery-title" data-gallery-title>Screenshot evidence</strong>
          <div class="gallery-context">
            <span><strong data-gallery-profile></strong><em data-gallery-profile-detail></em></span>
            <span><em>Environment:</em><strong data-gallery-environment></strong><em data-gallery-environment-detail></em></span>
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
        <a class="gallery-original" data-gallery-original target="_blank" rel="noreferrer">Open original image ↗</a>
      </div>
    </div>
  </dialog>
  <script>
    (() => {
      const backToTop = document.querySelector("[data-back-to-top]");
      const update = () => { backToTop.hidden = window.scrollY < window.innerHeight; };
      window.addEventListener("scroll", update, { passive: true });
      window.addEventListener("resize", update);
      backToTop.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        window.scrollTo({ top: 0, behavior: "instant" });
        const hash = document.querySelector('.report-shell').dataset.view === 'case' ? location.hash : '';
        history.replaceState({ ...history.state, reportScroll: 0 }, "", location.pathname + location.search + hash);
        document.querySelector("[data-case-page-heading]:not([hidden]) h1, .report-header h1").focus({ preventScroll: true });
        update();
      });
      update();
    })();
    document.addEventListener("click", (event) => {
      const link = event.target.closest("a[href^='#first-task-']");
      if (!link) return;
      const target = document.getElementById(link.getAttribute("href").slice(1));
      if (!target) return;
      for (let node = target; node; node = node.parentElement) {
        if (node.tagName === "DETAILS") node.open = true;
      }
    });
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
      const original = dialog.querySelector("[data-gallery-original]");
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
        original.href = item.dataset.galleryHref;
        image.alt = item.dataset.galleryLabel + " for " + item.dataset.galleryExecution;
        title.textContent = item.dataset.galleryLabel;
        execution.textContent = item.dataset.galleryExecution;
        profile.textContent = item.dataset.galleryProfile;
        profileDetail.textContent = item.dataset.galleryGeneration + " · " + item.dataset.galleryProvider + " · " + item.dataset.galleryModel;
        environment.textContent = item.dataset.galleryEnvironment;
        environmentDetail.textContent = "Provider: " + item.dataset.galleryEnvironmentProvider + " · Target: " + item.dataset.galleryExecutionTarget;
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
  <script>${reportShellScript}${reportBrowserScript}</script>

</body>
</html>
`;
}
