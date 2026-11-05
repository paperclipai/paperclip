import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contract, selectCases, inspectSelection, filterCatalog, projectResults, verifyPublication, standingPlanCases, protocolTestOpsFailure,
  captureManualJobRunContext, parseOfficialJobRunContext, payloadFromSanitizedRun } from "./runner-protocol-testops.mjs";
import { testopsClient } from "../../../tests/runner-e2e/chat-feature-testops-api.mjs";
import { sanitizeProtocolEvalRuns } from "./runner-protocol-eval-campaign.mjs";

const context = { runId: "123", workflowSha: "a".repeat(40), sourceSha: "a".repeat(40), evalsSha: "b".repeat(40),
  allureJobRunId: "7", jobId: 9, launchId: 11, accountingMode: "legacy" };
const planned = contract.cases.map(row => ({ id: row.testCaseId, selector: row.fullName }));
const selection = rows => selectCases(rows, context);

function sanitizedRun() {
  const expected = contract.cases[0];
  const cell = { rosterId: contract.rosterId, caseId: expected.caseId, model: contract.model, provider: contract.provider,
    driver: contract.driver, finalAttemptId: "attempt-1", disposition: "passed", passed: true };
  const score = { schema: "paperclip-runner/eval-score/v1", attemptId: cell.finalAttemptId, caseId: cell.caseId,
    disposition: cell.disposition, passed: true, checks: Object.entries(expected.checks).map(([id, kind]) => ({ id, kind, passed: true })) };
  const artifact = { schema: "paperclip-runner/eval-session-artifact/v1", attemptId: cell.finalAttemptId,
    requestedModel: contract.model, provider: contract.provider, driver: contract.driver,
    publication: { schema: "paperclip.runner-protocol-eval.public-chat/v1" }, privateExtra: "PRIVATE-SECRET" };
  const campaign = { schema: "paperclip.runner-protocol-eval.campaign/v1", source: { paperclip: { sha: context.sourceSha },
    evals: { sha: context.evalsSha }, workflowRunUrl: "https://github.com/paperclipai/paperclip/actions/runs/123" }, results: [cell] };
  return { cell, score, artifact, campaign };
}

test("binds sanitized structured records without reading or forwarding private report content", () => {
  const { cell, score, artifact, campaign } = sanitizedRun();
  const input = { selection: selection(planned.slice(0, 1)), campaign,
    payloads: new Map([[cell.finalAttemptId, payloadFromSanitizedRun(score, artifact, cell)]]) };
  assert.equal(projectResults(input)[0].result.status, "passed");
  assert.ok(!JSON.stringify(input.payloads.get(cell.finalAttemptId)).includes("PRIVATE-SECRET"));
  for (const mutate of [value => { delete value.publication; }, value => { value.requestedModel = "other-model"; },
    value => { value.provider = "other-provider"; }, value => { value.driver = "other-driver"; },
    value => { value.attemptId = "other-attempt"; }, value => { value.schema = "raw-private-record"; }]) {
    const changed = structuredClone(artifact); mutate(changed);
    assert.throws(() => payloadFromSanitizedRun(score, changed, cell), /sanitized_payload_binding/);
  }
  for (const mutate of [value => { value.attemptId = "other-attempt"; }, value => { value.caseId = "other-case"; },
    value => { value.passed = "true"; }, value => { value.schema = "other-score"; }]) {
    const changed = structuredClone(score); mutate(changed);
    assert.throws(() => payloadFromSanitizedRun(changed, artifact, cell), /sanitized_payload_binding/);
  }
  for (const change of [checks => checks.pop(), checks => { checks[0].passed = false; }]) {
    const changed = structuredClone(input); change(changed.payloads.get(cell.finalAttemptId).checks);
    assert.throws(() => projectResults(changed), /unsupported_pass/);
  }
});

