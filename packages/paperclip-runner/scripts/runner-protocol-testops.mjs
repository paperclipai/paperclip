#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { testopsClient } from "../../../tests/runner-e2e/chat-feature-testops-api.mjs";

export const contract = JSON.parse(await readFile(new URL("./runner-protocol-testops-contract.json", import.meta.url), "utf8"));
const fail = code => { throw new Error(`runner_testops_${code}`); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const workflowUrl = "https://github.com/paperclipai/paperclip/actions/workflows/runner-protocol-live-evals.yml";
const runUrl = runId => `https://github.com/paperclipai/paperclip/actions/runs/${runId}`;

export function standingPlanCases(plan) {
  if (plan?.version !== "1.0" || !Array.isArray(plan.tests)) fail("standing_plan");
  const rows = plan.tests.map(row => ({ id: typeof row.id === "string" && /^[1-9][0-9]*$/.test(row.id) ? Number(row.id) : row.id,
    selector: row.selector }));
  if (rows.length !== contract.cases.length) fail("standing_plan_coverage");
  return rows;
}

export function selectCases(planned, context) {
  if (!positive(Number(context.runId)) || !sha(context.workflowSha) || !sha(context.sourceSha) || !sha(context.evalsSha)
    || !positive(Number(context.allureJobRunId)) || !positive(context.launchId) || !positive(context.jobId)) fail("context");
  if (!Array.isArray(planned) || !planned.length || planned.length > contract.cases.length
    || new Set(planned.map(row => row.id)).size !== planned.length) fail("selection");
  const cases = planned.map(row => {
    const found = contract.cases.find(value => value.testCaseId === row.id && value.fullName === row.selector);
    if (!found) fail("foreign_case");
    return found;
  });
  if (context.accountingMode !== "legacy") fail("accounting_mode");
  return { ...context, schema: "paperclip.runner-protocol-testops-selection/v1",
    projectId: contract.projectId, planId: contract.planId, rosterId: contract.rosterId,
    fullPlan: cases.length === contract.cases.length, cases };
}

function validateSelection(selection) {
  const canonical = selectCases(selection.cases?.map(row => ({ id: row.testCaseId, selector: row.fullName })), selection);
  if (selection.schema !== canonical.schema || selection.projectId !== contract.projectId || selection.planId !== contract.planId
    || selection.rosterId !== contract.rosterId || selection.fullPlan !== canonical.fullPlan
    || JSON.stringify(selection.cases) !== JSON.stringify(canonical.cases)) fail("selection_identity");
  return selection;
}

export async function inspectSelection(api, env, manualPlan) {
  const jobRunId = Number(env.ALLURE_JOB_RUN_ID);
  if (!positive(jobRunId)) fail("jobrun_missing");
  if (manualPlan ? env.RUNNER_TESTOPS_REQUESTED_JOB_RUN_ID !== "" : env.RUNNER_TESTOPS_REQUESTED_JOB_RUN_ID !== String(jobRunId)) fail("selection_mode");
  const run = await api(`/api/jobrun/${jobRunId}`);
  const acceptedUrls = [workflowUrl, `https://github.com/paperclipai/paperclip/actions/workflows/${contract.workflowId}`, "https://github.com/paperclipai/paperclip/blob/master/.github/workflows/runner-protocol-live-evals.yml"];
  if (run.id !== jobRunId || !positive(run.job?.id) || run.job.type !== undefined && run.job.type !== "github"
    || run.job.url !== undefined && !acceptedUrls.includes(run.job.url) || run.url !== runUrl(env.GITHUB_RUN_ID)
    || !["scheduled", "in_progress"].includes(run.stage)) fail("jobrun_binding");
  const [job, launch, plan, planned] = await Promise.all([
    api(`/api/job/${run.job.id}`),
    api(`/api/launch/${run.launchId}`), api(`/api/testplan/${contract.planId}`),
    manualPlan ? standingPlanCases(manualPlan) : api(`/api/jobrun/${jobRunId}/plan?expected=true`),
  ]);
  if (job.id !== run.job.id || job.type !== "github" || !acceptedUrls.includes(job.url)) fail("job_binding");
  if (launch.id !== run.launchId || launch.projectId !== contract.projectId || launch.closed === true
    || plan.id !== contract.planId || plan.projectId !== contract.projectId || plan.name !== contract.planName
    || plan.testCasesCount !== contract.cases.length) fail("plan_binding");
  const selected = selectCases(planned, { runId: env.GITHUB_RUN_ID, workflowSha: env.GITHUB_SHA,
    sourceSha: env.PAPERCLIP_PROTOCOL_EVAL_SOURCE_SHA, evalsSha: env.PAPERCLIP_PROTOCOL_EVALS_SHA,
    allureJobRunId: String(jobRunId), launchId: launch.id, jobId: run.job.id, accountingMode: "legacy" });
  if (!manualPlan) return selected;
  const bootstrap = selected.cases.find(row => row.testCaseId === 194 && row.caseId === "get-task-context");
  if (!bootstrap) fail("bootstrap_case");
  return selectCases([{ id: bootstrap.testCaseId, selector: bootstrap.fullName }], selected);
}

function publicUsage(usage) {
  if (usage === undefined || usage === null) return null;
  if (typeof usage !== "object" || Array.isArray(usage)) fail("usage_schema");
  const result = {};
  for (const key of ["agentTurns", "providerRequests", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens",
    "providerReportedCostNanodollars", "estimatedCostNanodollars"]) {
    if (usage[key] === undefined) continue;
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) fail("usage_schema");
    result[key] = usage[key];
  }
  return result;
}

