import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runnerMatrix } from "./catalog.js";
import { validateEvalOperationsManifest, type EvalOperationsManifest } from "./operations.js";
import { evalRequestReservation } from "./eval-gateway.js";
import prices from "./scheduled-prices.json" with { type: "json" };
import { scheduledOperatingOverhead, validateOperatingOverhead, type EvalOperatingOverhead } from "./operating-overhead.js";
import { usdToUnits } from "../../packages/shared/src/money.js";
import { scheduledForecast } from "./scheduled-forecast.js";

export type EvalCadence = "daily" | "weekly";
export const EVAL_SCHEDULES = { daily: "47 8 * * *", weekly: "47 9 * * 0" } as const;
const budget = (cadence: EvalCadence) => cadence === "daily" ? "20" : "100";
const marker = (profile: string) => `core-compatibility.${profile}.local.message-marker`;
const feedback = (profile: string) => `feedback-persistence.${profile}.local.complaint-and-suggestion`;

export function scheduledSelection(cadence: EvalCadence) {
  if (!["daily", "weekly"].includes(cadence)) throw new Error("Unknown eval cadence");
  return [marker("runner-acpx-claude"), feedback("runner-acpx-claude"),
    ...(cadence === "weekly" ? [marker("runner-codex"), feedback("runner-codex")] : [])];
}

export function scheduledCadence(event: string, schedule: string, requested = "manual"): EvalCadence | undefined {
  if (event === "schedule") {
    const found = Object.entries(EVAL_SCHEDULES).find(([, expression]) => expression === schedule);
    if (!found) throw new Error("Unrecognized paid eval schedule");
    return found[0] as EvalCadence;
  }
  if (event !== "workflow_dispatch" || !["manual", "daily", "weekly"].includes(requested)) throw new Error("Unrecognized eval trigger");
  return requested === "manual" ? undefined : requested as EvalCadence;
}

export function validateScheduledBudget(input: { cadence: EvalCadence; now: number; overhead: EvalOperatingOverhead }) {
  if (!Number.isFinite(input.now) || input.now < Date.parse(prices.verifiedAt) || input.now >= Date.parse(prices.expiresAt)) {
    throw new Error("Scheduled eval pricing needs review before paid admission");
  }
  const executionIds = scheduledSelection(input.cadence);
  const executions = executionIds.map(id => {
    const execution = runnerMatrix.find(row => row.id === id);
    if (!execution) throw new Error(`Scheduled execution is absent: ${id}`);
    return execution;
  });
  const models = prices.models.filter(model => executions.some(execution => execution.profile.model === model.price.model)) as EvalOperationsManifest["models"];
  if (executions.some(execution => !models.some(model => model.price.model === execution.profile.model
      && model.provider === (execution.profile.credential === "ANTHROPIC_API_KEY" ? "anthropic" : "openai")))) {
    throw new Error("Missing exact scheduled model pricing");
  }
  const reserved = validateOperatingOverhead(input.overhead, budget(input.cadence));
  if (input.now < Date.parse(input.overhead.verifiedAt) || input.now + 30 * 60_000 >= Date.parse(input.overhead.expiresAt)) {
    throw new Error("Operating overhead allowance does not cover the campaign window");
  }
  if (models.some(model => reserved + usdToUnits(evalRequestReservation({ ...model, apiKey: "forecast", mode: "braintrust" })) > usdToUnits(budget(input.cadence)))) {
    throw new Error("Operating overhead leaves insufficient allowance for the selected model");
  }
  return { executionIds, executions, models };
}

export function scheduledManifest(input: {
  cadence: EvalCadence; campaignId: string; ledgerPath: string; projectId: string; now: number; runAttempt: string;
  overhead: EvalOperatingOverhead;
}): EvalOperationsManifest {
  if (input.runAttempt !== "1") throw new Error("Paid campaign reruns require the retained journal; a fresh allowance is refused");
  const { executionIds, executions, models } = validateScheduledBudget(input);
  const manifest: EvalOperationsManifest = {
    version: 1, limits: { campaignId: input.campaignId, maxUsd: budget(input.cadence), overhead: input.overhead,
      deadlineAt: new Date(input.now + 30 * 60_000).toISOString(), maxRequests: input.cadence === "daily" ? 30 : 60,
      maxConcurrent: 1, maxAttemptsPerExecution: 1 },
    ledgerPath: input.ledgerPath, executionIds, maxAttemptsPerExecution: 1, route: "braintrust", projectId: input.projectId,
    models,
  };
  validateEvalOperationsManifest(manifest, executions, 0);
  return manifest;
}

