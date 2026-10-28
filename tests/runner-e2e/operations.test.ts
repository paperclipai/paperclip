import { afterEach, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import * as remoteGateway from "./eval-remote-gateway.js";
import { runnerMatrix } from "./catalog.js";
import { validateEvalOperationsManifest, openEvalOperations, type EvalOperationsManifest } from "./operations.js";
import { setupLiveFixtures } from "./live-fixtures.js";
import { createAiConnectionSchema, aiConnectionBindingSchema } from "../../packages/shared/src/ai-connections.js";
import type { RunnerApi } from "./api.js";
import { beginEvalAgentPhase, readEvalAttemptPhase } from "./attempt-phase.js";
import { applyEvalGatewayEnvironment, buildPaperclipServerEnvironment } from "./harness-env.js";
const cell = runnerMatrix.find(e => e.suite.id === "core-compatibility" && e.profile.id === "runner-codex" && e.environment.id === "local")!;
function manifest(): EvalOperationsManifest {
  return { version: 1, limits: { campaignId: "pilot", maxUsd: "100", deadlineAt: new Date(Date.now() + 60_000).toISOString(), maxRequests: 20, maxConcurrent: 1 },
    ledgerPath: "/tmp/fixture-not-opened.jsonl", executionIds: [cell.id], maxAttemptsPerExecution: 2, route: "direct",
    models: [{ provider: "openai", maximumInputTokens: 1000, maximumOutputTokens: 100, timeoutMs: 1000,
      price: { provider: "openai", model: cell.profile.model, version: "fixture-only", sourceUrl: "https://provider.invalid/fixture", inputUsdPerMillion: "2", cachedReadUsdPerMillion: "1", outputUsdPerMillion: "10", cacheWrite30mUsdPerMillion: "2", cacheWrite12hUsdPerMillion: "2" } }] };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("admits only the exact bounded local selection and explicitly priced models", () => {
  expect(validateEvalOperationsManifest(manifest(), [cell], 1)).toMatchObject({ route: "direct" });
  expect(() => validateEvalOperationsManifest({ ...manifest(), executionIds: [] }, [cell], 1)).toThrow("selection");
  expect(() => validateEvalOperationsManifest(manifest(), [cell], 2)).toThrow("limits");
  const remote = runnerMatrix.find(e => e.suite.id === cell.suite.id && e.profile.id === cell.profile.id && e.environment.id === "daytona")!;
  expect(() => validateEvalOperationsManifest({ ...manifest(), executionIds: [remote.id] }, [remote], 1)).toThrow("Unqualified");
  const changed = manifest(); changed.models[0]!.price.model = "other";
  expect(() => validateEvalOperationsManifest(changed, [cell], 1)).toThrow("Missing exact model");
});
it("rejects credentials in the manifest and unknown pricing/billing policy fields", () => {
  expect(() => validateEvalOperationsManifest({ ...manifest(), apiKey: "private" } as never, [cell], 0)).toThrow("fields");
  const changed = manifest(); Object.assign(changed.models[0]!, { apiKey: "private" });
  expect(() => validateEvalOperationsManifest(changed, [cell], 0)).toThrow("fields");
  expect(() => validateEvalOperationsManifest({ ...manifest(), route: "braintrust" }, [cell], 0)).toThrow("project UUID");
});
it("admits a bounded exact response mapping without widening the selected request model", () => {
  const value = manifest();
  value.models[0]!.price.responseModels = [`${cell.profile.model}-2026-03-17`];
  expect(validateEvalOperationsManifest(value, [cell], 0)).toBe(value);
  value.models[0]!.price.responseModels = Array.from({ length: 16 }, (_, index) => `${cell.profile.model}-snapshot-${index}`);
  expect(validateEvalOperationsManifest(value, [cell], 0)).toBe(value);
  const changed = structuredClone(value); changed.models[0]!.price.model = "other";
  changed.models[0]!.price.responseModels = [cell.profile.model];
  expect(() => validateEvalOperationsManifest(changed, [cell], 0)).toThrow("Missing exact model");
});
it.each([null, "fixture", [], [""], [" leading-space"], ["fixture?query"], [4], ["a", "a"],
  new Array(1), Array.from({ length: 17 }, (_, index) => `fixture-${index}`),
].map(responseModels => ({ responseModels })))("rejects malformed or excessive response model mappings: $responseModels", ({ responseModels }) => {
  const value = manifest(); Object.assign(value.models[0]!.price, { responseModels });
  expect(() => validateEvalOperationsManifest(value, [cell], 0)).toThrow("response model");
});
it("rejects a response mapping that repeats the exact request identity", () => {
  const value = manifest(); value.models[0]!.price.responseModels = [cell.profile.model];
  expect(() => validateEvalOperationsManifest(value, [cell], 0)).toThrow("response model");
});

it("rejects an unaffordable selected request before opening a ledger or checking credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-unaffordable-preflight-"));
  try {
    const value = manifest(); value.limits.maxUsd = "0.002999999"; value.ledgerPath = path.join(root, "ledger.jsonl");
    const file = path.join(root, "manifest.json"); await writeFile(file, JSON.stringify(value));
    await expect(openEvalOperations(file, [cell], 0, {})).rejects.toThrow("Insufficient initial model allowance");
    await expect(access(value.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${value.ledgerPath}.requests`)).rejects.toMatchObject({ code: "ENOENT" });
    value.limits.maxUsd = "0.003";
    expect(validateEvalOperationsManifest(value, [cell], 0)).toBe(value);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("subtracts declared operating holds and checks only models used by the selection", () => {
  const value = manifest(); value.limits.maxUsd = "0.007"; value.limits.maxAttemptsPerExecution = 2;
  value.limits.overhead = { version: 1, reference: "fixture", runner: "github-hosted",
    verifiedAt: "2026-10-20T00:00:00Z", expiresAt: "2026-11-19T00:00:00Z",
    components: (["ci_compute", "artifact_storage", "observability", "shared_subscription"] as const).map(component => ({
      component, maxUsd: "0.001", reference: "fixture" })) };
  value.models.push({ ...structuredClone(value.models[0]!), maximumInputTokens: 1_000_000,
    price: { ...value.models[0]!.price, model: "unused-model" } });
  expect(validateEvalOperationsManifest(value, [cell], 0)).toBe(value);
  value.limits.maxUsd = "0.006999999";
  expect(() => validateEvalOperationsManifest(value, [cell], 0)).toThrow("Insufficient initial model allowance");
});
it("retains a campaign summary and refuses changing its budget on restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-ops-test-"));
  try {
    const value = { ...manifest(), ledgerPath: path.join(root, "ledger.jsonl") }, file = path.join(root, "manifest.json");
    await writeFile(file, JSON.stringify(value));
    const operations = await openEvalOperations(file, [cell], 0, { OPENAI_API_KEY: "private-fixture" });
    const endpoint = await operations.start(cell, "attempt", 1);
    expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(await readEvalAttemptPhase(endpoint.phasePath, { executionId: cell.id, attemptId: "attempt" })).toMatchObject({ phase: "setup" });
    await beginEvalAgentPhase(cell.id, { PAPERCLIP_E2E_GATEWAY_PHASE_PATH: endpoint.phasePath, PAPERCLIP_E2E_ACCOUNTING_ATTEMPT_ID: "attempt" });
    expect(await readEvalAttemptPhase(endpoint.phasePath, { executionId: cell.id, attemptId: "attempt" })).toMatchObject({ phase: "agent" });
    await endpoint.close(); await operations.close();
    expect(JSON.parse(await readFile(`${value.ledgerPath}.summary.json`, "utf8"))).toMatchObject({ limitUsd: "100.000000000", knownUsd: "0.000000000", requests: [] });
    const resumed = await openEvalOperations(file, [cell], 0, { OPENAI_API_KEY: "private-fixture" });
    const retry = await resumed.start(cell, "retry-after-restart", 1);
    await retry.close();
    await expect(resumed.start(cell, "third-attempt", 1)).rejects.toThrow("attempt cap");
    await resumed.close();
    const summary = JSON.parse(await readFile(`${value.ledgerPath}.summary.json`, "utf8"));
    expect(summary.admittedAttempts).toEqual([{ executionId: cell.id, attemptId: "attempt" }, { executionId: cell.id, attemptId: "retry-after-restart" }]);
    await writeFile(file, JSON.stringify({ ...value, maxAttemptsPerExecution: 3 }));
    await expect(openEvalOperations(file, [cell], 0, { OPENAI_API_KEY: "private-fixture" })).rejects.toThrow("limits changed");
    await writeFile(file, JSON.stringify({ ...value, limits: { ...value.limits, maxUsd: "101" } }));
    await expect(openEvalOperations(file, [cell], 0, { OPENAI_API_KEY: "private-fixture" })).rejects.toThrow("limits changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps both upstream keys on the controller and owns the trace relay lifetime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-ops-relay-"));
  const value = { ...manifest(), ledgerPath: path.join(root, "ledger.jsonl") }, file = path.join(root, "manifest.json");
  const env = { OPENAI_API_KEY: "provider-private", BRAINTRUST_API_KEY: "braintrust-private", BRAINTRUST_OTHER_KEY: "other-private",
    GITHUB_SHA: "a".repeat(40), PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
    PAPERCLIP_E2E_OTLP_RELAY_URL: "https://unowned.invalid/otel" };
  let operations: Awaited<ReturnType<typeof openEvalOperations>> | undefined;
  try {
    await writeFile(file, JSON.stringify(value));
    operations = await openEvalOperations(file, [cell], 0, env);
    const endpoint = await operations.start(cell, "with-observability", 1);
    const worker: NodeJS.ProcessEnv = { ...env };
    applyEvalGatewayEnvironment(worker, cell.profile.credential, endpoint);
    expect(worker).toMatchObject({ OPENAI_API_KEY: endpoint.token, BRAINTRUST_API_KEY: endpoint.observability!.token,
      PAPERCLIP_E2E_OTLP_RELAY_URL: endpoint.observability!.baseUrl, GITHUB_SHA: env.GITHUB_SHA });
    expect(JSON.stringify(worker)).not.toMatch(/provider-private|braintrust-private|other-private/);
    expect(buildPaperclipServerEnvironment(worker).BRAINTRUST_API_KEY).toBeUndefined();
    expect((await fetch(endpoint.observability!.baseUrl + "/v1/traces", { method: "POST" })).status).toBe(401);
    await operations.close(); operations = undefined;
    await expect(fetch(endpoint.baseUrl)).rejects.toThrow();
    await expect(fetch(endpoint.observability!.baseUrl)).rejects.toThrow();
    const receipts = (await readFile(endpoint.observability!.receiptPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(receipts.map(row => row.type)).toEqual(["policy", "closed"]);
    expect(receipts[0]).toMatchObject({ campaignId: "pilot", attemptId: "with-observability", projectId: env.PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID });
    const withoutTracing: NodeJS.ProcessEnv = { ...env };
    applyEvalGatewayEnvironment(withoutTracing, cell.profile.credential, { ...endpoint, observability: undefined });
    expect(withoutTracing.BRAINTRUST_API_KEY).toBeUndefined();
    expect(withoutTracing.PAPERCLIP_E2E_OTLP_RELAY_URL).toBeUndefined();
  } finally { await operations?.close(); await rm(root, { recursive: true, force: true }); }
});

it("rejects mismatched trace projects before opening the journal and retains failed relay admission", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-ops-relay-failure-"));
  const value = { ...manifest(), ledgerPath: path.join(root, "ledger.jsonl"), route: "braintrust" as const,
    projectId: "11111111-1111-4111-8111-111111111111", maxAttemptsPerExecution: 1 }, file = path.join(root, "manifest.json");
  const env = { BRAINTRUST_API_KEY: "braintrust-private", PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID: "22222222-2222-4222-8222-222222222222" };
  let operations: Awaited<ReturnType<typeof openEvalOperations>> | undefined;
  try {
    await writeFile(file, JSON.stringify(value));
    await expect(openEvalOperations(file, [cell], 0, env)).rejects.toThrow("projects differ");
    await expect(access(value.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(`${value.ledgerPath}.otlp`);
    const receipt = path.join(`${value.ledgerPath}.otlp`, `${createHash("sha256").update("collision").digest("hex")}.jsonl`);
    await writeFile(receipt, "retained-receipt");
    operations = await openEvalOperations(file, [cell], 0, { ...env, PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID: value.projectId });
    await expect(operations.start(cell, "collision", 1)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(operations.start(cell, "replacement", 1)).rejects.toThrow("attempt cap");
    await operations.close(); operations = undefined;
    expect(await readFile(receipt, "utf8")).toBe("retained-receipt");
    expect(JSON.parse(await readFile(`${value.ledgerPath}.summary.json`, "utf8")).admittedAttempts)
      .toEqual([{ executionId: cell.id, attemptId: "collision" }]);
  } finally { await operations?.close(); await rm(root, { recursive: true, force: true }); }
});
it.each([
  cell.id,
  "feedback-persistence.runner-codex.local.complaint-and-suggestion",
  "feedback-persistence.runner-acpx-claude.local.complaint-and-suggestion",
  "feedback-persistence.runner-codex.daytona.complaint-and-suggestion",
  "feedback-persistence.runner-acpx-claude.daytona.complaint-and-suggestion",
  "core-compatibility.runner-acpx-claude.daytona.message-marker",
])("routes %s through a shared connection without ambient provider bindings", async executionId => {
  const selected = runnerMatrix.find(execution => execution.id === executionId)!;
  const anthropic = selected.profile.credential === "ANTHROPIC_API_KEY";
  const remote = selected.environment.id === "daytona";
  const origin = remote ? "https://fixture.trycloudflare.com" : "http://127.0.0.1:43123";
  const admitted = manifest();
  if (remote) admitted.remoteGateway = "cloudflare"; admitted.executionIds = [selected.id];
  admitted.models[0]!.provider = anthropic ? "anthropic" : "openai";
  admitted.models[0]!.price.provider = admitted.models[0]!.provider;
  admitted.models[0]!.price.model = selected.profile.model;
  if (anthropic) Object.assign(admitted.models[0]!.price, { cacheWrite5mUsdPerMillion: "2", cacheWrite1hUsdPerMillion: "2" });
  expect(validateEvalOperationsManifest(admitted, [selected], 0)).toBe(admitted);
  vi.stubEnv("PAPERCLIP_E2E_GATEWAY_BASE_URL", origin);
  if (remote) vi.stubEnv("PAPERCLIP_E2E_REMOTE_GATEWAY_ORIGIN", origin);
  vi.stubEnv("PAPERCLIP_E2E_GATEWAY_TOKEN", "ephemeral-fixture-token");
  const id = "11111111-1111-4111-8111-111111111111", grantId = "22222222-2222-4222-8222-222222222222";
  let connection: unknown, agent: Record<string, any> | undefined, company: Record<string, unknown> | undefined;
  const api = {
    async get() { return [{ id, driver: "local" }]; },
    async postSensitive(url: string, body: unknown) { if (url.endsWith("/ai-connections")) { connection = body; return { connectionId: id, grantId }; } return { id }; },
    async post(url: string, body: Record<string, unknown>) { if (url.endsWith("/agents")) agent = body; if (url === "/api/companies") company = body; return { id, name: "fixture" }; },
    async delete() {},
  } as unknown as RunnerApi;
  const fixtures = await setupLiveFixtures({ api, execution: selected, executionNonce: "fixture", workspacePath: "/tmp/fixture", credentials: { [selected.profile.credential]: "ephemeral-fixture-token", ...(remote ? { DAYTONA_API_KEY: "fixture-daytona" } : {}) },
    ...(remote ? { daytonaImage: `ghcr.io/paperclip/image@sha256:${"a".repeat(64)}` } : {}) });
  await fixtures.teardown();
  expect(createAiConnectionSchema.parse(connection)).toMatchObject({ ownership: "shared", apiKey: "ephemeral-fixture-token", routing: { kind: "gateway", protocol: anthropic ? "messages" : "responses", baseUrl: `${origin}${anthropic ? "" : "/v1"}`, auth: "bearer" } });
  expect(aiConnectionBindingSchema.parse(agent!.runtimeConfig.aiConnection)).toEqual({ provider: anthropic ? "anthropic" : "openai", method: "api_key", mode: "shared", connectionId: id, grantId });
  expect(agent!.adapterConfig.env).toBeUndefined();
  expect(agent!.adapterConfig.helloProbeTimeoutSec).toBe(remote ? 300 : undefined);
  if (selected.suite.id === "feedback-persistence") {
    expect(company!.budgetMonthlyCents).toBe(1_000);
    expect(agent!.budgetMonthlyCents).toBe(1_000);
  }
});


it("requires explicit remote gateway admission and infrastructure credentials before opening a journal", async () => {
  const remote = runnerMatrix.find(e => e.suite.id === cell.suite.id && e.profile.id === cell.profile.id && e.environment.id === "daytona")!;
  const value = { ...manifest(), executionIds: [remote.id], remoteGateway: "cloudflare" as const };
  expect(validateEvalOperationsManifest(value, [remote], 0)).toBe(value);
  const root = await mkdtemp(path.join(tmpdir(), "eval-remote-preflight-"));
  try {
    value.ledgerPath = path.join(root, "ledger.jsonl");
    const file = path.join(root, "manifest.json"); await writeFile(file, JSON.stringify(value));
    await expect(openEvalOperations(file, [remote], 0, { OPENAI_API_KEY: "synthetic" })).rejects.toThrow("credential");
    await expect(access(value.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("gives remote workers scoped gateway/relay URLs and closes both local listeners and the tunnel", async () => {
  const remote = runnerMatrix.find(e => e.suite.id === cell.suite.id && e.profile.id === cell.profile.id && e.environment.id === "daytona")!;
  const root = await mkdtemp(path.join(tmpdir(), "eval-remote-operation-"));
  const close = vi.fn(async () => {}), origin = "https://synthetic-owned.trycloudflare.com";
  const start = vi.spyOn(remoteGateway, "startEvalRemoteGateway").mockResolvedValue({ baseUrl: origin, close });
  const value = { ...manifest(), executionIds: [remote.id], remoteGateway: "cloudflare" as const, ledgerPath: path.join(root, "ledger.jsonl") };
  value.limits.deadlineAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
  const file = path.join(root, "manifest.json"), env = { OPENAI_API_KEY: "provider-private", DAYTONA_API_KEY: "infra-private",
    BRAINTRUST_API_KEY: "trace-private", PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID: "11111111-1111-4111-8111-111111111111" };
  let operations: Awaited<ReturnType<typeof openEvalOperations>> | undefined;
  try {
    await writeFile(file, JSON.stringify(value)); operations = await openEvalOperations(file, [remote], 0, env);
    const endpoint = await operations.start(remote, "remote-one", 1);
    const worker: NodeJS.ProcessEnv = { ...env }; applyEvalGatewayEnvironment(worker, remote.profile.credential, endpoint);
    expect(worker).toMatchObject({ PAPERCLIP_E2E_GATEWAY_BASE_URL: origin, PAPERCLIP_E2E_REMOTE_GATEWAY_ORIGIN: origin,
      PAPERCLIP_E2E_OTLP_RELAY_URL: `${origin}/otel`, OPENAI_API_KEY: endpoint.token, BRAINTRUST_API_KEY: endpoint.observability!.token });
    expect(JSON.stringify(worker)).not.toMatch(/provider-private|infra-private|trace-private/);
    const local = start.mock.calls[0]![0];
    expect(local.gateway.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(local.deadlineAt).toBeLessThanOrEqual(Date.now() + 4 * 3_600_000);
    expect(local.deadlineAt).toBeLessThan(Date.parse(value.limits.deadlineAt));
    await operations.close(); operations = undefined; expect(close).toHaveBeenCalledOnce();
    await expect(fetch(local.gateway.baseUrl)).rejects.toThrow();
    await expect(fetch(local.observability!.baseUrl)).rejects.toThrow();
  } finally { await operations?.close(); await rm(root, { recursive: true, force: true }); }
});
