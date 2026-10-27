import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSanitizedCodexEnvironment } from "../drivers/codex/app-server-transport.js";
import { createSanitizedAcpxSpawnInput } from "../drivers/acpx/environment.js";
import { createCapabilityFixtureState } from "../mock-core/capability-control-plane-types.js";
import type { CapabilityLiveSessionSnapshot } from "../live/live-session.js";
import { parseEvalSessionRequest } from "./eval-session-contract.js";
import { prepareEvalGatewayRuntime } from "./eval-gateway-runtime.js";
import { runEvalSessionCli } from "./eval-session.js";

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

it.each([["codex", undefined], ["acpx", "claude"]])("routes %s/%s with only its proxy credential and an owned home", async (provider, agent) => {
  const f = await fixture(provider, agent);
  const gateway = await prepareEvalGatewayRuntime(f.descriptorPath, f.request, {
    PATH: process.env.PATH, HOME: "/ambient/home", CODEX_HOME: "/ambient/codex", CLAUDE_CONFIG_DIR: "/ambient/claude",
    PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN: token, OPENAI_API_KEY: "ambient-openai", CODEX_API_KEY: "ambient-codex",
    ANTHROPIC_API_KEY: "ambient-anthropic", ANTHROPIC_AUTH_TOKEN: "ambient-oauth", CLAUDE_CODE_OAUTH_TOKEN: "ambient-claude",
    BRAINTRUST_API_KEY: "ambient-braintrust", AWS_SECRET_ACCESS_KEY: "ambient-aws", GH_TOKEN: "ambient-github",
    HTTPS_PROXY: "https://ambient-proxy", NODE_OPTIONS: "--require ambient-hook", PAPERCLIP_CONFIGURED_ENVIRONMENT_KEYS: '["GH_TOKEN"]',
  });
  const env = gateway.transportOptions.environment;
  try {
    expect(gateway.transportOptions.homeMode).toBe("preconfigured");
    expect(JSON.stringify(env)).not.toContain("ambient");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.BRAINTRUST_API_KEY).toBeUndefined();
    expect(env.PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN).toBeUndefined();
    const child = provider === "codex" ? createSanitizedCodexEnvironment(env) : createSanitizedAcpxSpawnInput(env, agent as "codex" | "claude").env;
    expect(child.HOME).toBe(env.HOME);
    if (agent === "claude") {
      expect(child.ANTHROPIC_API_KEY).toBe(token);
      expect(child.ANTHROPIC_BASE_URL).toBe(f.descriptor.baseUrl);
      expect(child.CLAUDE_CODE_SUBAGENT_MODEL).toBe(f.request.model);
      expect(JSON.parse(await readFile(join(env.CLAUDE_CONFIG_DIR!, "settings.json"), "utf8"))).toEqual({ model: f.request.model, availableModels: [f.request.model] });
    } else {
      expect(child.PAPERCLIP_AI_PROVIDER_KEY).toBe(token);
      const config = await readFile(join(env.CODEX_HOME!, "config.toml"), "utf8");
      expect(config).toContain('base_url = "http://127.0.0.1:4567/v1"');
      expect(config).toContain('env_key = "PAPERCLIP_AI_PROVIDER_KEY"');
      expect(config).toContain("requires_openai_auth = false");
      expect(config).toContain("shell_snapshot = false");
      expect(config).toContain('web_search = "disabled"');
      expect(config).not.toContain(token);
      expect((await stat(join(env.CODEX_HOME!, "config.toml"))).mode & 0o777).toBe(0o600);
    }
    expect(JSON.stringify(gateway.evidence)).not.toContain(token);
    expect(gateway.evidence).toMatchObject({ mode: "controller_gateway", attemptId: f.request.attemptId, declaredUpstreamRoute: "braintrust" });
  } finally { await gateway.close(); }
  expect(existsSync(env.HOME!)).toBe(false);
});

it.each([
  { baseUrl: "https://api.openai.com" }, { baseUrl: "http://localhost:4567" },
  { baseUrl: "http://127.0.0.1:4567/v1" }, { baseUrl: "http://127.0.0.1:99999" },
  { baseUrl: "http://127.0.0.1:4567?token=secret" }, { attemptId: "another-attempt" },
  { model: "another-model" }, { campaignId: "bad identity" }, { unexpectedSecret: "must-not-print" },
])("rejects invalid descriptor binding %j", async (change) => {
  const f = await fixture();
  await writeFile(f.descriptorPath, JSON.stringify({ ...f.descriptor, ...change }));
  await expect(prepareEvalGatewayRuntime(f.descriptorPath, f.request, { PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN: token }))
    .rejects.toThrow("Invalid controller gateway descriptor");
});

it("rejects missing tokens and unsupported provider routes before runtime creation", async () => {
  const f = await fixture();
  await expect(prepareEvalGatewayRuntime(f.descriptorPath, f.request, {})).rejects.toThrow("gateway token");
  await expect(prepareEvalGatewayRuntime(f.descriptorPath, { ...f.request, provider: "opencode" }, { PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN: token })).rejects.toThrow("does not support");
  await writeFile(f.descriptorPath, JSON.stringify({ ...f.descriptor, provider: "anthropic" }));
  await expect(prepareEvalGatewayRuntime(f.descriptorPath, f.request, { PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN: token })).rejects.toThrow("does not support");
});

it.each([false, true])("the real CLI retains route identity and removes the owned home after failure=%s", async (fail) => {
  const f = await fixture();
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
    expect(options.environment.OPENAI_API_KEY).toBeUndefined();
    expect(options.environment.PAPERCLIP_AI_PROVIDER_KEY).toBe(token);
    home = options.environment.HOME;
    expect(existsSync(home!)).toBe(true);
    return { create: async () => ({
      sendMessage: async () => { if (fail) throw new Error("simulated provider failure"); return { turnId: "turn-1", status: "completed", snapshot }; },
      completeAttempt: async () => undefined, shutdown: async () => { snapshot.status = "closed"; }, snapshot: () => snapshot,
    }) } as never;
  });
  const result = await runEvalSessionCli(["--request", requestPath, "--output", outputPath, "--gateway-config", f.descriptorPath], { serviceFactory: factory });
  expect(result).toBe(fail ? 2 : 0);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(existsSync(home!)).toBe(false);
  const raw = await readFile(outputPath, "utf8"), artifact = JSON.parse(raw);
  expect(artifact.requestRouting).toMatchObject({ mode: "controller_gateway", provider: "openai", campaignId: "campaign-1", executionId: "cell-1", attemptId: "attempt-1" });
  expect(raw).not.toContain(token);
  expect(raw).not.toContain("upstream-must-not-reach-provider");
  if (fail) expect(artifact.infrastructureError).toBe("simulated provider failure");
});


it.each(["codex", undefined])("rejects ACPX Codex (%s) before creating any provider service", async (agent) => {
  const f = await fixture("acpx", agent);
  vi.stubEnv("PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN", token);
  const requestPath = join(f.root, "request.json"), outputPath = join(f.root, "artifact.json");
  await writeFile(requestPath, JSON.stringify(f.request));
  const factory = vi.fn(() => { throw new Error("must not create a provider service"); });
  await expect(runEvalSessionCli(["--request", requestPath, "--output", outputPath, "--gateway-config", f.descriptorPath], { serviceFactory: factory }))
    .rejects.toThrow("Controller gateway does not support this eval provider");
  expect(factory).not.toHaveBeenCalled();
  expect(existsSync(outputPath)).toBe(false);
});
