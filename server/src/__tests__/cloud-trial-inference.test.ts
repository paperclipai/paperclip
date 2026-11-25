import { generateKeyPairSync, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_TRIAL_DEFAULT_MODEL,
  CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
  defaultMigrationTargetForProvider,
  parseCloudTrialMigrationTargetsEnv,
  resolveCloudTrialModel,
} from "@paperclipai/shared";
import {
  CloudTrialExhaustedError,
  createCloudTrialInferenceController,
} from "../services/cloud-trial-inference.js";
import { cloudInferenceInternalProxyRoutes } from "../routes/cloud-inference.js";
import { resolveBrowserAnalyticsConfig } from "../services/cloud-posthog-browser.js";
import {
  resetResolvedCloudTrialInferenceEnabledForTests,
  setResolvedCloudTrialInferenceEnabled,
} from "../services/cloud-posthog-cohort.js";
import { createPostHogDirectTransport } from "../services/posthog-direct/transport.js";

function generateTestEd25519Pair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  const rawSeed = privDer.subarray(privDer.length - 32);
  return {
    publicKey,
    privateKeyBase64Url: rawSeed.toString("base64url"),
  };
}

async function listenExpress(app: express.Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("Failed to bind test server");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function fakeDbWithFlag(enabled: boolean) {
  const row = {
    id: "00000000-0000-0000-0000-000000000001",
    singletonKey: "default",
    general: {},
    experimental: { enableCloudTrialInference: enabled },
    defaultEnvironmentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    select: () => ({
      from: () => ({
        where: async () => [row],
        limit: async () => [row],
      }),
    }),
  } as never;
}

describe("cloud-trial-inference", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers.pop()!();
    }
    resetResolvedCloudTrialInferenceEnabledForTests();
    vi.restoreAllMocks();
  });

  it("signs Cloud requests with Ed25519 only, enforces strict starter model, renews active run tokens, and detects HTTP 402 exhaustion", async () => {
    const keypair = generateTestEd25519Pair();
    const seenAuthHeaders: string[] = [];
    const seenAttributionHeaders: Array<string | undefined> = [];
    let return402 = false;
    let keyRemainingUsd = 0.75;
    let fakeNow = 1_700_000_000_000;

    // Mock upstream OpenRouter server
    const mockOpenRouter = express();
    mockOpenRouter.use(express.json());
    mockOpenRouter.post("/api/v1/chat/completions", (req, res) => {
      seenAuthHeaders.push(String(req.headers.authorization ?? ""));
      seenAttributionHeaders.push(
        typeof req.headers["x-openrouter-title"] === "string" ? req.headers["x-openrouter-title"] : undefined,
      );
      if (return402) {
        res.status(402).json({ error: { code: 402, message: "Key limit exceeded" } });
        return;
      }
      res.status(200).json({
        id: "chatcmpl-test",
        choices: [{ message: { role: "assistant", content: "Hello from Luna!" } }],
      });
    });
    mockOpenRouter.get("/api/v1/key", (_req, res) => {
      res.status(200).json({
        data: { limit: 1.0, usage: 1.0 - keyRemainingUsd, limit_remaining: keyRemainingUsd },
      });
    });
    const upstream = await listenExpress(mockOpenRouter);
    closers.push(upstream.close);

    // Mock Cloud Harness server verifying Ed25519 signature (no shared bearer token)
    let exhaustedReportedToCloud = false;
    const mockCloud = express();
    mockCloud.use(express.json());
    const verifySignature = (req: express.Request, pathname: string) => {
      expect(req.headers.authorization).toBeUndefined();
      const stackId = String(req.headers["x-paperclip-cloud-stack-id"] ?? "");
      const ts = String(req.headers["x-paperclip-cloud-stack-timestamp"] ?? "");
      const sig = String(req.headers["x-paperclip-cloud-stack-signature"] ?? "");
      expect(stackId).toBe("stack-test-1");
      const payload = Buffer.from(`POST\n${pathname}\n${stackId}\n${ts}`, "utf8");
      expect(verify(null, payload, keypair.publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    };
    mockCloud.post("/v1/tenant/inference-key", (req, res) => {
      verifySignature(req, "/v1/tenant/inference-key");
      res.status(200).json({
        provider: "openrouter",
        status: "active",
        apiKey: "sk-or-v1-real-secret-key-never-sent-to-sandbox",
        limitUsdCents: 100,
        spentUsdCents: 0,
        remainingUsdCents: 100,
        defaultModel: "openrouter/openai/gpt-6-luna",
      });
    });
    mockCloud.post("/v1/tenant/inference-key/exhausted", (req, res) => {
      verifySignature(req, "/v1/tenant/inference-key/exhausted");
      exhaustedReportedToCloud = true;
      res.status(200).json({
        provider: "openrouter",
        status: "exhausted",
        limitUsdCents: 100,
        spentUsdCents: 100,
        remainingUsdCents: 0,
      });
    });
    const cloud = await listenExpress(mockCloud);
    closers.push(cloud.close);

    const controller = createCloudTrialInferenceController({
      env: {
        PAPERCLIP_CLOUD_STACK_ID: "stack-test-1",
        PAPERCLIP_CLOUD_API_ORIGIN: cloud.baseUrl,
        PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "shared-token-must-not-be-sent",
        PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: keypair.privateKeyBase64Url,
        PAPERCLIP_CLOUD_TRIAL_OPENROUTER_BASE_URL: `${upstream.baseUrl}/api/v1`,
        PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      },
      now: () => fakeNow,
    });

    // Mount internal proxy
    const proxyApp = express();
    proxyApp.use("/api/internal/cloud-inference", cloudInferenceInternalProxyRoutes(controller));
    const proxy = await listenExpress(proxyApp);
    closers.push(proxy.close);

    const db = fakeDbWithFlag(true);

    // 0. Non-starter model is rejected at run preparation (cannot bypass starter model cap)
    await expect(
      controller.prepareCloudTrialRuntime(db, {
        companyId: "comp-1",
        agentId: "agent-1",
        runId: "run-bad-model",
        model: "openrouter/anthropic/claude-opus-4",
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ code: "cloud_trial_model_not_allowed" }),
    });

    const runtime = await controller.prepareCloudTrialRuntime(db, {
      companyId: "comp-1",
      agentId: "agent-1",
      runId: "run-1",
      model: "openrouter/openai/gpt-6-luna",
    });

    // Raw key MUST NOT be in sandbox env!
    expect(runtime.env.OPENROUTER_API_KEY).toBe("");
    expect(runtime.env.PAPERCLIP_OPENROUTER_PROXY_TOKEN).toMatch(/^pctrial_/);
    expect(runtime.env.PAPERCLIP_OPENROUTER_PROXY_TOKEN).not.toContain("sk-or-v1-real-secret");
    expect(runtime.env.PAPERCLIP_OPENROUTER_PROXY_URL).toBe("http://127.0.0.1:3100/api/internal/cloud-inference/v1");

    const token = runtime.env.PAPERCLIP_OPENROUTER_PROXY_TOKEN!;

    // 1. Invalid token fails closed (401), unknown pctrial_ token reports distinct instance error
    const badAuth = await fetch(`${proxy.baseUrl}/api/internal/cloud-inference/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer bogus", "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-luna", messages: [] }),
    });
    expect(badAuth.status).toBe(401);
    expect(((await badAuth.json()) as { error: { code: string } }).error.code).toBe("unauthorized");

    const unknownRunToken = await fetch(`${proxy.baseUrl}/api/internal/cloud-inference/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer pctrial_unknown_from_other_instance", "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-luna", messages: [] }),
    });
    expect(unknownRunToken.status).toBe(401);
    expect(((await unknownRunToken.json()) as { error: { code: string } }).error.code).toBe(
      "proxy_token_not_found_on_instance",
    );

    // 2. Disallowed model, missing model, fallback models array, and fallback route all fail closed (403)
    const badModel = await fetch(`${proxy.baseUrl}/api/internal/cloud-inference/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-opus-4", messages: [] }),
    });
    expect(badModel.status).toBe(403);

    const missingModel = await fetch(`${proxy.baseUrl}/api/internal/cloud-inference/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ models: ["anthropic/claude-opus-4"], messages: [] }),
    });
    expect(missingModel.status).toBe(403);

    const fallbackModels = await fetch(`${proxy.baseUrl}/api/internal/cloud-inference/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-6-luna",
        models: ["openai/gpt-6-luna", "anthropic/claude-opus-4"],
        messages: [],
      }),
    });
    expect(fallbackModels.status).toBe(403);

    const fallbackRoute = await fetch(`${proxy.baseUrl}/api/internal/cloud-inference/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-6-luna",
        route: "fallback",
        messages: [],
      }),
    });
    expect(fallbackRoute.status).toBe(403);

    // 3. Allowed model succeeds and active-run token survives multi-hour tool execution gaps until cleanup()
    fakeNow += 2 * 60 * 60_000;
    const okRes = await fetch(`${proxy.baseUrl}/api/internal/cloud-inference/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-luna", messages: [{ role: "user", content: "Hi" }] }),
    });
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { choices: Array<{ message: { content: string } }> };
    expect(okBody.choices[0]!.message.content).toBe("Hello from Luna!");
    expect(seenAuthHeaders[0]).toBe("Bearer sk-or-v1-real-secret-key-never-sent-to-sandbox");
    expect(seenAttributionHeaders[0]).toBe("Paperclip");

    // Advance another 3 hours — still valid while the run remains active!
    fakeNow += 3 * 60 * 60_000;
    const renewedRes = await fetch(`${proxy.baseUrl}/api/internal/cloud-inference/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-luna", messages: [{ role: "user", content: "Still running" }] }),
    });
    expect(renewedRes.status).toBe(200);

    // 4. Upstream HTTP 402 immediately triggers exhaustion + Cloud notification + 402 response
    return402 = true;
    const exhaustedRes = await fetch(`${proxy.baseUrl}/api/internal/cloud-inference/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-luna", messages: [{ role: "user", content: "More" }] }),
    });
    expect(exhaustedRes.status).toBe(402);
    const exhaustedBody = (await exhaustedRes.json()) as { error: { code: string } };
    expect(exhaustedBody.error.code).toBe(CLOUD_TRIAL_EXHAUSTED_ERROR_CODE);
    expect(exhaustedReportedToCloud).toBe(true);

    // 5. Subsequent run preparation fails immediately with CloudTrialExhaustedError
    await expect(
      controller.prepareCloudTrialRuntime(db, {
        companyId: "comp-1",
        agentId: "agent-1",
        runId: "run-2",
        model: "openrouter/openai/gpt-6-luna",
      }),
    ).rejects.toBeInstanceOf(CloudTrialExhaustedError);

    await runtime.cleanup();
  });

  it("normalizes starter model slugs consistently and maps providers including acpx Google/GitHub and deployment overrides", () => {
    expect(resolveCloudTrialModel(undefined)).toBe(CLOUD_TRIAL_DEFAULT_MODEL);
    expect(resolveCloudTrialModel("openai/gpt-6-luna")).toBe("openrouter/openai/gpt-6-luna");
    expect(resolveCloudTrialModel("openrouter/openai/gpt-6-luna")).toBe("openrouter/openai/gpt-6-luna");

    expect(defaultMigrationTargetForProvider("openai", "subscription")).toEqual({
      adapterType: "paperclip_runner",
      runnerProvider: "codex",
      model: "gpt-6-luna",
    });
    expect(defaultMigrationTargetForProvider("anthropic", "subscription")).toEqual({
      adapterType: "paperclip_runner",
      runnerProvider: "claude",
      model: "claude-sonnet-4-6",
    });
    expect(defaultMigrationTargetForProvider("google", "subscription")).toEqual({
      adapterType: "paperclip_runner",
      runnerProvider: "acpx",
      acpxAgent: "antigravity",
      model: "gemini-2.5-pro",
    });
    expect(defaultMigrationTargetForProvider("github", "subscription")).toEqual({
      adapterType: "paperclip_runner",
      runnerProvider: "acpx",
      acpxAgent: "copilot",
      model: "gpt-5.6-luna",
    });
    expect(defaultMigrationTargetForProvider("xai", "subscription")).toEqual({
      adapterType: "grok_local",
      model: "grok-4",
    });

    const overrides = parseCloudTrialMigrationTargetsEnv(
      JSON.stringify({
        openai: { model: "gpt-6.5-pro" },
        google: { acpxAgent: "antigravity", model: "gemini-3-pro" },
      }),
    );
    expect(defaultMigrationTargetForProvider("openai", "subscription", undefined, overrides)).toEqual({
      adapterType: "paperclip_runner",
      runnerProvider: "codex",
      model: "gpt-6.5-pro",
    });
    expect(defaultMigrationTargetForProvider("google", "subscription", undefined, overrides)).toEqual({
      adapterType: "paperclip_runner",
      runnerProvider: "acpx",
      acpxAgent: "antigravity",
      model: "gemini-3-pro",
    });
    expect(parseCloudTrialMigrationTargetsEnv("not-json")).toEqual({});
  });

  it("keeps PostHog server and browser experiment cohort synced with resolved staging overrides", async () => {
    const captured: Array<{ event: string; properties?: Record<string, unknown> }> = [];
    const transport = createPostHogDirectTransport(
      {
        token: "phc_test",
        host: "https://us.i.posthog.com",
        environment: "staging",
        stackId: "stack-staging-1",
        directEnabled: true,
        browserEnabled: true,
        replayEnabled: false,
        replayWorkContentEnabled: false,
        cloudTrialInferenceEnabled: false,
      },
      {
        factory: async () => ({
          capture: (msg) => captured.push({ event: msg.event, properties: msg.properties }),
          groupIdentify: () => {},
          flush: async () => {},
          shutdown: async () => {},
        }),
      },
    );

    expect(transport.cloudTrialInferenceEnabled).toBe(false);
    setResolvedCloudTrialInferenceEnabled(true);
    expect(transport.cloudTrialInferenceEnabled).toBe(true);
    await transport.captureCloudEvent({ event: "cloud_trial.started", properties: { source: "test" } });
    expect(captured[0]?.properties?.cloud_trial_inference_enabled).toBe(true);
    expect(captured[0]?.properties?.["$feature/cloud-trial-inference"]).toBe("treatment");

    const browserCfg = resolveBrowserAnalyticsConfig(
      {
        PAPERCLIP_CLOUD_STACK_ID: "stack-staging-1",
        PAPERCLIP_CLOUD_HOSTED: "1",
        PAPERCLIP_POSTHOG_PROJECT_TOKEN: "phc_test",
        PAPERCLIP_POSTHOG_BROWSER_ENABLED: "1",
        PAPERCLIP_MANAGED_CONFIG: JSON.stringify({ features: { enableCloudTrialInference: false } }),
      },
      {},
      { cloudTrialInferenceEnabled: true },
    );
    expect(browserCfg?.cloudTrialInferenceEnabled).toBe(true);
  });
});