test("exports the production sanitizer output as closed TestOps files under a controlled context", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-testops-structured-"));
  try {
    const { cell, score, artifact, campaign } = sanitizedRun();
    const run = join(root, "raw-runs", cell.finalAttemptId);
    await mkdir(run, { recursive: true });
    delete artifact.publication;
    artifact.providerSessionId = "PRIVATE-SECRET";
    for (const [name, data] of [["selection.json", selectCases(planned.slice(0, 1), { ...context, accountingMode: "controlled" })], ["campaign.json", campaign],
      [`raw-runs/${cell.finalAttemptId}/score.json`, score], [`raw-runs/${cell.finalAttemptId}/artifact.json`, artifact],
      [`raw-runs/${cell.finalAttemptId}/case.json`, { id: cell.caseId, checks: score.checks }],
      [`raw-runs/${cell.finalAttemptId}/config.json`, { schema: "paperclip-runner/eval-config/v1", id: "config",
        model: contract.model, provider: contract.provider, driver: contract.driver }]]) {
      await writeFile(join(root, name), JSON.stringify(data));
    }
    const sanitize = () => sanitizeProtocolEvalRuns({ runsRoot: join(root, "raw-runs"), publicRunsRoot: join(root, "runs") });
    await sanitize();
    const execute = output => spawnSync(process.execPath, [fileURLToPath(new URL("./runner-protocol-testops.mjs", import.meta.url)),
      "export-runs", join(root, "selection.json"), join(root, "campaign.json"), join(root, "runs"), join(root, output)], {
      encoding: "utf8", env: { PATH: process.env.PATH, PAPERCLIP_RUNNER_EVAL_CONTROL_MANIFEST: "private-manifest" } });
    const positive = execute("positive");
    assert.equal(positive.status, 0, positive.stderr);
    assert.deepEqual(JSON.parse(positive.stdout), { reported: 1, passed: 1 });
    const files = await readdir(join(root, "positive"));
    assert.equal(files.length, 2);
    const values = await Promise.all(files.map(file => readFile(join(root, "positive", file), "utf8")));
    assert.ok(!values.join("").includes("PRIVATE-SECRET"));
    assert.equal(JSON.parse(values.find(value => JSON.parse(value).status)).status, "passed");
    score.checks[0].passed = false;
    await writeFile(join(run, "score.json"), JSON.stringify(score));
    await sanitize();
    const failed = execute("failed");
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /runner_testops_unsupported_pass/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
  assert.throws(() => selectCases(planned, { ...context, accountingMode: "implicit" }), /accounting_mode/);
  assert.throws(() => projectResults({ selection: { ...selected, private: "PRIVATE-SECRET" } }), /selection_identity/);
});

test("binds the selected TestOps job to this exact workflow run and standing plan", async () => {
  const env = { ALLURE_JOB_RUN_ID: "7", RUNNER_TESTOPS_REQUESTED_JOB_RUN_ID: "7", GITHUB_RUN_ID: "123", GITHUB_SHA: context.workflowSha,
    PAPERCLIP_PROTOCOL_EVAL_SOURCE_SHA: context.sourceSha, PAPERCLIP_PROTOCOL_EVALS_SHA: context.evalsSha,
    PAPERCLIP_PROTOCOL_ACCOUNTING_MODE: "legacy" };
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
  const manualEnv = await captureManualJobRunContext({ ...env, ALLURE_JOB_RUN_ID: "", RUNNER_TESTOPS_REQUESTED_JOB_RUN_ID: "",
    ALLURE_ENDPOINT: "https://paperclip.testops.cloud", ALLURE_PROJECT_ID: "1" },
  async () => ({ stdout: "ALLURE_JOB_RUN_ID=7\nALLURE_LAUNCH_ID=11\n" }));
  const admittedManual = await inspectSelection(api, manualEnv, manual);
  assert.equal(admittedManual.fullPlan, false);
  assert.equal(admittedManual.cases.length, 1);
  assert.equal(admittedManual.cases[0].testCaseId, 194);
  await assert.rejects(inspectSelection(api, { ...manualEnv, RUNNER_TESTOPS_EXPECTED_LAUNCH_ID: "12" }, manual), /jobrun_binding/);
  const controlled = await inspectSelection(api, { ...env, PAPERCLIP_PROTOCOL_ACCOUNTING_MODE: "controlled" });
  assert.equal(controlled.accountingMode, "controlled");
  assert.equal(projectResults({ selection: controlled })[0].evidence.accountingMode, "controlled");
  assert.match(projectResults({ selection: controlled })[0].result.description, /accounting mode: controlled/);
  await assert.rejects(inspectSelection(api, { ...env, PAPERCLIP_PROTOCOL_ACCOUNTING_MODE: undefined }), /accounting_mode/);
  await assert.rejects(inspectSelection(api, env, manual), /selection_mode/);
  assert.throws(() => standingPlanCases({ ...manual, tests: manual.tests.slice(0, 1) }), /standing_plan_coverage/);
  assert.throws(() => standingPlanCases({ ...manual, version: "other" }), /standing_plan/);
  run.url = "https://github.com/paperclipai/paperclip/actions/runs/122";
  await assert.rejects(inspectSelection(api, env), /jobrun_binding/);
});