export function filterCatalog(catalog, selection) {
  validateSelection(selection);
  if (catalog.schema !== "paperclip.runner-protocol-eval.catalog/v1" || catalog.rosters?.length !== 1
    || catalog.source?.paperclipSha !== selection.sourceSha || catalog.source?.evalsSha !== selection.evalsSha) fail("catalog_binding");
  const roster = catalog.rosters[0];
  if (roster.rosterId !== contract.rosterId || roster.model !== contract.model || roster.provider !== contract.provider
    || roster.driver !== contract.driver || roster.cases.length !== contract.cases.length
    || contract.cases.some(row => !roster.cases.includes(row.caseId))) fail("roster_binding");
  const selectedIds = new Set(selection.cases.map(row => row.caseId));
  const cells = catalog.cells.filter(cell => selectedIds.has(cell.caseId));
  if (cells.length !== selectedIds.size || new Set(cells.map(cell => cell.caseId)).size !== cells.length
    || cells.some(cell => cell.rosterId !== contract.rosterId)) fail("catalog_coverage");
  const matrices = [{ include: [] }, { include: [] }];
  cells.forEach((cell, index) => matrices[index % 2].include.push(cell));
  return { ...catalog, rosters: [{ ...roster, cases: roster.cases.filter(id => selectedIds.has(id)) }], cells, matrices,
    selection: { ...catalog.selection, kind: "testops", planId: contract.planId, fullPlan: selection.fullPlan,
      caseIds: [...selectedIds], allureJobRunId: selection.allureJobRunId } };
}

