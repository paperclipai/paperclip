import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareScheduledCampaign, scheduledCadence, scheduledManifest, scheduledMatrix, scheduledSelection, validateScheduledBudget } from "./scheduled-operations.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { runnerMatrix } from "./catalog.js";
import { evalRequestReservation } from "./eval-gateway.js";
import { EVAL_OVERHEAD_COMPONENTS, type EvalOperatingOverhead } from "./operating-overhead.js";

const overhead: EvalOperatingOverhead = { version: 1, reference: "fixture-only", runner: "github-hosted",
  verifiedAt: "2026-10-20T00:00:00Z", expiresAt: "2026-11-19T00:00:00Z",
  components: EVAL_OVERHEAD_COMPONENTS.map(component => ({ component, maxUsd: "1", reference: `fixture-${component}` })) };

const input = { cadence: "daily" as const, campaignId: "scheduled-fixture", ledgerPath: "/tmp/scheduled-fixture/ledger.jsonl",
  projectId: "11111111-1111-4111-8111-111111111111", now: Date.parse("2026-10-21T00:00:00Z"), runAttempt: "1", overhead };

it.each(["daily", "weekly"] as const)("runs the exact %s selection through one shared budget and catalog job", cadence => {
  const manifest = scheduledManifest({ ...input, cadence });
  const selected = selectRunnerExecutions(parseRunnerSelectors(manifest.executionIds.flatMap(id => ["--id", id])), runnerMatrix);
  expect(selected.map(row => row.id).sort()).toEqual([...scheduledSelection(cadence)].sort());
  expect(manifest.limits).toMatchObject({ maxUsd: cadence === "daily" ? "20" : "100", maxRequests: cadence === "daily" ? 30 : 60, maxConcurrent: 1, maxAttemptsPerExecution: 1 });
  expect(Date.parse(manifest.limits.deadlineAt) - input.now).toBe(30 * 60_000);
  expect(scheduledMatrix(cadence).include).toHaveLength(1);
  expect(manifest.executionIds).toHaveLength(cadence === "daily" ? 2 : 4);
  expect(manifest.models.every(model => Number(evalRequestReservation({ ...model, mode: "braintrust", apiKey: "fixture" })) <= Number(manifest.limits.maxUsd))).toBe(true);
});

it("does not reduce Codex's verified context ceiling to fit the daily allowance", () => {
  const codex = scheduledManifest({ ...input, cadence: "weekly" }).models.find(row => row.provider === "openai")!;
  expect(codex.maximumInputTokens).toBe(1_050_000);
  expect(Number(evalRequestReservation({ ...codex, mode: "braintrust", apiKey: "fixture" }))).toBeGreaterThan(20);
  expect(scheduledManifest(input).models.map(model => model.provider)).toEqual(["anthropic"]);
});

it.each(["2", "0", "", "01"])("refuses workflow attempt %s before creating a fresh allowance", runAttempt => {
  expect(() => scheduledManifest({ ...input, runAttempt })).toThrow("fresh allowance");
});

it.each(["2026-10-19T23:59:59Z", "2026-11-19T00:00:00Z"])("rejects pricing outside its reviewed window at %s", time => {
  expect(() => scheduledManifest({ ...input, now: Date.parse(time) })).toThrow("pricing needs review");
});

it("rejects unknown triggers and maps the reviewed schedule expressions", () => {
  expect(scheduledCadence("schedule", "47 8 * * *")).toBe("daily");
  expect(scheduledCadence("schedule", "47 9 * * 0")).toBe("weekly");
  expect(scheduledCadence("workflow_dispatch", "", "manual")).toBeUndefined();
  expect(() => scheduledCadence("schedule", "* * * * *")).toThrow();
  expect(() => scheduledCadence("pull_request", "", "daily")).toThrow();
});

it("fails closed before paid work if disabled, missing project identity, or preflight is repeated", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-schedule-"));
  const env = { EVAL_EVENT: "schedule", EVAL_SCHEDULE: "47 8 * * *", EVAL_OPERATIONS_ENABLED: "true",
    GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKSPACE: directory,
    EVAL_OPERATING_OVERHEAD_JSON: JSON.stringify(overhead), EVAL_TEST_RUNNER: "ubuntu-latest",
    PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID: input.projectId };
  try {
    await expect(prepareScheduledCampaign({ ...env, EVAL_OPERATIONS_ENABLED: "false" }, input.now)).rejects.toThrow("not enabled");
    await expect(prepareScheduledCampaign({ ...env, EVAL_OPERATING_OVERHEAD_JSON: "" }, input.now)).rejects.toThrow("Missing reviewed");
    await expect(prepareScheduledCampaign({ ...env, PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID: "" }, input.now)).rejects.toThrow("UUID");
    const prepared = await prepareScheduledCampaign(env, input.now);
    expect(prepared.manifest.limits.campaignId).toBe(prepared.campaignId);
    const forecast = JSON.parse(await readFile(path.join(path.dirname(prepared.manifestPath), "forecast.json"), "utf8"));
    expect(forecast.measurements.historicalSuccessfulSelection).toEqual({ modelUsd: "0.427624800", summedAttemptMs: 72757 });
    expect(forecast.measurements.hostedAttemptMs).toBeNull();
    expect(forecast.maxUsd).toBe("20");
    await expect(prepareScheduledCampaign(env, input.now)).rejects.toThrow("EEXIST");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("rejects an overhead allowance that cannot leave room for a full selected request before emitting the matrix", () => {
  const expensive = structuredClone(overhead);
  expensive.components[0]!.maxUsd = "13";
  expect(() => validateScheduledBudget({ ...input, overhead: expensive })).toThrow("insufficient allowance");
  expect(validateScheduledBudget({ ...input, overhead })).toMatchObject({ executionIds: scheduledSelection("daily") });
});


it.each(["daily", "weekly"] as const)("prepares %s with its own reviewed operating allowance", async cadence => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-cadence-overhead-"));
  const allowance = (value: string): EvalOperatingOverhead => ({ ...overhead, reference: `fixture-${value}`,
    components: overhead.components.map(component => ({ ...component,
      maxUsd: component.component === "observability" ? value : component.component === "artifact_storage" ? "1" : "0" })) });
  const allowances = { daily: allowance("10"), weekly: allowance("20") };
  const env = { EVAL_EVENT: "workflow_dispatch", EVAL_CADENCE: cadence, EVAL_OPERATIONS_ENABLED: "true",
    GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKSPACE: directory,
    EVAL_OPERATING_OVERHEAD_JSON: JSON.stringify(allowances), EVAL_TEST_RUNNER: "ubuntu-latest",
    PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID: input.projectId };
  try {
    await expect(prepareScheduledCampaign({ ...env,
      EVAL_OPERATING_OVERHEAD_JSON: JSON.stringify({ ...allowances, [cadence]: undefined }) }, input.now)).rejects.toThrow();
    await expect(prepareScheduledCampaign({ ...env,
      EVAL_OPERATING_OVERHEAD_JSON: JSON.stringify({ ...allowances, typo: allowances.daily }) }, input.now)).rejects.toThrow();
    const prepared = await prepareScheduledCampaign(env, input.now);
    expect(prepared.manifest.limits.overhead).toEqual(allowances[cadence]);
    expect(prepared.manifest.limits.maxUsd).toBe(cadence === "daily" ? "20" : "100");
    expect(prepared.manifest.executionIds).toEqual(scheduledSelection(cadence));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
