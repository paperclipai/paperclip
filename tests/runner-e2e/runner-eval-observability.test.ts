import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSanitizedAcpxSpawnInput } from "../../packages/paperclip-runner/src/drivers/acpx/environment.js";
import { createCapabilityFixtureState } from "../../packages/paperclip-runner/src/mock-core/capability-control-plane-types.js";
import type { CapabilityLiveSessionSnapshot } from "../../packages/paperclip-runner/src/live/live-session.js";
import { parseEvalSessionRequest } from "../../packages/paperclip-runner/src/cli/eval-session-contract.js";
import { prepareEvalGatewayRuntime } from "../../packages/paperclip-runner/src/cli/eval-gateway-runtime.js";
import { prepareEvalObservabilityRuntime } from "../../packages/paperclip-runner/src/cli/eval-observability-runtime.js";
import { buildProviderObservabilityLaunch } from "../../packages/adapter-utils/src/agent-observability.js";
import { exportBraintrustAttemptParent } from "./braintrust.js";
import { createRequire } from "node:module";
import { parseEvalSessionCliArgs, runEvalSessionCli } from "../../packages/paperclip-runner/src/cli/eval-session.js";

const { parse } = createRequire(new URL("../../packages/paperclip-runner/package.json", import.meta.url))("smol-toml") as { parse(text: string): Record<string, unknown> };
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    for (const entry of await readdir(root).catch(() => [])) {
      if (entry.startsWith(".paperclip-eval-runtime-context-")) await chmod(join(root, entry, "instructions"), 0o700).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
});
const token = "a".repeat(64);
async function fixture(provider = "codex", acpxAgent?: string) {
  const root = await mkdtemp(join(tmpdir(), "runner-gateway-test-")); roots.push(root);
  const model = acpxAgent === "claude" ? "claude-sonnet-5" : "gpt-5.6-sol";
  const binary = join(root, "runnerd");
  await writeFile(binary, "fake runnerd");
  const request = parseEvalSessionRequest({
    schema: "paperclip-runner/eval-session-request/v1", attemptId: "attempt-1", prompt: "Read the governed task.",
    provider, ...(acpxAgent ? { acpxAgent } : {}), model,
    runnerd: { path: binary, sha256: createHash("sha256").update("fake runnerd").digest("hex") },
    limits: { turnTimeoutMs: 120000, maxAgentTurns: 1, maxEstimatedCostNanodollars: 100000000 },
    session: { workingDirectory: root },
  });
  const descriptor = { schema: "paperclip.runner-eval.gateway/v1", provider: acpxAgent === "claude" ? "anthropic" : "openai",
    model, baseUrl: "http://127.0.0.1:4567", campaignId: "campaign-1", executionId: "cell-1", attemptId: "attempt-1", upstreamRoute: "braintrust" };
  const descriptorPath = join(root, "gateway.json");
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  return { root, request, descriptor, descriptorPath };
}

const otlpToken = "b".repeat(64);
async function observabilityFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const identity = { projectId: "11111111-1111-4111-8111-111111111111", traceId: "1".repeat(32), spanId: "2".repeat(16) };
  const baseUrl = "http://127.0.0.1:4568/otel";
  const descriptor = {
    schema: "paperclip.runner-eval.observability/v1", campaignId: f.descriptor.campaignId,
    executionId: f.descriptor.executionId, attemptId: f.request.attemptId, ...identity, baseUrl,
    launch: buildProviderObservabilityLaunch({ kind: f.request.provider === "codex" ? "codex" : "claude",
      companyId: "company-1", agentId: "actor-1", revision: "revision-1", compatibilityKey: "revision-1", enabled: true,
      capture: { userPrompts: true, assistantResponses: true, toolDetails: true, toolContent: true },
      logsEndpoint: `${baseUrl}/v1/logs`, tracesEndpoint: `${baseUrl}/v1/traces`,
      headers: { "x-bt-parent": exportBraintrustAttemptParent(identity) },
    }),
  };
  const file = join(f.root, "observability.json");
  await writeFile(file, JSON.stringify(descriptor));
  return { descriptor, file };
}

