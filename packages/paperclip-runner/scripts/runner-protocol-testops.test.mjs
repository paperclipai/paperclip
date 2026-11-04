import assert from "node:assert/strict";
import test from "node:test";
import { contract, selectCases, inspectSelection, filterCatalog, projectResults, verifyPublication, standingPlanCases } from "./runner-protocol-testops.mjs";

const context = { runId: "123", workflowSha: "a".repeat(40), sourceSha: "a".repeat(40), evalsSha: "b".repeat(40),
  allureJobRunId: "7", jobId: 9, launchId: 11, accountingMode: "legacy" };
const planned = contract.cases.map(row => ({ id: row.testCaseId, selector: row.fullName }));
const selection = rows => selectCases(rows, context);

function catalog() {
  const roster = { rosterId: contract.rosterId, model: contract.model, provider: contract.provider,
    driver: contract.driver, cases: contract.cases.map(row => row.caseId) };
  return { schema: "paperclip.runner-protocol-eval.catalog/v1", source: { paperclipSha: context.sourceSha, evalsSha: context.evalsSha },
    rosters: [roster], cells: roster.cases.map(caseId => ({ rosterId: roster.rosterId, caseId })), selection: { kind: "subset" } };
}

test("keeps all 41 plan cases and never promotes a targeted subset to full coverage", () => {
  assert.equal(contract.cases.length, 41);
  assert.equal(selection(planned).fullPlan, true);
  const subset = selection(planned.slice(0, 2));
  assert.equal(subset.fullPlan, false);
  const filtered = filterCatalog(catalog(), subset);
  assert.equal(filtered.cells.length, 2);
  assert.equal(filtered.rosters[0].cases.length, 2);
  assert.equal(filtered.selection.fullPlan, false);
  assert.equal(filtered.matrices.flatMap(row => row.include).length, 2);
  assert.equal(filterCatalog(catalog(), selection(planned)).cells.length, 41);
});

test("rejects foreign, duplicate, missing and mismatched selections before provider access", () => {
  for (const rows of [[], [planned[0], planned[0]], [{ ...planned[0], id: 999 }], [{ ...planned[0], selector: planned[1].selector }]]) {
    assert.throws(() => selection(rows), /runner_testops_/);
  }
  const selected = selection(planned);
  for (const mutate of [value => { value.source.paperclipSha = "c".repeat(40); },
    value => { value.rosters[0].model = "different"; }, value => { value.rosters[0].cases.pop(); }]) {
    const value = catalog(); mutate(value);
    assert.throws(() => filterCatalog(value, selected), /runner_testops_/);
  }
  assert.throws(() => filterCatalog(catalog(), { ...selected, schema: "other" }), /selection_identity/);
  assert.throws(() => selectCases(planned, { ...context, accountingMode: "controlled" }), /accounting_mode/);
});

test("binds the selected TestOps job to this exact workflow run and standing plan", async () => {
  const env = { ALLURE_JOB_RUN_ID: "7", RUNNER_TESTOPS_REQUESTED_JOB_RUN_ID: "7", GITHUB_RUN_ID: "123", GITHUB_SHA: context.workflowSha,
    PAPERCLIP_PROTOCOL_EVAL_SOURCE_SHA: context.sourceSha, PAPERCLIP_PROTOCOL_EVALS_SHA: context.evalsSha };
  const run = { id: 7, job: { id: 9, type: "github", url: "https://github.com/paperclipai/paperclip/actions/workflows/runner-protocol-live-evals.yml" },
    url: "https://github.com/paperclipai/paperclip/actions/runs/123", stage: "in_progress", launchId: 11 };
  const job = { ...run.job };
  const values = new Map([["/api/jobrun/7", run], ["/api/job/9", job], ["/api/launch/11", { id: 11, projectId: 1, closed: false }],
    ["/api/testplan/3", { id: 3, projectId: 1, name: contract.planName, testCasesCount: 41 }],
    ["/api/jobrun/7/plan?expected=true", planned.slice(0, 1)]]);
  const api = async route => { assert.ok(values.has(route)); return values.get(route); };
  for (const alias of [run.job.url, `https://github.com/paperclipai/paperclip/actions/workflows/${contract.workflowId}`,
    "https://github.com/paperclipai/paperclip/blob/master/.github/workflows/runner-protocol-live-evals.yml"]) {
    run.job.url = alias; job.url = alias;
    assert.equal((await inspectSelection(api, env)).cases.length, 1);
  }
  run.job.url = "https://github.com/paperclipai/paperclip/actions/workflows/other.yml";
  await assert.rejects(inspectSelection(api, env), /jobrun_binding/);
  run.job.url = "https://github.com/paperclipai/paperclip/actions/workflows/runner-protocol-live-evals.yml";
  job.url = run.job.url;
  delete run.job.url;
  assert.equal((await inspectSelection(api, env)).cases.length, 1);
  const manual = { version: "1.0", tests: planned.map(row => ({ ...row, id: String(row.id) })) };
  const admittedManual = await inspectSelection(api, { ...env, RUNNER_TESTOPS_REQUESTED_JOB_RUN_ID: "" }, manual);
  assert.equal(admittedManual.fullPlan, false);
  assert.equal(admittedManual.cases.length, 1);
  assert.equal(admittedManual.cases[0].testCaseId, 194);
  await assert.rejects(inspectSelection(api, env, manual), /selection_mode/);
  assert.throws(() => standingPlanCases({ ...manual, tests: manual.tests.slice(0, 1) }), /standing_plan_coverage/);
  assert.throws(() => standingPlanCases({ ...manual, version: "other" }), /standing_plan/);
  run.url = "https://github.com/paperclipai/paperclip/actions/runs/122";
  await assert.rejects(inspectSelection(api, env), /jobrun_binding/);
});

