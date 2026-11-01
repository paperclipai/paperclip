import { html } from "./report-format.js";

const outcomes = { passed: "Recorded pass", failed: "Recorded fail", unmeasured: "No main measurement" } as const;
const allowances = { "unused-initial": "Initial unused", "final-available": "Final available", exhausted: "Final consumed", unknown: "Allowance unknown" } as const;
const executionRecords = { "main-measured": "Main measurement recorded", "candidate-measured": "Candidate measured · outcome not projected", "candidate-failed": "Candidate run: FAIL", "candidate-passed": "Candidate run: PASS", "never-run": "Never run", unknown: "Execution evidence unknown" } as const;
const candidateOutcomes = { passed: "Latest candidate run: PASS", failed: "Latest candidate run: FAIL", "not-projected": "Latest candidate outcome not projected" } as const;
const readiness = { "not-assessed": "Not assessed here", "reviewed-candidate": "Candidate source reviewed", "needs-preparation": "Preparation needed" } as const;

export interface CatalogOverviewRow {
  scenarioId: string;
  mainOutcome: keyof typeof outcomes;
  allowance: keyof typeof allowances;
  sourceReadiness: keyof typeof readiness;
  executionRecord: keyof typeof executionRecords;
  latestCandidateOutcome?: keyof typeof candidateOutcomes;
}

export interface CatalogOverview {
  schema: "paperclip.catalog-overview/v2";
  asOf: string;
  definitions: { lazy: number; legacy: number; featureAreas: number; capabilities: number; declaredGaps: number };
  accounting: { mainMeasurements: number; retainedRawResults: number; closedSlots: number; exhaustedFinals: number; theoreticalMainCeiling: number };
  rows: CatalogOverviewRow[];
}

function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid catalog overview object");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(row, key))) throw new Error("Unexpected catalog overview fields");
  return row;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid catalog overview count");
  return value as number;
}
function choice<T extends object>(value: unknown, choices: T): keyof T {
  if (typeof value !== "string" || !Object.hasOwn(choices, value)) throw new Error("Invalid catalog overview state");
  return value as keyof T;
}

export function parseCatalogOverview(value: unknown): CatalogOverview {
  const input = object(value, ["schema", "asOf", "definitions", "accounting", "rows"]);
  if (input.schema !== "paperclip.catalog-overview/v2" || typeof input.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(input.asOf) || !Number.isFinite(Date.parse(input.asOf))) throw new Error("Invalid catalog overview snapshot");
  const d = object(input.definitions, ["lazy", "legacy", "featureAreas", "capabilities", "declaredGaps"]);
  const definitions = { lazy: integer(d.lazy), legacy: integer(d.legacy), featureAreas: integer(d.featureAreas), capabilities: integer(d.capabilities), declaredGaps: integer(d.declaredGaps) };
  if (definitions.lazy !== 242 || definitions.legacy !== 2 || definitions.featureAreas !== 35 || definitions.capabilities !== 191) throw new Error("Frozen catalog scope changed");
  const a = object(input.accounting, ["mainMeasurements", "retainedRawResults", "closedSlots", "exhaustedFinals", "theoreticalMainCeiling"]);
  const accounting = { mainMeasurements: integer(a.mainMeasurements), retainedRawResults: integer(a.retainedRawResults), closedSlots: integer(a.closedSlots), exhaustedFinals: integer(a.exhaustedFinals), theoreticalMainCeiling: integer(a.theoreticalMainCeiling) };
  if (!Array.isArray(input.rows) || input.rows.length !== 244) throw new Error("Expected 244 catalog metadata rows");
  const rows = input.rows.map(value => {
    const row = object(value, ["scenarioId", "mainOutcome", "allowance", "sourceReadiness", "executionRecord"], ["latestCandidateOutcome"]);
    if (typeof row.scenarioId !== "string" || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(row.scenarioId)) throw new Error("Invalid public catalog ID");
    return { scenarioId: row.scenarioId, mainOutcome: choice(row.mainOutcome, outcomes), allowance: choice(row.allowance, allowances), sourceReadiness: choice(row.sourceReadiness, readiness), executionRecord: choice(row.executionRecord, executionRecords),
      ...(Object.hasOwn(row, "latestCandidateOutcome") ? { latestCandidateOutcome: choice(row.latestCandidateOutcome, candidateOutcomes) } : {}) };
  });
  if (new Set(rows.map(row => row.scenarioId)).size !== 244 || new Set(rows.map(row => row.scenarioId.split(".")[0])).size !== 35) throw new Error("Duplicate or incomplete catalog metadata");
  for (const row of rows) {
    if ((row.mainOutcome !== "unmeasured") !== (row.executionRecord === "main-measured") || (row.allowance === "unused-initial") !== (row.executionRecord === "never-run")
      || (row.latestCandidateOutcome !== undefined && ["never-run", "unknown"].includes(row.executionRecord))) throw new Error("Inconsistent recorded execution scope");
  }
  const measured = rows.filter(row => row.mainOutcome !== "unmeasured").length;
  const knownExhausted = rows.filter(row => row.allowance === "exhausted").length;
  if (accounting.mainMeasurements < measured || accounting.retainedRawResults < accounting.mainMeasurements || accounting.closedSlots < accounting.retainedRawResults || accounting.exhaustedFinals < knownExhausted
    || accounting.exhaustedFinals > knownExhausted + rows.filter(row => row.allowance === "unknown").length || accounting.theoreticalMainCeiling > 244) throw new Error("Inconsistent catalog accounting");
  return { schema: "paperclip.catalog-overview/v2", asOf: input.asOf, definitions, accounting, rows };
}

