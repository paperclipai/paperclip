import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createEvalAttemptPhase, readEvalAttemptPhase } from "./attempt-phase.js";
import { EvalSpendState, openEvalCostLedger, type EvalSpendLimits } from "./cost-ledger.js";
import { evalRequestReservation, startEvalGateway, type EvalGatewayRoute, type EvalGatewayReceipt } from "./eval-gateway.js";
import { startEvalRemoteGateway } from "./eval-remote-gateway.js";
import type { MatrixExecution } from "./types.js";
import { evalBraintrustConfig } from "./braintrust.js";
import { startEvalOtlpRelay } from "./eval-otlp-relay.js";
import { usdToUnits } from "../../packages/shared/src/money.js";

export interface EvalOperationsManifest {
  version: 1;
  limits: EvalSpendLimits;
  ledgerPath: string;
  executionIds: string[];
  maxAttemptsPerExecution: number;
  route: "direct" | "braintrust";
  projectId?: string;
  remoteGateway?: "cloudflare";
  models: Array<Omit<EvalGatewayRoute, "apiKey" | "projectId" | "endpointName" | "mode">>;
}
const fields = (value: object, names: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(name => !names.includes(name))) throw new Error("Invalid eval operations manifest fields");
};
export function validateEvalOperationsManifest(value: EvalOperationsManifest, executions: readonly MatrixExecution[], maxRetries: number) {
  fields(value, ["version", "limits", "ledgerPath", "executionIds", "maxAttemptsPerExecution", "route", "projectId", "remoteGateway", "models"]);
  if (value.remoteGateway !== undefined && value.remoteGateway !== "cloudflare") throw new Error("Invalid remote eval gateway policy");
  const initial = new EvalSpendState(value.limits).snapshot();
  const initialModelAllowance = usdToUnits(value.limits.maxUsd) - usdToUnits(initial.committedUsd);
  if (value.version !== 1 || !["direct", "braintrust"].includes(value.route) || !path.isAbsolute(value.ledgerPath)
      || !Array.isArray(value.executionIds) || new Set(value.executionIds).size !== value.executionIds.length
      || JSON.stringify([...value.executionIds].sort()) !== JSON.stringify(executions.map(e => e.id).sort())
      || !Number.isSafeInteger(value.maxAttemptsPerExecution) || value.maxAttemptsPerExecution < 1
      || value.limits.maxAttemptsPerExecution !== undefined && value.limits.maxAttemptsPerExecution !== value.maxAttemptsPerExecution
      || maxRetries + 1 > value.maxAttemptsPerExecution || !Array.isArray(value.models) || value.models.length === 0) throw new Error("Eval operations selection or limits mismatch");
  if (value.route === "braintrust" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.projectId ?? "")) throw new Error("Braintrust gateway requires an explicit project UUID");
  const models = new Map<string, bigint>();
  for (const model of value.models) {
    fields(model, ["provider", "price", "maximumInputTokens", "maximumOutputTokens", "timeoutMs", "provisionalBound"]);
    const rateFields = ["inputUsdPerMillion", "cachedReadUsdPerMillion", "outputUsdPerMillion", "cacheWrite5mUsdPerMillion", "cacheWrite1hUsdPerMillion", "cacheWrite30mUsdPerMillion", "cacheWrite12hUsdPerMillion"];
    fields(model.price, ["provider", "model", "responseModels", "version", "sourceUrl", "longContext", ...rateFields]);
    if (model.price.longContext) { fields(model.price.longContext, ["aboveInputTokens", "rates"]); fields(model.price.longContext.rates, rateFields); }
    const url = new URL(model.price.sourceUrl);
    if (!["openai", "anthropic"].includes(model.provider) || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid model price provenance");
    const key = `${model.provider}:${model.price.model}`;
    if (models.has(key)) throw new Error("Duplicate eval model price");
    models.set(key, usdToUnits(evalRequestReservation({ ...model, mode: value.route, apiKey: "validation" })));
  }
  for (const execution of executions) {
    if (!(execution.environment.id === "local" || execution.environment.id === "daytona" && value.remoteGateway === "cloudflare"
          && ["runner-codex", "runner-acpx-claude"].includes(execution.profile.id)) || !["core-compatibility", "feedback-persistence"].includes(execution.suite.id)
        || !["runner-codex", "runner-acpx-claude", "legacy-codex", "legacy-claude"].includes(execution.profile.id)
        || execution.requiredCredentials.length !== (execution.environment.id === "daytona" ? 2 : 1)
        || execution.requiredCredentials.filter(name => name !== "DAYTONA_API_KEY").length !== 1) throw new Error(`Unqualified budgeted eval route: ${execution.id}`);
    const provider = execution.profile.credential === "ANTHROPIC_API_KEY" ? "anthropic" : "openai";
    if (!models.has(`${provider}:${execution.profile.model}`)) throw new Error(`Missing exact model pricing: ${execution.id}`);
    if (models.get(`${provider}:${execution.profile.model}`)! > initialModelAllowance) {
      throw new Error(`Insufficient initial model allowance for selected eval: ${execution.id}`);
    }
  }
  return value;
}