it.each([["codex", undefined], ["acpx", "claude"]])("applies the existing %s/%s launch contract only to its owned gateway home", async (provider, agent) => {
  const f = await fixture(provider, agent), observation = await observabilityFixture(f);
  const gateway = await prepareEvalGatewayRuntime(f.descriptorPath, f.request, { PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN: token });
  try {
    const result = await prepareEvalObservabilityRuntime(observation.file, f.request, gateway, { PAPERCLIP_RUNNER_EVAL_OTLP_TOKEN: otlpToken, BRAINTRUST_API_KEY: "upstream-secret" });
    const launch = result.transportOptions.observability;
    expect(result.evidence).toMatchObject({ mode: "controller_otlp", configured: true, verification: "unverified", projectId: observation.descriptor.projectId });
    expect(JSON.stringify(result.evidence)).not.toContain(otlpToken);
    expect(JSON.stringify(result)).not.toContain("upstream-secret");
    expect(launch.environment.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toContain(`authorization=Bearer%20${otlpToken}`);
    expect(result.transportOptions.environment.BRAINTRUST_API_KEY).toBeUndefined();
    if (provider === "codex") {
      const raw = await readFile(join(gateway.transportOptions.environment.CODEX_HOME!, "config.toml"), "utf8"), config = parse(raw);
      expect(config.model_provider).toBe("paperclip_eval");
      expect(config.otel).toEqual(observation.descriptor.launch.otelConfig);
      expect(raw).not.toContain(otlpToken);
      expect((await stat(join(gateway.transportOptions.environment.CODEX_HOME!, "config.toml"))).mode & 0o777).toBe(0o600);
    } else {
      const sanitized = createSanitizedAcpxSpawnInput(result.transportOptions.environment, "claude").env;
      expect(sanitized.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(observation.descriptor.baseUrl + "/v1/traces");
      expect(sanitized.OTEL_EXPORTER_OTLP_TRACES_HEADERS).toContain(otlpToken);
      expect(sanitized.ANTHROPIC_API_KEY).toBe(token);
    }
  } finally { await gateway.close(); }
});

it.each(["identity", "endpoint", "parent", "credential", "company", "rawBodies", "modelEnvironment", "extraField", "unknownExporter", "prototypeHeader"])("rejects observability %s drift before changing the gateway home", async fault => {
  const f = await fixture(), observation = await observabilityFixture(f);
  const descriptor = observation.descriptor as unknown as Record<string, any>;
  if (fault === "identity") descriptor.attemptId = "other";
  if (fault === "endpoint") descriptor.launch.otelConfig.exporter["otlp-http"].endpoint = "https://api.braintrust.dev/otel/v1/logs";
  if (fault === "parent") descriptor.traceId = "3".repeat(32);
  if (fault === "prototypeHeader") descriptor.launch.environment.OTEL_EXPORTER_OTLP_LOGS_HEADERS += ",__proto__=ignored";
  if (fault === "credential") descriptor.launch.environment.OTEL_EXPORTER_OTLP_LOGS_HEADERS += ",authorization=Bearer%20upstream-secret";
  if (fault === "company") descriptor.launch.otelConfig.span_attributes["paperclip.company.id"] = "other";
  if (fault === "rawBodies") descriptor.launch.otelConfig.log_guardian_assessments = true;
  if (fault === "modelEnvironment") descriptor.launch.environment.OPENAI_API_KEY = "upstream-secret";
  if (fault === "extraField") descriptor.extra = "unknown";
  if (fault === "unknownExporter") descriptor.launch.otelConfig.extra_exporter = "console";
  await writeFile(observation.file, JSON.stringify(descriptor));
  const gateway = await prepareEvalGatewayRuntime(f.descriptorPath, f.request, { PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN: token });
  const config = join(gateway.transportOptions.environment.CODEX_HOME!, "config.toml"), before = await readFile(config);
  try {
    await expect(prepareEvalObservabilityRuntime(observation.file, f.request, gateway, { PAPERCLIP_RUNNER_EVAL_OTLP_TOKEN: otlpToken })).rejects.toThrow("Invalid controlled eval observability");
    expect(await readFile(config)).toEqual(before);
  } finally { await gateway.close(); }
});

it("refuses missing relay credentials and oversized observability files before launch", async () => {
  const f = await fixture(), observation = await observabilityFixture(f);
  const gateway = await prepareEvalGatewayRuntime(f.descriptorPath, f.request, { PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN: token });
  try {
    await expect(prepareEvalObservabilityRuntime(observation.file, f.request, gateway, {})).rejects.toThrow("OTLP token");
    await writeFile(observation.file, " ".repeat(131073));
    await expect(prepareEvalObservabilityRuntime(observation.file, f.request, gateway, { PAPERCLIP_RUNNER_EVAL_OTLP_TOKEN: otlpToken })).rejects.toThrow("Invalid controlled eval observability");
  } finally { await gateway.close(); }
});

it.each([false, true])("the real CLI redacts native relay credentials and removes its home after failure=%s", async (fail) => {
  const f = await fixture();
  const observation = await observabilityFixture(f);
  vi.stubEnv("PAPERCLIP_RUNNER_EVAL_OTLP_TOKEN", otlpToken);
  vi.stubEnv("PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN", token);
  vi.stubEnv("OPENAI_API_KEY", "upstream-must-not-reach-provider");
  const requestPath = join(f.root, "request.json"), outputPath = join(f.root, "artifact.json");
  await writeFile(requestPath, JSON.stringify(f.request));
  const state = JSON.stringify(createCapabilityFixtureState({}));
  const snapshot = {
    sessionId: "session-1", revision: 1, providerThreadId: "provider-1", providerSessionId: "provider-1",
    providerModel: { id: f.request.model, provider: "openai" }, status: "idle", activeTurnId: null,
    createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:01Z",
    authority: { companyId: "company-1", actorId: "actor-1", taskId: "task-1", runId: "run-1", sessionId: "session-1", scenarioId: "gateway-test" },
    config: { provider: "codex", driver: "codex_app_server", seedState: state, workingDirectory: f.root, scenario: { id: "gateway-test" }, capabilities: [], explicitClaims: [], turnTimeoutMs: 1000 },
    mockState: state, process: null, networkEvidence: { realPaperclipRequests: 0, childPaperclipEnvironmentKeys: [] },
    transcript: [], evidence: [], authorizationRecords: [], attempts: [], terminalTurns: [{ turnId: "turn-1", status: "completed" }],
    usageLedger: [{ receiptId: "receipt-1", turnId: "turn-1", providerCalls: 1, providerRequests: 1, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, reasoningTokens: 0, costNanodollars: 0 }], usageUnavailable: [],
  } as unknown as CapabilityLiveSessionSnapshot;
  let home: string | undefined;
  const factory = vi.fn((_binary, options) => {
    expect(options.homeMode).toBe("preconfigured");
    expect(options.observability).toBeDefined();
    expect(options.environment.OPENAI_API_KEY).toBeUndefined();
    expect(options.environment.PAPERCLIP_AI_PROVIDER_KEY).toBe(token);
    home = options.environment.HOME;
    expect(existsSync(home!)).toBe(true);
    return { create: async () => ({
      sendMessage: async () => { if (fail) throw new Error(`simulated provider failure Bearer ${otlpToken}`); return { turnId: "turn-1", status: "completed", snapshot }; },
      completeAttempt: async () => undefined, shutdown: async () => { snapshot.status = "closed"; }, snapshot: () => snapshot,
    }) } as never;
  });
  const result = await runEvalSessionCli(["--request", requestPath, "--output", outputPath, "--gateway-config", f.descriptorPath, "--observability-config", observation.file], { serviceFactory: factory });
  expect(result).toBe(fail ? 2 : 0);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(existsSync(home!)).toBe(false);
  const raw = await readFile(outputPath, "utf8"), artifact = JSON.parse(raw);
  expect(artifact.requestRouting).toMatchObject({ mode: "controller_gateway", provider: "openai", campaignId: "campaign-1", executionId: "cell-1", attemptId: "attempt-1" });
  expect(raw).not.toContain(token);
  expect(raw).not.toContain(otlpToken);
  expect(artifact.nativeObservability).toEqual(expect.objectContaining({ configured: true, verification: "unverified" }));
  expect(raw).not.toContain("upstream-must-not-reach-provider");
  if (fail) expect(artifact.infrastructureError).toBe("simulated provider failure [REDACTED]");
});


it("requires gateway ownership before accepting observability", () => {
  expect(() => parseEvalSessionCliArgs(["--request", "request.json", "--output", "artifact.json", "--observability-config", "otel.json"]))
    .toThrow("requires an explicit controller gateway");
});

it("rejects a symlinked observability descriptor", async () => {
  const f = await fixture(), observation = await observabilityFixture(f);
  const linked = join(f.root, "linked.json");
  await symlink(observation.file, linked);
  const gateway = await prepareEvalGatewayRuntime(f.descriptorPath, f.request, { PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN: token });
  try {
    await expect(prepareEvalObservabilityRuntime(linked, f.request, gateway, { PAPERCLIP_RUNNER_EVAL_OTLP_TOKEN: otlpToken })).rejects.toThrow();
  } finally { await gateway.close(); }
});
