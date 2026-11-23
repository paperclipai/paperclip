import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  issueRelations, issueTreeHolds, issueTreeHoldMembers,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { claimNativeSessionResumptions, dispatchNativeSessionResumptions } from "./native-finalization-reconciler.js";
import { stageNativeRunnerWakeAttachments } from "./native-runner-file-handoff.js";

describe("native recovery execution binding", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-resume-binding-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => temporary?.cleanup());

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery binding", issuePrefix: "N" + companyId.replaceAll("-", "").slice(0, 6).toUpperCase() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Recovery owner", status: "idle", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Resume original work", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, issueId, nativeIssueId: issueId, status: "failed", runtimeMode: "native",
      finishedAt: new Date(), contextSnapshot: { issueId }, runnerProfileJson: {
        nativeExecutionInput: { schema: "paperclip.native-execution-input.v1", binding: { runId, companyId, agentId, issueId, executionWorkspaceId: runId } },
        sessionCheckpoint: { sessionId: "provider-session", providerSessionId: "provider-session", identity: { runId, companyId, agentId, issueId } },
      },
    });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "retryable_failure", attempt: 1, nextAttemptAt: new Date(0) });
    return { companyId, agentId, issueId, runId };
  }

  it("restores the original execution before the real attachment authorization gate", async () => {
    const f = await fixture();
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "owner", runIds: [f.runId] })).toHaveLength(1);
    const staged = await stageNativeRunnerWakeAttachments({ db, binding: {
      ...f, workspaceRoot: "/remote/workspace", executionTargetKind: "remote",
    } });
    expect(staged.attachments).toEqual([]);
    await staged.cleanup();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({
      executionRunId: f.runId, executionAgentNameKey: "recovery owner", status: "in_progress", assigneeAgentId: f.agentId,
    });
  });

  it.each(["execution", "checkout", "queued"] as const)("does not replace another %s owner", async (kind) => {
    const f = await fixture();
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      status: kind === "queued" ? "queued" : "failed", runtimeMode: "legacy", contextSnapshot: { issueId: f.issueId } });
    if (kind !== "queued") await db.update(issues).set(kind === "execution"
      ? { executionRunId: otherRunId } : { checkoutRunId: otherRunId }).where(eq(issues.id, f.issueId));
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "stale", runIds: [f.runId] })).toEqual([]);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "retryable_failure", leaseOwner: null });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("failed");
  });

  it.each(["done", "cancelled", "blocked"])("preserves a task moved to %s", async status => {
    const f = await fixture();
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "stale", runIds: [f.runId] })).toEqual([]);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status, executionRunId: null });
  });

  it("does not recover work after reassignment", async () => {
    const f = await fixture();
    const nextAgent = randomUUID();
    await db.insert(agents).values({ id: nextAgent, companyId: f.companyId, name: "New owner", status: "idle" });
    await db.update(issues).set({ assigneeAgentId: nextAgent }).where(eq(issues.id, f.issueId));
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "stale", runIds: [f.runId] })).toEqual([]);
  });

  it("preserves an agent pause", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "stale", runIds: [f.runId] })).toEqual([]);
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0].status).toBe("paused");
  });

  it("waits for a first-class dependency", async () => {
    const f = await fixture();
    const blocker = randomUUID();
    await db.insert(issues).values({ id: blocker, companyId: f.companyId, title: "Unfinished prerequisite", status: "todo" });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker, relatedIssueId: f.issueId, type: "blocks" });
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "stale", runIds: [f.runId] })).toEqual([]);
  });

  it("preserves a task-tree pause hold", async () => {
    const f = await fixture();
    const hold = randomUUID();
    await db.insert(issueTreeHolds).values({ id: hold, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause" });
    await db.insert(issueTreeHoldMembers).values({ holdId: hold, companyId: f.companyId, issueId: f.issueId,
      issueTitle: "Paused work", issueStatus: "in_progress" });
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "stale", runIds: [f.runId] })).toEqual([]);
    expect((await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, hold)))[0].status).toBe("active");
  });

  it.each(["run", "issue"])("preserves a recorded native %s stop", async scope => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ resultJson: { nativeCancellation: { scope, dispatchState: "acknowledged" } } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "stale", runIds: [f.runId] })).toEqual([]);
  });

  it("preserves operator cancellation when terminal status was overwritten", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ resultJson: { cancellation: {
      source: "operator", expected: true, initiator: { type: "user" }, reason: "Stop", recordedAt: new Date().toISOString(),
    } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "stale", runIds: [f.runId] })).toEqual([]);
  });

  it("does not revive a superseded source", async () => {
    const f = await fixture();
    await db.update(nativeRunFinalizations).set({ failureDetail: { successorRunId: randomUUID() } })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "stale", runIds: [f.runId] })).toEqual([]);
  });

  it.each(["pause", "dependency"])("keeps a %s wait from starving the next bounded claim", async kind => {
    const held = await fixture();
    const eligible = await fixture();
    if (kind === "pause") {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, held.agentId));
    } else {
      const blocker = randomUUID();
      await db.insert(issues).values({ id: blocker, companyId: held.companyId, title: "Waiting prerequisite", status: "todo" });
      await db.insert(issueRelations).values({ companyId: held.companyId, issueId: blocker, relatedIssueId: held.issueId, type: "blocks" });
    }
    const now = new Date();
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(1) })
      .where(eq(nativeRunFinalizations.runId, eligible.runId));
    const input = { db, runnerInstanceId: "owner", runIds: [held.runId, eligible.runId], limit: 1, now };
    const first = await claimNativeSessionResumptions(input);
    const second = await claimNativeSessionResumptions(input);
    expect([...first, ...second].map(claim => claim.runId)).toEqual([eligible.runId]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, held.runId)))[0].status).toBe("failed");
  });

  it.each(["task", "coordinator"])("dispatches earlier claims when a later %s lock times out", async kind => {
    const first = await fixture();
    const locked = await fixture();
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(1) })
      .where(eq(nativeRunFinalizations.runId, locked.runId));
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      if (kind === "task") await tx.select().from(issues).where(eq(issues.id, locked.issueId)).for("update");
      else await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, locked.runId)).for("update");
      acquired();
      await wait;
    });
    try {
      await ready;
      const dispatch = vi.fn();
      const claims = await dispatchNativeSessionResumptions({ db, runnerInstanceId: "owner",
        runIds: [first.runId, locked.runId], dispatch });
      expect(claims.map(claim => claim.runId)).toEqual([first.runId]);
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(claims[0]);
    } finally {
      release();
      await blocker;
    }
  }, 15_000);

  it.each(["pause", "dependency"])("reaches undated retries past %s waits at real sweep intervals", async kind => {
    const held = await fixture();
    const eligible = await fixture();
    if (kind === "pause") {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, held.agentId));
    } else {
      const blocker = randomUUID();
      await db.insert(issues).values({ id: blocker, companyId: held.companyId, title: "Waiting prerequisite", status: "todo" });
      await db.insert(issueRelations).values({ companyId: held.companyId, issueId: blocker, relatedIssueId: held.issueId, type: "blocks" });
    }
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: null })
      .where(eq(nativeRunFinalizations.runId, eligible.runId));
    const now = Date.now();
    const claims = [];
    for (const offset of [0, 30_000, 60_000]) claims.push(...await claimNativeSessionResumptions({
      db, runnerInstanceId: "owner", runIds: [held.runId, eligible.runId], limit: 1, now: new Date(now + offset),
    }));
    expect(claims.map(claim => claim.runId)).toEqual([eligible.runId]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, held.runId)))[0].status).toBe("failed");
  });

  it("admits only one recovering run for a task", async () => {
    const f = await fixture();
    const second = randomUUID();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(heartbeatRuns).values({ ...source, id: second, runnerProfileJson: {
      ...source.runnerProfileJson, nativeExecutionInput: { binding: { runId: second } },
    } });
    await db.insert(nativeRunFinalizations).values({ runId: second, companyId: f.companyId, issueId: f.issueId, phase: "retryable_failure", attempt: 1 });
    const results = await Promise.all([f.runId, second].map(runId => claimNativeSessionResumptions({ db, runnerInstanceId: "owner", runIds: [runId] })));
    expect(results.flat()).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(results.flat()[0]!.runId);
  });
});