export function projectResults({ selection, campaign, payloads = new Map() }) {
  validateSelection(selection);
  const campaignUrl = runUrl(selection.runId);
  if (campaign && (campaign.schema !== "paperclip.runner-protocol-eval.campaign/v1"
    || campaign.source?.paperclip?.sha !== selection.sourceSha || campaign.source?.evals?.sha !== selection.evalsSha
    || campaign.source?.workflowRunUrl !== campaignUrl || !Array.isArray(campaign.results)
    || new Set(campaign.results.map(row => row.caseId)).size !== campaign.results.length
    || campaign.results.some(row => row.rosterId !== contract.rosterId
      || !selection.cases.some(value => value.caseId === row.caseId)))) fail("campaign_binding");
  return selection.cases.map(expected => {
    const cell = campaign?.results.find(row => row.caseId === expected.caseId);
    const payload = cell ? payloads.get(cell.finalAttemptId) : undefined;
    if (payload && (payload.attemptId !== cell.finalAttemptId || payload.caseId !== expected.caseId
      || payload.publication?.schema !== "paperclip.runner-protocol-eval.public-chat/v1"
      || payload.disposition !== cell.disposition || payload.passed !== cell.passed)) fail("payload_binding");
    const rawChecks = payload?.checks ?? [];
    if (!Array.isArray(rawChecks) || rawChecks.some(check => !check || typeof check.id !== "string"
      || !Object.hasOwn(expected.checks, check.id) || expected.checks[check.id] !== check.kind)
      || new Set(rawChecks.map(check => check.id)).size !== rawChecks.length) fail("check_binding");
    const recorded = cell && payload && rawChecks.length === Object.keys(expected.checks).length;
    if (cell?.passed && (!recorded || cell.disposition !== "passed" || payload.checks.some(check => check.passed !== true))) fail("unsupported_pass");
    const status = cell?.passed ? "passed" : !recorded || cell.disposition === "infrastructure_failure" ? "broken" : "failed";
    const checks = rawChecks.map(check => ({ id: check.id, kind: expected.checks[check.id], passed: check.passed === true }));
    const uuid = randomUUID();
    const evidence = { schema: "paperclip.runner-protocol-testops-evidence/v1", ...selection,
      cases: undefined, caseId: expected.caseId, model: contract.model, provider: contract.provider, driver: contract.driver,
      attemptId: cell?.finalAttemptId ?? null, disposition: cell?.disposition ?? "infrastructure_failure", checks,
      recorded: Boolean(recorded), usage: publicUsage(cell?.usage) };
    return { file: `${uuid}-result.json`, attachment: `${uuid}-attachment.json`, evidence,
      result: { uuid, name: expected.title, fullName: expected.fullName,
        historyId: createHash("sha256").update(`${expected.fullName}:${contract.rosterId}`).digest("hex"),
        testCaseId: expected.fullName, status, stage: "finished",
        description: "Real Runner/provider qualification against the seeded mock control plane. One recorded Claude Sonnet 5 profile; direct provider accounting mode.",
        ...(status !== "passed" ? { statusDetails: { message: !recorded
          ? "Current-run protocol evidence is missing; this selected case is not verified."
          : status === "broken" ? "Protocol infrastructure failed; retained diagnostics remain in the workflow artifact."
          : "The completed protocol attempt did not satisfy its behavioral checks." } } : {}),
        labels: [{ name: "AS_ID", value: String(expected.testCaseId) }, { name: "parentSuite", value: "Runner Protocol" },
          { name: "suite", value: "paperclip-runner" }, { name: "framework", value: "paperclip-runner" }],
        parameters: [{ name: "model", value: contract.model }, { name: "profile", value: contract.rosterId },
          { name: "accountingMode", value: selection.accountingMode }, { name: "source.sha", value: selection.sourceSha },
          { name: "evals.sha", value: selection.evalsSha }],
        links: [{ name: "CI execution", url: campaignUrl, type: "custom" },
          { name: "Tested source", url: `https://github.com/paperclipai/paperclip/commit/${selection.sourceSha}`, type: "custom" }],
        steps: checks.map(check => ({ name: check.id, status: check.passed ? "passed" : "failed", stage: "finished", steps: [], attachments: [] })),
        attachments: [{ name: "Current-run protocol evidence and source binding", source: `${uuid}-attachment.json`, type: "application/json" }],
      } };
  });
}

