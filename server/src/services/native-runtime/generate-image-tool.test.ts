import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, costEvents, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { aiConnectionService } from "../ai-connections.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { imageGenerationBindingForRun, priceGeneratedImage, requestOpenAiImage } from "./generate-image-tool.js";

// One transparent 1x1 PNG. The handler only needs real PNG bytes to save.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const OPENAI_KEY = "sk-agent-existing-provider-key";

describe("generate_image for OpenAI API-key Codex agents (N-12)", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>> | null = null;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const workspaces: string[] = [];

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-image-tool-home-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "image-tool-fixture");
    temporary = await startRecoveryPostgres("paperclip-image-tool-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: "alice", name: "Alice", email: "alice@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
    for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** An onboarding-style company: one Codex agent running on an OpenAI API key. */
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pixel Bakery", issuePrefix: `PX${companyId.slice(0, 4).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Head baker", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" }, status: "active" });
    const connection = await aiConnectionService(db).save(companyId, "alice", {
      provider: "openai", method: "api_key", name: "OpenAI", ownership: "shared",
      apiKey: OPENAI_KEY, agentIds: [], allAgents: true,
    } as never, OPENAI_KEY);
    await db.insert(issues).values({ id: issueId, companyId, title: "Create printable cake menu and logo",
      status: "in_progress", workMode: "standard", assigneeAgentId: agentId });
    const aiConnection = { connectionId: connection.connectionId, grantId: connection.grantId,
      provider: "openai", method: "api_key", mode: "shared", responsibleUserId: "alice" };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", responsibleUserId: "alice",
      contextSnapshot: { issueId, aiConnection } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const workspaceRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-image-tool-ws-")));
    workspaces.push(workspaceRoot);
    const binding = { companyId, agentId, issueId, runId, workspaceRoot,
      imageGeneration: { connectionId: connection.connectionId, grantId: connection.grantId } };
    return { ...binding, binding, aiConnection };
  }

  function stubOpenAiImages() {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      created: 1, data: [{ b64_json: PNG.toString("base64") }],
      usage: { input_tokens: 50, output_tokens: 1000, input_tokens_details: { text_tokens: 50, image_tokens: 0 } },
    }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_image_1" } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("lets an API-key Codex agent make an image with its existing OpenAI key, saved in its workspace and billed", async () => {
    const f = await fixture();
    const fetchMock = stubOpenAiImages();
    const authority = new PaperclipRunnerToolAuthority(db, f.binding as never);

    expect(authority.definitions().map(tool => tool.name)).toContain("generate_image");

    const callId = randomUUID();
    const result = await authority.execute({ tool: "generate_image", callId,
      arguments: { prompt: "A warm, playful cake logo for Pixel Bakery", name: "pixel-bakery-logo" } }) as Record<string, unknown>;

    // The trusted server made the call with the agent's existing key; no second key.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/images/generations");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${OPENAI_KEY}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-image-2", prompt: "A warm, playful cake logo for Pixel Bakery" });

    // The PNG lands in the workspace under the returned relative path.
    expect(result).toMatchObject({ outcome: "completed", contentType: "image/png", byteSize: PNG.length,
      sha256: createHash("sha256").update(PNG).digest("hex") });
    expect(String(result.path)).toMatch(/^pixel-bakery-logo-[a-f0-9]{8}\.png$/);
    expect(await readFile(path.join(f.workspaceRoot, String(result.path)))).toEqual(PNG);
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);

    // Spend is recorded on the budget ledger for this agent, run and task.
    const costs = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.runId));
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ agentId: f.agentId, issueId: f.issueId, provider: "openai", biller: "openai",
      billingType: "metered_api", model: "gpt-image-2", costStatus: "estimated", inputTokens: 50, outputTokens: 1000,
      providerRequestId: "req_image_1" });
    // 50 text tokens at $5/M + 1000 image output tokens at $30/M = $0.03025.
    expect(Number(costs[0]!.costCents)).toBeCloseTo(3.025, 6);

    const activity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "runner.image_generate")));
    expect(activity.map(row => (row.details as Record<string, unknown>).outcome)).toEqual(expect.arrayContaining(["started", "completed"]));
    expect(JSON.stringify(activity)).not.toContain(OPENAI_KEY);

    // A provider retry of the same call replays the receipt instead of paying again.
    const replay = await authority.execute({ tool: "generate_image", callId,
      arguments: { prompt: "A warm, playful cake logo for Pixel Bakery", name: "pixel-bakery-logo" } });
    expect(replay).toEqual(result);
    expect(await authority.recover({ tool: "generate_image", callId,
      arguments: { prompt: "A warm, playful cake logo for Pixel Bakery", name: "pixel-bakery-logo" } })).toEqual({ result });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.runId))).toHaveLength(1);
  });

  it("is not offered without a server-verified OpenAI API-key binding", async () => {
    const f = await fixture();
    const { imageGeneration: _omitted, ...withoutBinding } = f.binding;
    const authority = new PaperclipRunnerToolAuthority(db, withoutBinding);
    expect(authority.definitions().map(tool => tool.name)).not.toContain("generate_image");
    await expect(authority.execute({ tool: "generate_image", callId: randomUUID(), arguments: { prompt: "logo" } }))
      .rejects.toThrow();
  });

  it("refuses before calling OpenAI once a budget hard-stop has paused the agent", async () => {
    const f = await fixture();
    const fetchMock = stubOpenAiImages();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const authority = new PaperclipRunnerToolAuthority(db, f.binding as never);
    await expect(authority.execute({ tool: "generate_image", callId: randomUUID(), arguments: { prompt: "logo" } }))
      .rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(f.workspaceRoot)).toEqual([]);
  });

  it("still records the spend when a paid image cannot be saved", async () => {
    const f = await fixture();
    const fetchMock = stubOpenAiImages();
    await rm(f.workspaceRoot, { recursive: true, force: true });
    const authority = new PaperclipRunnerToolAuthority(db, f.binding as never);
    const callId = randomUUID();
    await expect(authority.execute({ tool: "generate_image", callId, arguments: { prompt: "logo" } })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.runId))).toHaveLength(1);
    // The failed call is settled: a retry with the same call ID neither pays nor claims success.
    await expect(authority.execute({ tool: "generate_image", callId, arguments: { prompt: "logo" } }))
      .rejects.toThrow("could not be saved");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses when the run's AI connection is no longer an active OpenAI API key", async () => {
    const f = await fixture();
    const fetchMock = stubOpenAiImages();
    const authority = new PaperclipRunnerToolAuthority(db, { ...f.binding,
      imageGeneration: { connectionId: f.binding.imageGeneration.connectionId, grantId: randomUUID() } } as never);
    await expect(authority.execute({ tool: "generate_image", callId: randomUUID(), arguments: { prompt: "logo" } }))
      .rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("generate_image helpers", () => {
  const aiConnection = { connectionId: "c1", grantId: "g1", provider: "openai", method: "api_key" };

  it("binds only native Codex runs on a direct OpenAI API-key connection", () => {
    expect(imageGenerationBindingForRun({ providerKind: "codex", contextSnapshot: { aiConnection } }))
      .toEqual({ connectionId: "c1", grantId: "g1" });
    // ChatGPT sign-in keeps Codex's own image tool; other harnesses and routed keys get nothing.
    expect(imageGenerationBindingForRun({ providerKind: "codex", contextSnapshot: { aiConnection: { ...aiConnection, method: "subscription" } } })).toBeUndefined();
    expect(imageGenerationBindingForRun({ providerKind: "acpx", contextSnapshot: { aiConnection } })).toBeUndefined();
    expect(imageGenerationBindingForRun({ providerKind: "codex", contextSnapshot: { aiConnection: { ...aiConnection, provider: "openrouter" } } })).toBeUndefined();
    expect(imageGenerationBindingForRun({ providerKind: "codex", contextSnapshot: { aiConnection, aiRouterSelection: { model: "x" } } })).toBeUndefined();
    expect(imageGenerationBindingForRun({ providerKind: "codex", contextSnapshot: {} })).toBeUndefined();
  });

  it("prices gpt-image-2 from the reviewed rate card", () => {
    const price = priceGeneratedImage({ bytes: PNG, model: "gpt-image-2", providerRequestId: null,
      usage: { textInputTokens: 1_000_000, imageInputTokens: 1_000_000, outputTokens: 1_000_000 } });
    expect(price.costUsd).toBe("43.000000000");
    expect(price.pricingProvenance).toMatchObject({ source: "rate_card", version: "openai-image-standard-2026-11-06" });
  });

  it("reports provider errors without echoing the key and rejects non-PNG data", async () => {
    const failing = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Billing hard limit reached" } }), { status: 400 }));
    await expect(requestOpenAiImage({ prompt: "logo", size: "1024x1024", quality: "auto", apiKey: OPENAI_KEY }, failing as never))
      .rejects.toThrow("OpenAI image generation failed: Billing hard limit reached");
    const notPng = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("<svg/>").toString("base64") }] }), { status: 200 }));
    await expect(requestOpenAiImage({ prompt: "logo", size: "1024x1024", quality: "auto", apiKey: OPENAI_KEY }, notPng as never))
      .rejects.toThrow("invalid PNG");
  });
});
