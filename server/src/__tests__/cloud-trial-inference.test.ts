import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
  defaultMigrationTargetForProvider,
} from "@paperclipai/shared";
import {
  CloudTrialExhaustedError,
  createCloudTrialInferenceController,
} from "../services/cloud-trial-inference.js";
import { cloudInferenceInternalProxyRoutes } from "../routes/cloud-inference.js";

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
    vi.restoreAllMocks();
  });

  it("proxies OpenRouter requests with ephemeral run token, hides raw key, guards model, and detects HTTP 402 exhaustion", async () => {
    const seenAuthHeaders: string[] = [];
    const seenAttributionHeaders: Array<string | undefined> = [];
    let return402 = false;
    let keyRemainingUsd = 0.75;

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

    // Mock Cloud Harness server
    let exhaustedReportedToCloud = false;
    const mockCloud = express();
    mockCloud.use(express.json());
    mockCloud.post("/v1/tenant/inference-key", (req, res) => {
      expect(req.headers["x-paperclip-cloud-stack-id"]).toBe("stack-test-1");
      expect(req.headers.authorization).toBe("Bearer test-tenant-token");
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
    mockCloud.post("/v1/tenant/inference-key/exhausted", (_req, res) => {
      exhaustedReportedToCloud = true;
      res.status(200).json({ provider: "openrouter", status: "exhausted", limitUsdCents: 100, spentUsdCents: 100, remainingUsdCents: 0 });
    });
    const cloud = await listenExpress(mockCloud);
    closers.push(cloud.close);

    const controller = createCloudTrialInferenceController({
      env: {
        PAPERCLIP_CLOUD_STACK_ID: "stack-test-1",
        PAPERCLIP_CLOUD_API_ORIGIN: cloud.baseUrl,
        PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "test-tenant-token",
        PAPERCLIP_CLOUD_TRIAL_OPENROUTER_BASE_URL: `${upstream.baseUrl}/api/v1`,
        PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      },
    });

    // Mount internal proxy
    const proxyApp = express();
    proxyApp.use("/api/internal/cloud-inference", cloudInferenceInternalProxyRoutes(controller));
    const proxy = await listenExpress(proxyApp);
    closers.push(proxy.close);

    const db = fakeDbWithFlag(true);
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

    // 1. Invalid token fails closed (401)
    const badAuth = await fetch(`${proxy.baseUrl}/api/internal/cloud-inference/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer bogus", "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-luna", messages: [] }),
    });
    expect(badAuth.status).toBe(401);

    // 2. Disallowed model fails closed (403)
    const badModel = await fetch(`${proxy.baseUrl}/api/internal/cloud-inference/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-opus-4", messages: [] }),
    });
    expect(badModel.status).toBe(403);

    // 3. Allowed model succeeds and injects real upstream key server-side
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

  it("maps connected subscription providers to expected migration harnesses and models", () => {
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
      runnerProvider: "antigravity",
      model: "gemini-2.5-pro",
    });
    expect(defaultMigrationTargetForProvider("xai", "subscription")).toEqual({
      adapterType: "grok_local",
      model: "grok-4",
    });
  });
});