test("captures only official numeric manual job context without evaluating or exposing its environment", async () => {
  const env = { RUNNER_TESTOPS_REQUESTED_JOB_RUN_ID: "", ALLURE_JOB_RUN_ID: "",
    ALLURE_ENDPOINT: "https://paperclip.testops.cloud", ALLURE_PROJECT_ID: "1" };
  const captured = await captureManualJobRunContext(env, async (command, args, options) => {
    assert.equal(command, "allurectl");
    assert.deepEqual(args, ["job-run", "env"]);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 30_000);
    assert.equal(options.maxBuffer, 16_384);
    return { stdout: "ALLURE_TOKEN=PRIVATE-SECRET\nALLURE_JOB_RUN_ID=2550\r\nALLURE_LAUNCH_ID=2588\n" };
  });
  assert.equal(captured.ALLURE_JOB_RUN_ID, "2550");
  assert.equal(captured.RUNNER_TESTOPS_EXPECTED_LAUNCH_ID, "2588");
  assert.ok(!JSON.stringify(captured).includes("PRIVATE-SECRET"));
  for (const text of ["", "ALLURE_JOB_RUN_ID=7\n", "ALLURE_JOB_RUN_ID=7\nALLURE_LAUNCH_ID=0\n",
    "ALLURE_JOB_RUN_ID=7\nALLURE_LAUNCH_ID=11\nALLURE_JOB_RUN_ID=7\n",
    "ALLURE_JOB_RUN_ID=$(private)\nALLURE_LAUNCH_ID=11\n", "x".repeat(16_385)]) {
    assert.throws(() => parseOfficialJobRunContext(text), /bootstrap_context/);
  }
  await assert.rejects(captureManualJobRunContext({ ...env, ALLURE_JOB_RUN_ID: "9" },
    async () => ({ stdout: "ALLURE_JOB_RUN_ID=7\nALLURE_LAUNCH_ID=11\n" })), /bootstrap_context/);
  await assert.rejects(captureManualJobRunContext({ ...env, RUNNER_TESTOPS_REQUESTED_JOB_RUN_ID: "7" },
    async () => { throw new Error("must not execute"); }), /bootstrap_context/);
  await assert.rejects(captureManualJobRunContext(env, async () => { throw new Error("PRIVATE-SECRET"); }), /bootstrap_context/);
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
  const cell = { rosterId: contract.rosterId, caseId: expected.caseId, model: contract.model, provider: contract.provider,
    driver: contract.driver, finalAttemptId: "attempt-1", disposition: "passed", passed: true };
  const campaign = { schema: "paperclip.runner-protocol-eval.campaign/v1", source: { paperclip: { sha: context.sourceSha },
    evals: { sha: context.evalsSha }, workflowRunUrl: "https://github.com/paperclipai/paperclip/actions/runs/123" }, results: [cell] };
  const payload = { attemptId: "attempt-1", caseId: expected.caseId, disposition: "passed", passed: true,
    publication: { schema: "paperclip.runner-protocol-eval.public-chat/v1" },
    checks: Object.entries(expected.checks).map(([id, kind]) => ({ id, kind, passed: true })) };
  const payloads = new Map([["attempt-1", payload]]);
  assert.equal(projectResults({ selection: selected, campaign, payloads })[0].result.status, "passed");
  cell.model = "other-model";
  assert.throws(() => projectResults({ selection: selected, campaign, payloads }), /campaign_binding/);
  cell.model = contract.model;
  assert.throws(() => projectResults({ selection: selected, campaign }), /unsupported_pass/);
  payload.checks[0].passed = false;
  assert.throws(() => projectResults({ selection: selected, campaign, payloads }), /unsupported_pass/);
  payload.checks[0].passed = true;
  payload.passed = false;
  assert.throws(() => projectResults({ selection: selected, campaign, payloads }), /payload_binding/);
  payload.passed = true;
  cell.usage = { inputTokens: 10, unexpected: "PRIVATE-SECRET" };
  const projected = projectResults({ selection: selected, campaign, payloads })[0];
  assert.equal(projected.evidence.schema, "paperclip.runner-protocol-testops-evidence/v1");
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

test("retains closed API failure codes and status without raw messages or fabricated codes", async () => {
  await assert.rejects(testopsClient("private-token", async () => new Response("private-body", { status: 401 })), error => {
    assert.deepEqual(protocolTestOpsFailure(error), { code: "testops_auth_http", httpStatus: 401 });
    return true;
  });
  assert.deepEqual(protocolTestOpsFailure(new Error("runner_testops_job_binding")), { code: "runner_testops_job_binding", httpStatus: null });
  const unknown = protocolTestOpsFailure(Object.assign(new Error("PRIVATE-SECRET"), { code: "testops_auth_http", status: 401 }));
  assert.deepEqual(unknown, { code: "runner_testops_execution_failed", httpStatus: null });
  assert.ok(!JSON.stringify(unknown).includes("PRIVATE-SECRET"));
});

test("preserves real behavior failures and infrastructure failures", () => {
  const selected = selection(planned.slice(0, 1));
  for (const [disposition, status] of [["behavior_failure", "failed"], ["infrastructure_failure", "broken"]]) {
    const cell = { rosterId: contract.rosterId, caseId: selected.cases[0].caseId, model: contract.model, provider: contract.provider,
      driver: contract.driver, finalAttemptId: "attempt-1", disposition, passed: false };
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