export async function verifyPublication(api, { selection, results }, { attempts = 15,
  pause = () => new Promise(resolve => setTimeout(resolve, 2000)) } = {}) {
  validateSelection(selection);
  if (!Array.isArray(results) || results.length !== selection.cases.length || new Set(results.map(row => row.testCaseId)).size !== results.length
    || results.some(row => !selection.cases.some(value => value.testCaseId === row.testCaseId && value.fullName === row.fullName)
      || !["passed", "failed", "broken"].includes(row.status))) fail("receipt");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const page = await api(`/api/testresult?${new URLSearchParams({ launchId: String(selection.launchId), page: "0", size: "100" })}`);
    if (!Array.isArray(page?.content) || !Number.isSafeInteger(page.totalPages) || page.totalPages < 0 || page.totalPages > 1
      || page.totalElements !== page.content.length) fail("result_page");
    let pending = false;
    for (const expected of results) {
      const found = page.content.filter(row => row.testCaseId === expected.testCaseId);
      if (!found.length) { pending = true; continue; }
      if (found.length !== 1) fail("result_duplicate");
      const actual = await api(`/api/testresult/${found[0].id}`);
      if (actual.fullName !== expected.fullName || actual.projectId !== contract.projectId || actual.launchId !== selection.launchId
        || actual.jobRun?.id !== Number(selection.allureJobRunId)) fail("result_mismatch");
      if (actual.status === undefined || actual.status === "unknown") { pending = true; continue; }
      if (actual.status !== expected.status) fail("result_mismatch");
    }
    if (!pending) return { verified: results.length, launchId: selection.launchId };
    if (attempt + 1 < attempts) await pause();
  }
  fail("result_missing");
}

async function githubOutputs(values) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}
async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "selection") {
    const selection = await inspectSelection(await testopsClient(process.env.ALLURE_TOKEN), process.env,
      args[1] === undefined ? undefined : await readJson(args[1]));
    await writeFile(args[0], json(selection), { mode: 0o600 });
    await githubOutputs({ allure_job_run_id: selection.allureJobRunId, full_plan: String(selection.fullPlan) });
    console.log(json({ selected: selection.cases.length, fullPlan: selection.fullPlan, launchId: selection.launchId }));
  } else if (command === "filter-catalog") {
    const catalog = filterCatalog(await readJson(args[0]), await readJson(args[1]));
    await writeFile(args[0], json(catalog));
    await githubOutputs({ matrix_0: JSON.stringify(catalog.matrices[0]), matrix_1: JSON.stringify(catalog.matrices[1]),
      matrix_1_present: String(catalog.matrices[1].include.length > 0), selected: catalog.cells.length });
    console.log(json({ selected: catalog.cells.length, fullPlan: catalog.selection.fullPlan }));
  } else if (command === "export") {
    const selection = await readJson(args[0]);
    let campaign;
    try { campaign = await readJson(join(args[1], "campaign.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const payloads = new Map();
    for (const row of campaign?.results ?? []) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(row.finalAttemptId)) fail("attempt_path");
      try {
        const html = await readFile(join(args[1], "attempts", row.finalAttemptId, "index.html"), "utf8");
        const match = /<script type="application\/json" id="paperclip-eval-report">([^<]*)<\/script>/.exec(html);
        if (!match) fail("public_payload_missing");
        payloads.set(row.finalAttemptId, JSON.parse(match[1]));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const rows = projectResults({ selection, campaign, payloads });
    await mkdir(args[2], { recursive: false, mode: 0o700 });
    for (const row of rows) {
      await writeFile(join(args[2], row.file), json(row.result));
      await writeFile(join(args[2], row.attachment), json(row.evidence));
    }
    await writeFile(`${args[2]}-receipt.json`, json({ selection, results: rows.map(row => ({
      testCaseId: Number(row.result.labels[0].value), fullName: row.result.fullName, status: row.result.status })) }));
    console.log(json({ reported: rows.length, passed: rows.filter(row => row.result.status === "passed").length }));
  } else if (command === "verify") {
    const receipt = await readJson(args[0]);
    const api = await testopsClient(process.env.ALLURE_TOKEN);
    console.log(json(await verifyPublication(api, receipt)));
    if (receipt.results.some(row => row.status !== "passed")) process.exitCode = 1;
  } else fail("command");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(/^runner_testops_[a-z_]+$/.test(error.message) ? error.message : "runner_testops_execution_failed"); process.exitCode = 1; });
}
