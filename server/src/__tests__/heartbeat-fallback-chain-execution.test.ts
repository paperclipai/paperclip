import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { getServerAdapter } from "../adapters/index.ts";
import type { ServerAdapterModule, AdapterExecutionResult } from "@paperclipai/adapter-utils/server";

vi.mock("../adapters/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapters/index.ts")>();
  return {
    ...actual,
    getServerAdapter: vi.fn(),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres fallback chain tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat execution fallback chain", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeEach(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fallback-chain-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function seedRunFixture(chainConfig: unknown[]) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PC",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fallback Coder",
      role: "engineer",
      status: "paused",
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-3-7-sonnet",
        adapterFallbackChain: chainConfig,
      },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: {},
      startedAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    return { companyId, agentId, runId, wakeupRequestId };
  }

  function mockAdapters(adapters: Record<string, ServerAdapterModule['execute']>) {
    vi.mocked(getServerAdapter).mockImplementation((type: string) => {
      const executeMock = adapters[type];
      if (!executeMock) throw new Error(`Adapter ${type} not mocked`);
      return {
        type,
        execute: executeMock,
        supportsLocalAgentJwt: false,
        testEnvironment: vi.fn(),
      } as unknown as ServerAdapterModule;
    });
  }

  it("completes normally without falling back if primary adapter succeeds", async () => {
    const { runId } = await seedRunFixture([
      { adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } }
    ]);
    
    const claudeExecute = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Success",
    } as AdapterExecutionResult);
    
    mockAdapters({ claude_local: claudeExecute });

    const heartbeat = heartbeatService(db);
    await heartbeat.executeRun(runId);

    expect(claudeExecute).toHaveBeenCalledOnce();
    
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("succeeded");
    
    // Check events: should NOT have fallback records
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    const fallbackDecisions = events.filter(e => e.eventType === "adapter.fallback.decision");
    
    expect(fallbackDecisions).toHaveLength(1);
    expect((fallbackDecisions[0]?.payload as Record<string, unknown>)?.fallbackAdapterType).toBe("codex_local");
    expect(fallbackDecisions[0]?.level).toBe("info"); // no retry needed
  });

  it("falls back to the first available adapter when primary is rate limited", async () => {
    const { runId } = await seedRunFixture([
      { adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } }
    ]);
    
    const claudeExecute = vi.fn().mockResolvedValue({
      exitCode: 1,
      errorCode: "claude_rate_limited",
      signal: null,
      timedOut: false,
      summary: "Rate limited",
    } as AdapterExecutionResult);

    const codexExecute = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Success on fallback",
    } as AdapterExecutionResult);
    
    mockAdapters({ 
      claude_local: claudeExecute,
      codex_local: codexExecute 
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.executeRun(runId);

    expect(claudeExecute).toHaveBeenCalledOnce();
    expect(codexExecute).toHaveBeenCalledOnce();
    
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("succeeded");
    
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    const fallbacks = events.filter(e => e.eventType === "adapter.fallback");
    
    expect(fallbacks).toHaveLength(1);
    expect((fallbacks[0]?.payload as Record<string, unknown>)?.to).toBe("codex_local");
  });

  it("exhausts the entire fallback chain if everything is rate limited", async () => {
    const { runId } = await seedRunFixture([
      { adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } },
      { adapterType: "gemini_local", adapterConfig: { model: "gemini-3.1-pro" } }
    ]);
    
    const rateLimitResponse = {
      exitCode: 1,
      errorCode: "claude_rate_limited",
      signal: null,
      timedOut: false,
      summary: "Rate limited",
    } as AdapterExecutionResult;

    const claudeExecute = vi.fn().mockResolvedValue(rateLimitResponse);
    const codexExecute = vi.fn().mockResolvedValue(rateLimitResponse);
    const geminiExecute = vi.fn().mockResolvedValue(rateLimitResponse); // Last one also fails
    
    mockAdapters({ 
      claude_local: claudeExecute,
      codex_local: codexExecute,
      gemini_local: geminiExecute
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.executeRun(runId);

    expect(claudeExecute).toHaveBeenCalledOnce();
    expect(codexExecute).toHaveBeenCalledOnce();
    expect(geminiExecute).toHaveBeenCalledOnce();
    
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("claude_rate_limited"); 
    
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    const fallbacks = events.filter(e => e.eventType === "adapter.fallback");
    
    expect(fallbacks).toHaveLength(2);
    expect((fallbacks[0]?.payload as Record<string, unknown>)?.to).toBe("codex_local");
    expect((fallbacks[1]?.payload as Record<string, unknown>)?.to).toBe("gemini_local");
  });

  it("continues from a failed codex fallback to a later gemini fallback", async () => {
    const { runId } = await seedRunFixture([
      { adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } },
      { adapterType: "gemini_local", adapterConfig: { model: "gemini-2.5-flash" } },
    ]);

    const claudeExecute = vi.fn().mockResolvedValue({
      exitCode: 1,
      errorCode: "claude_rate_limited",
      signal: null,
      timedOut: false,
      summary: "Primary rate limited",
    } as AdapterExecutionResult);

    const codexExecute = vi.fn().mockResolvedValue({
      exitCode: 1,
      errorCode: "adapter_failed",
      errorMessage: "Codex command failed",
      signal: null,
      timedOut: false,
      summary: "Codex failed",
    } as AdapterExecutionResult);

    const geminiExecute = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Gemini succeeded",
    } as AdapterExecutionResult);

    mockAdapters({
      claude_local: claudeExecute,
      codex_local: codexExecute,
      gemini_local: geminiExecute,
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.executeRun(runId);

    expect(claudeExecute).toHaveBeenCalledOnce();
    expect(codexExecute).toHaveBeenCalledOnce();
    expect(geminiExecute).toHaveBeenCalledOnce();

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("succeeded");

    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    const fallbacks = events.filter((e) => e.eventType === "adapter.fallback");

    expect(fallbacks).toHaveLength(2);
    expect((fallbacks[0]?.payload as Record<string, unknown>)?.to).toBe("codex_local");
    expect((fallbacks[1]?.payload as Record<string, unknown>)?.to).toBe("gemini_local");
  });

  it("continues to the next fallback when a fallback adapter throws", async () => {
    const { runId } = await seedRunFixture([
      { adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } },
      { adapterType: "gemini_local", adapterConfig: { model: "gemini-2.5-flash" } },
    ]);

    const claudeExecute = vi.fn().mockResolvedValue({
      exitCode: 1,
      errorCode: "claude_rate_limited",
      signal: null,
      timedOut: false,
      summary: "Primary rate limited",
    } as AdapterExecutionResult);

    const codexExecute = vi.fn().mockRejectedValue(new Error("Command not found in PATH: \"codex-missing\""));

    const geminiExecute = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Gemini succeeded",
    } as AdapterExecutionResult);

    mockAdapters({
      claude_local: claudeExecute,
      codex_local: codexExecute,
      gemini_local: geminiExecute,
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.executeRun(runId);

    expect(claudeExecute).toHaveBeenCalledOnce();
    expect(codexExecute).toHaveBeenCalledOnce();
    expect(geminiExecute).toHaveBeenCalledOnce();

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("succeeded");
  });
});