export function scheduledMatrix(cadence: EvalCadence) {
  return { include: [{ executionId: "scheduled-campaign", suiteId: "core-compatibility", profileId: "runner-acpx-claude",
    credentialName: "", environmentId: "local", caseId: "scheduled-campaign", timeoutMinutes: 60, needsDaytona: false }],
    needsDaytona: false, executionIds: scheduledSelection(cadence) };
}

export async function prepareScheduledCampaign(env: NodeJS.ProcessEnv, now = Date.now()) {
  const cadence = scheduledCadence(env.EVAL_EVENT ?? "", env.EVAL_SCHEDULE ?? "", env.EVAL_CADENCE);
  if (!cadence || env.EVAL_OPERATIONS_ENABLED !== "true") throw new Error("Bounded eval operations are not enabled");
  if (!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") || !env.GITHUB_WORKSPACE) throw new Error("Missing workflow campaign identity");
  const campaignId = `gha-${env.GITHUB_RUN_ID}-1-scheduled-campaign`;
  const directory = path.join(env.GITHUB_WORKSPACE, "tests/runner-e2e/results/scheduled");
  const manifest = scheduledManifest({ cadence, campaignId, ledgerPath: path.join(directory, "ledger.jsonl"),
    projectId: env.PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID ?? "", now, runAttempt: env.GITHUB_RUN_ATTEMPT ?? "",
    overhead: scheduledOperatingOverhead(env.EVAL_OPERATING_OVERHEAD_JSON, env.EVAL_TEST_RUNNER, budget(cadence), now, cadence) });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const forecast = { cadence, executionIds: manifest.executionIds, maxUsd: manifest.limits.maxUsd,
    overhead: manifest.limits.overhead, budgetScope: "model requests plus declared operating overhead reservations",
    measurements: scheduledForecast(runnerMatrix.filter(execution => manifest.executionIds.includes(execution.id)), manifest.models),
    basis: "Retained attempt measurements with per-sample hosts; historical and current-compatible totals remain separate",
    uncertainty: "Sample coverage, definition drift and provider export precision limit the estimate; final invoices and operating reconciliation remain pending",
    maximumRequestReservations: manifest.models.map(model => ({ model: model.price.model,
      usd: evalRequestReservation({ ...model, apiKey: "forecast", mode: "braintrust" }) })),
    maximumMonthlyTotalAllowanceUsd: "1120", pricingExpiresAt: prices.expiresAt };
  await writeFile(path.join(directory, "forecast.json"), `${JSON.stringify(forecast, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { manifest, manifestPath, campaignId, cadence };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command === "matrix") {
    const cadence = scheduledCadence(process.env.EVAL_EVENT ?? "", process.env.EVAL_SCHEDULE ?? "", process.env.EVAL_CADENCE);
    if (!cadence || process.env.EVAL_OPERATIONS_ENABLED !== "true") throw new Error("Bounded eval operations are not enabled");
    const now = Date.now();
    const overhead = scheduledOperatingOverhead(process.env.EVAL_OPERATING_OVERHEAD_JSON, process.env.EVAL_TEST_RUNNER, budget(cadence), now, cadence);
    validateScheduledBudget({ cadence, overhead, now });
    console.log(JSON.stringify({ ...scheduledMatrix(cadence), overhead }));
  } else if (command === "prepare") {
    const prepared = await prepareScheduledCampaign(process.env);
    if (!process.env.GITHUB_ENV) throw new Error("Missing workflow environment file");
    const prior = await readFile(process.env.GITHUB_ENV, "utf8");
    await writeFile(process.env.GITHUB_ENV, `${prior}PAPERCLIP_E2E_OPERATIONS_MANIFEST=${prepared.manifestPath}\nPAPERCLIP_E2E_CAMPAIGN_ID=${prepared.campaignId}\nPAPERCLIP_E2E_ACCOUNTING_CAMPAIGN_ID=${prepared.campaignId}\n`);
  } else throw new Error("Usage: scheduled-operations.ts <matrix|prepare>");
}