export async function openEvalOperations(file: string, executions: readonly MatrixExecution[], maxRetries: number, env: NodeJS.ProcessEnv) {
  const manifest = validateEvalOperationsManifest(JSON.parse(await readFile(file, "utf8")), executions, maxRetries);
  if (Date.now() >= Date.parse(manifest.limits.deadlineAt)) throw new Error("Eval campaign deadline reached");
  if (manifest.limits.overhead && (Date.now() < Date.parse(manifest.limits.overhead.verifiedAt)
      || Date.parse(manifest.limits.deadlineAt) >= Date.parse(manifest.limits.overhead.expiresAt))) {
    throw new Error("Operating overhead allowance does not cover the campaign window");
  }
  const required = [...(manifest.route === "braintrust" ? ["BRAINTRUST_API_KEY"] : executions.map(execution => execution.profile.credential)),
    ...(executions.some(execution => execution.environment.id === "daytona") ? ["DAYTONA_API_KEY"] : [])];
  if (required.some(name => !env[name]?.trim())) throw new Error("Missing eval gateway upstream credential");
  const observability = evalBraintrustConfig({ ...env, PAPERCLIP_E2E_OTLP_RELAY_URL: undefined });
  if (observability && manifest.route === "braintrust" && observability.projectId !== manifest.projectId) throw new Error("Eval gateway and OTLP projects differ");
  const receiptDirectory = `${manifest.ledgerPath}.requests`;
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  const phaseDirectory = `${manifest.ledgerPath}.attempts`;
  await mkdir(phaseDirectory, { recursive: true, mode: 0o700 });
  const ledger = await openEvalCostLedger(manifest.ledgerPath, { ...manifest.limits, maxAttemptsPerExecution: manifest.maxAttemptsPerExecution });
  const active = new Set<{ close(): Promise<void> }>();
  const atomicJson = async (file: string, value: unknown) => {
    await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  return {
    manifest,
    async start(execution: MatrixExecution, attemptId: string, attempt: number) {
      if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > manifest.maxAttemptsPerExecution || Date.now() >= Date.parse(manifest.limits.deadlineAt)) throw new Error("Eval operations attempt/deadline limit reached");
      if (!manifest.executionIds.includes(execution.id)) throw new Error("Eval operation is outside the admitted selection");
      const provider = execution.profile.credential === "ANTHROPIC_API_KEY" ? "anthropic" : "openai";
      const model = manifest.models.find(m => m.provider === provider && m.price.model === execution.profile.model)!;
      const route: EvalGatewayRoute = { ...model, mode: manifest.route, projectId: manifest.projectId,
        endpointName: provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
        apiKey: env[manifest.route === "braintrust" ? "BRAINTRUST_API_KEY" : execution.profile.credential] ?? "" };
      if (!route.apiKey) throw new Error("Missing eval gateway upstream credential");
      await ledger.admitAttempt(execution.id, attemptId);
      const identity = { executionId: execution.id, attemptId, phase: "setup" as const };
      const phasePath = path.join(phaseDirectory, `${createHash("sha256").update(attemptId).digest("hex")}.json`);
      await createEvalAttemptPhase(phasePath, { executionId: execution.id, attemptId });
      const gateway = await startEvalGateway({ ledger, route,
        identity, resolveIdentity: () => readEvalAttemptPhase(phasePath, identity), deadlineAt: Date.parse(manifest.limits.deadlineAt),
        persist: (receipt: EvalGatewayReceipt) => atomicJson(path.join(receiptDirectory, `${receipt.requestId}.json`), receipt),
      });
      let relay: Awaited<ReturnType<typeof startEvalOtlpRelay>> | undefined;
      let remote: Awaited<ReturnType<typeof startEvalRemoteGateway>> | undefined;
      try {
        if (observability) relay = await startEvalOtlpRelay({ projectId: observability.projectId, apiKey: observability.apiKey,
          campaignId: manifest.limits.campaignId, attemptId, deadlineAt: Math.min(Date.parse(manifest.limits.deadlineAt), Date.now() + 4 * 3_600_000),
          receiptPath: path.join(`${manifest.ledgerPath}.otlp`, `${createHash("sha256").update(attemptId).digest("hex")}.jsonl`) });
        if (execution.environment.id === "daytona") remote = await startEvalRemoteGateway({ gateway, observability: relay,
          deadlineAt: Math.min(Date.parse(manifest.limits.deadlineAt), Date.now() + 4 * 3_600_000) }, env);
      } catch (error) { await Promise.allSettled([gateway.close(), relay?.close()]); throw error; }
      let closing: Promise<void> | undefined;
      const endpoint = { ...gateway, baseUrl: remote?.baseUrl ?? gateway.baseUrl, phasePath,
        observability: relay ? { ...relay, baseUrl: remote ? `${remote.baseUrl}/otel` : relay.baseUrl } : undefined, close: () => closing ??= (async () => {
        const remoteResults = await Promise.allSettled([remote?.close()]);
        const results = [...remoteResults, ...await Promise.allSettled([gateway.close(), relay?.close()])];
        active.delete(endpoint);
        if (results.some(result => result.status === "rejected")) throw new Error("Eval gateway or OTLP relay cleanup failed");
      })() };
      active.add(endpoint);
      return endpoint;
    },
    async close() {
      const results = await Promise.allSettled([...active].map(gateway => gateway.close())); active.clear();
      try { await atomicJson(`${manifest.ledgerPath}.summary.json`, ledger.snapshot()); } finally { await ledger.close(); }
      if (results.some(result => result.status === "rejected")) throw new Error("Eval gateway cleanup failed");
    },
  };
}
export type EvalOperations = Awaited<ReturnType<typeof openEvalOperations>>;
