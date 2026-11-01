import type { ReportExecution } from "./report-catalog.js";
import type { RunnerE2ESuiteSummary } from "./types.js";

function html(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function uniqueCases(catalog: readonly ReportExecution[]) {
  const cases = new Map<string, ReportExecution>();
  for (const execution of catalog) {
    const key = `${execution.suite.id}.${execution.task.id}`;
    if (!cases.has(key)) cases.set(key, execution);
  }
  return [...cases.values()];
}

export function renderSuiteCaseIndex(catalog: readonly ReportExecution[]) {
  return `<ul class="suite-case-list">${uniqueCases(catalog).map((execution) => `<li>
    <a href="#execution-${html(execution.id)}" data-report-case-link="${html(`${execution.suite.id}.${execution.task.id}`)}"><span class="case-status-dot" aria-hidden="true"></span><span>${html(execution.task.label)}</span></a>
  </li>`).join("")}</ul>`;
}

export function renderCampaignSuiteSummary(
  suites: readonly RunnerE2ESuiteSummary[],
  catalog: readonly ReportExecution[],
  reportHref = "",
  showCases = false,
) {
  const labels = new Map(catalog.map((execution) => [execution.suite.id, execution.suite.label]));
  const selected = suites.filter((suite) => suite.selected > 0);
  if (selected.length === 0) return "";
  return `<ul class="campaign-suites" aria-label="Suite results">${selected.map((suite) => {
    const passed = suite.passed === suite.selected && suite.cleanupPassed;
    const label = labels.get(suite.suiteId) ?? suite.suiteId;
    const suiteCatalog = catalog.filter((execution) => execution.suite.id === suite.suiteId);
    const caseCount = uniqueCases(suiteCatalog).length;
    const fold = showCases && caseCount > 0;
    const heading = `<span class="campaign-suite-title"><a href="${html(reportHref)}#suite-${html(suite.suiteId)}">${html(label)}</a>${fold ? `<small>${caseCount} ${caseCount === 1 ? "case" : "cases"}</small>` : ""}</span>
      <strong>${suite.passed}/${suite.selected}</strong>
      <span class="campaign-suite-state ${passed ? "campaign-suite-passed" : "campaign-suite-attention"}">${passed ? "Passed" : "Needs attention"}${suite.incomplete ? ` · ${suite.incomplete} incomplete` : ""}</span>`;
    return `<li>${fold ? `<details class="campaign-suite-details">
      <summary class="campaign-suite-row">${heading}</summary>
      <nav class="campaign-case-index" aria-label="${html(label)} cases">${renderSuiteCaseIndex(suiteCatalog)}</nav>
    </details>` : `<div class="campaign-suite-row">${heading}</div>`}
    </li>`;
  }).join("")}</ul>`;
}

export const campaignSuiteSummaryStyles = `
  .campaign-suites { display: grid; margin: 0 0 32px; padding: 0; list-style: none; }
  .campaign-suites > li { border-bottom: 1px solid var(--border); }
  .campaign-suite-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 150px; align-items: baseline; gap: 24px; padding: 12px 0; }
  .campaign-suite-details > summary { grid-template-columns: 16px minmax(0, 1fr) auto 150px; gap: 12px; cursor: pointer; list-style: none; }
  .campaign-suite-details > summary::-webkit-details-marker { display: none; }
  .campaign-suite-details > summary::before { content: "›"; align-self: center; color: var(--muted-foreground, var(--muted)); font-size: 20px; line-height: 1; text-align: center; }
  .campaign-suite-details[open] > summary::before { transform: rotate(90deg); }
  .campaign-suite-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; min-width: 0; }
  .campaign-suite-title small { color: var(--muted-foreground, var(--muted)); font-size: 11px; }
  .campaign-case-index { padding: 0 0 16px 28px; }
  .campaign-suites a { width: fit-content; font-weight: 500; text-decoration: none; }
  .campaign-suites a:hover { text-decoration: underline; }
  .campaign-suites strong { font-family: var(--font-mono, var(--mono)); font-variant-numeric: tabular-nums; font-weight: 600; }
  .campaign-suite-state { font-size: 12px; text-align: right; }
  .campaign-suite-passed { color: var(--pass-text, var(--pass)); }
  .campaign-suite-attention { color: var(--fail-text, var(--fail)); }
  .suite-case-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px 24px; margin: 0; padding: 0; list-style: none; }
  .suite-case-list a { display: inline-flex; align-items: baseline; gap: 8px; padding: 4px 0; color: var(--muted-foreground, var(--muted)); font-size: 12px; font-weight: 400; text-decoration: none; text-underline-offset: 3px; overflow-wrap: anywhere; }
  .suite-case-list a:hover { color: var(--foreground); text-decoration: underline; }
  .case-status-dot { display: inline-block; flex: 0 0 7px; width: 7px; height: 7px; border-radius: 50%; background: var(--muted-foreground, var(--muted)); }
  [data-case-status="passed"] .case-status-dot { background: var(--pass-text, var(--pass)); }
  [data-case-status="failed"] .case-status-dot { background: var(--fail-text, var(--fail)); }
  [data-case-status="incomplete"] .case-status-dot, [data-case-status="missing"] .case-status-dot { background: var(--missing-text); }
  @media (max-width: 980px) {
    .suite-case-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 520px) {
    .campaign-suite-row { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 16px; }
    .campaign-suite-state { grid-column: 1 / -1; text-align: left; }
    .campaign-suite-details > summary { grid-template-columns: 16px minmax(0, 1fr) auto; gap: 4px 12px; }
    .campaign-suite-details .campaign-suite-state { grid-column: 2 / -1; }
    .suite-case-list { grid-template-columns: 1fr; gap: 2px; }
  }
`;