function label(value: string) {
  const text = value.replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function nextAction(row: CatalogOverviewRow) {
  if (row.allowance === "unknown") return "Recover ordinal evidence; keep allowance unknown";
  if (row.mainOutcome === "passed") return "Retain the recorded outcome and its scope";
  if (row.allowance === "exhausted") return "Review the retained outcome; no further attempt";
  if (row.sourceReadiness === "needs-preparation") return "Prepare source, then review execution gates";
  return row.allowance === "unused-initial" ? "Review source and execution gates for the initial" : "Review the initial cause and final execution gates";
}
function executionLabel(row: CatalogOverviewRow) {
  return executionRecords[row.executionRecord] + (row.latestCandidateOutcome ? ` · ${candidateOutcomes[row.latestCandidateOutcome]}` : "");
}
const exampleIds = ["projects.create-project", "projects.archive-project", "tasks.edit-properties", "tasks.comment-with-reference", "documents-artifacts.write-plan", "documents-artifacts.produce-download", "inbox-search.restore-archive"];

export interface CatalogScenarioDescription { query: string; expectedOutcome: string }

export function renderCatalogOverview(value: unknown, descriptions: ReadonlyMap<string, CatalogScenarioDescription> = new Map()) {
  const data = parseCatalogOverview(value);
  const count = (state: CatalogOverviewRow["mainOutcome"]) => data.rows.filter(row => row.mainOutcome === state).length;
  const features = [...new Set(data.rows.map(row => row.scenarioId.split(".")[0]!))].sort();
  const ceilingComparison = data.accounting.theoreticalMainCeiling < 196 ? "below" : data.accounting.theoreticalMainCeiling === 196 ? "equal to" : "above";
  const examples = exampleIds.filter(id => data.rows.some(row => row.scenarioId === id && row.mainOutcome === "passed"));
  return `<section data-catalog-overview>
    <header class="report-header"><div><p class="eyebrow">Chat feature catalog · private preview</p><h1 tabindex="-1">All 244 scenarios</h1><p class="lede">Recorded outcomes, remaining allowances and source readiness, shown separately.</p><p class="detail">Snapshot ${html(data.asOf)}</p></div></header>
    <div class="summary" aria-label="Catalog measurement summary"><div class="metric"><strong>${count("passed")}</strong><span>Recorded feature-work passes</span></div><div class="metric"><strong>${count("failed")}</strong><span>Latest main failures</span></div><div class="metric"><strong>${count("unmeasured")}</strong><span>Without a main measurement</span></div></div>
    <p class="detail">${count("passed") + count("failed")} main cases · ${data.accounting.mainMeasurements} main measurements. The ${count("unmeasured")} without a main measurement include ${data.rows.filter(row => row.allowance === "unused-initial").length} unused initials; these are different sets.</p>
    <p class="detail" data-execution-scope>${data.rows.filter(row => row.executionRecord.startsWith("candidate-") || row.latestCandidateOutcome !== undefined).length} cases measured outside main · ${data.rows.filter(row => row.executionRecord === "never-run").length} never run · ${data.rows.filter(row => row.executionRecord === "unknown").length} with unknown execution evidence. A missing main measurement is not a claim that the case never ran. Candidate PASS and FAIL stay outside the main qualification total.</p>
    <aside class="catalog-scope" aria-label="Qualification scope"><strong>What these outcomes establish</strong><p>The recorded passes support their original feature-work checks. Fully native auxiliary setup and complete usage qualification are not established. Unknown usage and cost are unknown, never zero. Candidate outcomes do not add ordinary main credit.</p><p>${data.definitions.lazy} lazy definitions plus ${data.definitions.legacy} implemented legacy definitions cover 35 feature areas and 191 capabilities. The ${data.definitions.declaredGaps} declared source gaps describe coverage scope, not live results. Source readiness is a partial source review inventory; it does not change a recorded grade or grant execution approval.</p></aside>
    ${examples.length ? `<section aria-label="Recorded passing examples"><h2>Passing feature examples</h2><p class="evidence-links">${examples.map(id => `<a href="#catalog-${html(id)}">${html(label(id.split(".")[1]!))}</a>`).join(" · ")}</p></section>` : ""}
    <details class="campaign-billing-details"><summary>Attempt accounting and limits</summary><p>${data.accounting.retainedRawResults} retained results · ${data.accounting.closedSlots} closed ordinal slots · ${data.accounting.exhaustedFinals} exhausted finals · ${data.rows.filter(row => row.allowance === "unknown").length} unknown allowance.</p><p>The theoretical eligible main ceiling is ${data.accounting.theoreticalMainCeiling}/244, ${ceilingComparison} the 196-case target. This is an upper bound, not a forecast or an execution approval.</p></details>
    <section class="catalog-filters report-filters" aria-label="Filter catalog metadata"><label class="report-search"><span>Search scenarios</span><input type="search" data-catalog-query placeholder="Scenario or feature area"></label><label><span>Feature area</span><select data-catalog-feature><option value="">All feature areas</option>${features.map(feature => `<option value="${html(feature)}">${html(label(feature))}</option>`).join("")}</select></label><label><span>Main outcome</span><select data-catalog-outcome><option value="">All outcomes</option>${Object.entries(outcomes).map(([key, text]) => `<option value="${key}">${text}</option>`).join("")}</select></label><label><span>Allowance</span><select data-catalog-allowance><option value="">All allowances</option>${Object.entries(allowances).map(([key, text]) => `<option value="${key}">${text}</option>`).join("")}</select></label><button class="filter-reset" type="button" data-catalog-reset>Reset filters</button><p data-catalog-count aria-live="polite">244 scenarios</p></section>
    <div class="table-wrap"><table class="catalog-table"><thead><tr><th scope="col">Scenario</th><th scope="col">Main outcome</th><th scope="col">Recorded execution</th><th scope="col">Allowance</th><th scope="col">Source readiness</th><th scope="col">Next action</th></tr></thead><tbody>${[...data.rows].sort((a,b) => a.scenarioId.localeCompare(b.scenarioId)).map(row => `<tr id="catalog-${html(row.scenarioId)}" data-catalog-row data-feature="${html(row.scenarioId.split(".")[0])}" data-outcome="${row.mainOutcome}" data-allowance="${row.allowance}"><th scope="row"><strong>${html(label(row.scenarioId.split(".")[1]!))}</strong><small>${html(label(row.scenarioId.split(".")[0]!))}</small><code>${html(row.scenarioId)}</code>${descriptions.has(row.scenarioId) ? `<details><summary>What this test asks</summary><p><strong>Human request:</strong> ${html(descriptions.get(row.scenarioId)!.query)}</p><p><strong>Expected outcome:</strong> ${html(descriptions.get(row.scenarioId)!.expectedOutcome)}</p></details>` : ""}</th><td>${outcomes[row.mainOutcome]}</td><td>${executionLabel(row)}</td><td>${allowances[row.allowance]}</td><td>${readiness[row.sourceReadiness]}</td><td>${html(nextAction(row))}</td></tr>`).join("")}</tbody></table></div>
    <footer>Metadata overview only · No result cards or evidence files are synthesized</footer>
  </section>`;
}

export const catalogOverviewStyles = `
body[data-catalog-metadata] .report-global-nav a[data-nav-view="attention"],
body[data-catalog-metadata] .report-global-nav a[href$="?view=history"],
body[data-catalog-metadata] .report-breadcrumbs { display:none; }
.catalog-scope { border:1px solid var(--border); border-radius:var(--radius); background:var(--raised); padding:20px; margin:24px 0; }
.catalog-scope p { margin-bottom:0; }
.catalog-table { width:100%; border-collapse:collapse; text-align:left; }
.catalog-table th, .catalog-table td { padding:14px; border-bottom:1px solid var(--border); vertical-align:top; }
.catalog-table thead { background:var(--raised); }
.catalog-table tbody th { min-width:220px; font-weight:400; }
.catalog-table small, .catalog-table code { display:block; color:var(--muted-foreground); margin-top:5px; }
.catalog-table code { font-size:11px; }
.catalog-table tr:target { background:var(--report-filter-tint); }
`;
export const catalogOverviewScript = String.raw`
(() => {
  const root = document.querySelector('[data-catalog-overview]');
  if (!root) return;
  const rows = [...root.querySelectorAll('[data-catalog-row]')];
  const controls = ['query','feature','outcome','allowance'].map(name => root.querySelector('[data-catalog-' + name + ']'));
  const [query, feature, outcome, allowance] = controls;
  const apply = () => {
    let count = 0;
    const search = query.value.trim().toLowerCase();
    for (const row of rows) {
      row.hidden = Boolean((search && !row.textContent.toLowerCase().includes(search)) || (feature.value && row.dataset.feature !== feature.value) || (outcome.value && row.dataset.outcome !== outcome.value) || (allowance.value && row.dataset.allowance !== allowance.value));
      if (!row.hidden) count++;
    }
    root.querySelector('[data-catalog-count]').textContent = count + ' of ' + rows.length + ' scenarios';
  };
  controls.forEach(control => control.addEventListener('input', apply));
  root.querySelector('[data-catalog-reset]').addEventListener('click', () => { controls.forEach(control => { control.value = ''; }); apply(); });
  root.querySelectorAll('a[href^="#catalog-"]').forEach(link => link.addEventListener('click', () => { controls.forEach(control => { control.value = ''; }); apply(); }));
  apply();
})();
`;