test("reports every unexecuted selected case as broken when the report is unavailable", () => {
  const rows = projectResults({ selection: selection(planned) });
  assert.equal(rows.length, 41);
  assert.ok(rows.every(row => row.result.status === "broken" && row.evidence.recorded === false));
  assert.equal(new Set(rows.map(row => row.result.fullName)).size, 41);
});

test("only current-run successful behavioral evidence becomes a pass", () => {
  const selected = selection(planned.slice(0, 1));
  const expected = selected.cases[0];
  const cell = { rosterId: contract.rosterId, caseId: expected.caseId, finalAttemptId: "attempt-1", disposition: "passed", passed: true };
  const campaign = { schema: "paperclip.runner-protocol-eval.campaign/v1", source: { paperclip: { sha: context.sourceSha },
    evals: { sha: context.evalsSha }, workflowRunUrl: "https://github.com/paperclipai/paperclip/actions/runs/123" }, results: [cell] };
  const payload = { attemptId: "attempt-1", caseId: expected.caseId, disposition: "passed", passed: true,
    publication: { schema: "paperclip.runner-protocol-eval.public-chat/v1" },
    checks: Object.entries(expected.checks).map(([id, kind]) => ({ id, kind, passed: true })) };
  const payloads = new Map([["attempt-1", payload]]);
  assert.equal(projectResults({ selection: selected, campaign, payloads })[0].result.status, "passed");
  assert.throws(() => projectResults({ selection: selected, campaign }), /unsupported_pass/);
  payload.checks[0].passed = false;
  assert.throws(() => projectResults({ selection: selected, campaign, payloads }), /unsupported_pass/);
  payload.checks[0].passed = true;
  payload.passed = false;
  assert.throws(() => projectResults({ selection: selected, campaign, payloads }), /payload_binding/);
  payload.passed = true;
  cell.usage = { inputTokens: 10, unexpected: "PRIVATE-SECRET" };
  const projected = projectResults({ selection: selected, campaign, payloads })[0];
  assert.deepEqual(projected.evidence.usage, { inputTokens: 10 });
  assert.ok(!JSON.stringify(projected).includes("PRIVATE-SECRET"));
  payload.checks[0].id = "PRIVATE-SECRET";
  assert.throws(() => projectResults({ selection: selected, campaign, payloads }), /check_binding/);
  payload.checks[0].id = Object.keys(expected.checks)[0];
  cell.usage.inputTokens = "PRIVATE-SECRET";
  assert.throws(() => projectResults({ selection: selected, campaign, payloads }), /usage_schema/);
  cell.usage.inputTokens = 10;
  campaign.source.evals.sha = "c".repeat(40);
  assert.throws(() => projectResults({ selection: selected, campaign, payloads }), /campaign_binding/);
});

test("preserves real behavior failures and infrastructure failures", () => {
  const selected = selection(planned.slice(0, 1));
  for (const [disposition, status] of [["behavior_failure", "failed"], ["infrastructure_failure", "broken"]]) {
    const cell = { rosterId: contract.rosterId, caseId: selected.cases[0].caseId, finalAttemptId: "attempt-1", disposition, passed: false };
    const campaign = { schema: "paperclip.runner-protocol-eval.campaign/v1", source: { paperclip: { sha: context.sourceSha },
      evals: { sha: context.evalsSha }, workflowRunUrl: "https://github.com/paperclipai/paperclip/actions/runs/123" }, results: [cell] };
    const payload = { attemptId: "attempt-1", caseId: cell.caseId, disposition, passed: false,
      publication: { schema: "paperclip.runner-protocol-eval.public-chat/v1" },
      checks: Object.entries(selected.cases[0].checks).map(([id, kind]) => ({ id, kind, passed: false })) };
    assert.equal(projectResults({ selection: selected, campaign, payloads: new Map([["attempt-1", payload]]) })[0].result.status, status);
  }
});

test("waits for ingestion but rejects wrong current-run verdicts and bindings", async () => {
  const selected = selection(planned.slice(0, 1)), expected = selected.cases[0];
  const receipt = { selection: selected, results: [{ testCaseId: expected.testCaseId, fullName: expected.fullName, status: "passed" }] };
  const detail = { id: 33, fullName: expected.fullName, projectId: 1, launchId: selected.launchId,
    jobRun: { id: Number(selected.allureJobRunId) }, status: "passed" };
  let reads = 0;
  const api = async route => route.startsWith("/api/testresult?")
    ? ++reads < 2 ? { totalElements: 0, totalPages: 0, content: [] }
      : { totalElements: 1, totalPages: 1, content: [{ id: 33, testCaseId: expected.testCaseId }] }
    : detail;
  assert.equal((await verifyPublication(api, receipt, { attempts: 2, pause: async () => {} })).verified, 1);
  detail.status = "failed";
  await assert.rejects(verifyPublication(api, receipt), /result_mismatch/);
  detail.status = "passed"; detail.jobRun.id++;
  await assert.rejects(verifyPublication(api, receipt), /result_mismatch/);
  await assert.rejects(verifyPublication(async () => ({ totalElements: 0, totalPages: 0, content: [] }), receipt,
    { attempts: 2, pause: async () => {} }), /result_missing/);
});
