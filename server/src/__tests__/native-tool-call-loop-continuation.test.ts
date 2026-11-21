import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { ToolCallLoopError, toolCallLoopContinuationKey } from "../services/native-runtime/repeated-tool-failure-guard.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "Tool-call loop continuation test run.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping tool-call loop continuation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("the continuation of a turn stopped by a tool-call loop", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-call-loop-continuation-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  it("keeps its own keyed wake when a comment wake is already deferred behind the looping run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Loop Co", issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Looper", role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Describe the subtasks", status: "todo", priority: "medium",
      assigneeAgentId: agentId, responsibleUserId: "responsible-user",
    });

    let finishLoopingRun!: () => void;
    const loopingRunFinished = new Promise<void>((resolve) => { finishLoopingRun = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await loopingRunFinished;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Stopped after a tool-call loop.", provider: "test", model: "test-model" };
    });

    const loopingRun = await heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId }, contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    expect(loopingRun).not.toBeNull();
    await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(1), { timeout: 30_000 });

    const [commentWake] = await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "automation", triggerDetail: "system", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "responsible-user",
      payload: { issueId, _paperclipWakeContext: { issueId, wakeReason: "issue_commented" } },
    }).returning();

    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId: loopingRun!.id, workMode: "standard" });
    await authority.scheduleToolCallLoopContinuation(new ToolCallLoopError("call_api", 6, 6, ["operationId", "pathParams"], 400, "refused"));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });

    const key = toolCallLoopContinuationKey(loopingRun!.id);
    const keyed = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, key),
    ));
    expect(keyed.some((wake) => wake.status === "deferred_issue_execution" && wake.id !== commentWake!.id)).toBe(true);
    expect(keyed.every((wake) => !["skipped", "failed", "cancelled"].includes(wake.status))).toBe(true);
    const [comment] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, commentWake!.id));
    expect(comment).toMatchObject({ status: "deferred_issue_execution", coalescedCount: 0, idempotencyKey: null });

    finishLoopingRun();
    await vi.waitFor(async () => {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(runs.some((run) => run.id !== loopingRun!.id && run.contextSnapshot?.livenessContinuationReason === "agent_tool_call_loop"
        && run.contextSnapshot?.forceFreshSession === true)).toBe(true);
    }, { timeout: 30_000 });
  }, 90_000);
});
