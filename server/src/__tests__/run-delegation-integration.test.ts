import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { DELEGATION_MAX_DEPTH } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runDelegationService, type EnqueueWakeupFn } from "../services/run-delegation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-delegation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("runDelegationService (integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-delegation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedOrg() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const ceoId = randomUUID();
    const devId = randomUUID();
    const peerId = randomUUID();
    await db.insert(agents).values([
      { id: ceoId, companyId, name: "CEO", role: "ceo", status: "running" },
      { id: devId, companyId, name: "Dev", role: "engineer", status: "idle", reportsTo: ceoId },
      { id: peerId, companyId, name: "Peer", role: "engineer", status: "idle" },
    ]);
    return { companyId, ceoId, devId, peerId };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status?: string;
    contextSnapshot?: Record<string, unknown>;
    parentRunId?: string;
    delegationStatus?: string;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status ?? "running",
      invocationSource: "on_demand",
      startedAt: new Date(),
      contextSnapshot: input.contextSnapshot ?? {},
      parentRunId: input.parentRunId,
      delegationStatus: input.delegationStatus,
    });
    return runId;
  }

  function buildService(overrides?: { enqueueWakeup?: EnqueueWakeupFn }) {
    const wakeCalls: Array<{ agentId: string; opts: Parameters<EnqueueWakeupFn>[1] }> = [];
    const enqueueWakeup: EnqueueWakeupFn =
      overrides?.enqueueWakeup ??
      (async (agentId, opts) => {
        wakeCalls.push({ agentId, opts });
        const [agent] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).limit(1);
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: agent!.companyId,
          agentId,
          status: "queued",
          invocationSource: "automation",
          contextSnapshot: opts?.contextSnapshot ?? {},
        });
        return { id: runId, status: "queued" };
      });

    const svc = runDelegationService(db, {
      enqueueWakeup,
      getRun: async (runId) => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
        return row ?? null;
      },
      cancelRun: async (runId, reason) => {
        const [row] = await db
          .update(heartbeatRuns)
          .set({ status: "cancelled", error: reason ?? "cancelled", finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(heartbeatRuns.id, runId))
          .returning();
        return row ?? null;
      },
    });
    return { svc, wakeCalls };
  }

  async function getRunRow(runId: string) {
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
    return row ?? null;
  }

  it("delegates wait:false, links parent/child, and stamps depth", async () => {
    const { companyId, ceoId, devId } = await seedOrg();
    const parentRunId = await seedRun({ companyId, agentId: ceoId });
    const { svc } = buildService();

    const result = await svc.delegateFromRun(parentRunId, ceoId, {
      targetAgentId: devId,
      task: "Build the login form",
      issueId: null,
      createChildIssue: false,
      childIssueTitle: null,
      wait: false,
      waitTimeoutSec: 120,
    });

    expect(result.delegationStatus).toBe("pending");
    expect(result.a2aTaskState).toBe("working");

    const child = await getRunRow(result.childRunId);
    expect(child?.parentRunId).toBe(parentRunId);
    expect(child?.delegationStatus).toBe("pending");
    expect((child?.contextSnapshot as Record<string, unknown>)?.delegationDepth).toBe(1);

    const parent = await getRunRow(parentRunId);
    expect(parent?.delegationStatus).toBe("pending");
    expect(parent?.livenessState).toBe("awaiting_delegation");
  });

  it("supports parallel fan-out and joins with a single continuation wake", async () => {
    const { companyId, ceoId, devId } = await seedOrg();
    const parentRunId = await seedRun({ companyId, agentId: ceoId });
    const { svc, wakeCalls } = buildService();

    const first = await svc.delegateFromRun(parentRunId, ceoId, {
      targetAgentId: devId,
      task: "first parallel task",
      issueId: null,
      createChildIssue: false,
      childIssueTitle: null,
      wait: false,
      waitTimeoutSec: 120,
    });
    const second = await svc.delegateFromRun(parentRunId, ceoId, {
      targetAgentId: devId,
      task: "second parallel task",
      issueId: null,
      createChildIssue: false,
      childIssueTitle: null,
      wait: false,
      waitTimeoutSec: 120,
    });
    expect(first.childRunId).not.toBe(second.childRunId);

    // Parent exits successfully while children run.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, parentRunId));
    wakeCalls.length = 0;

    // First child finishes: no join yet, no wake.
    const firstChild = await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", resultJson: { summary: "one done" }, finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, first.childRunId))
      .returning()
      .then((rows) => rows[0]!);
    await svc.handleChildRunCompleted(firstChild);
    expect(wakeCalls).toHaveLength(0);
    expect((await getRunRow(parentRunId))?.delegationStatus).toBe("pending");

    // Second child finishes: join settles the parent with ONE wake carrying all results.
    const secondChild = await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", resultJson: { summary: "two done" }, finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, second.childRunId))
      .returning()
      .then((rows) => rows[0]!);
    await svc.handleChildRunCompleted(secondChild);

    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]!.opts?.reason).toBe("delegation_child_completed");
    const results = (wakeCalls[0]!.opts?.contextSnapshot as Record<string, unknown>).delegationResults as unknown[];
    expect(results).toHaveLength(2);

    const parent = await getRunRow(parentRunId);
    expect(parent?.delegationStatus).toBe("completed");
  });

  it("returns the existing child for a repeated clientKey (idempotent retry)", async () => {
    const { companyId, ceoId, devId } = await seedOrg();
    const parentRunId = await seedRun({ companyId, agentId: ceoId });
    const { svc } = buildService();

    const first = await svc.delegateFromRun(parentRunId, ceoId, {
      targetAgentId: devId,
      task: "retry-safe task",
      issueId: null,
      createChildIssue: false,
      childIssueTitle: null,
      wait: false,
      waitTimeoutSec: 120,
      clientKey: "retry-1",
    });

    const retried = await svc.delegateFromRun(parentRunId, ceoId, {
      targetAgentId: devId,
      task: "retry-safe task",
      issueId: null,
      createChildIssue: false,
      childIssueTitle: null,
      wait: false,
      waitTimeoutSec: 120,
      clientKey: "retry-1",
    });

    expect(retried.childRunId).toBe(first.childRunId);
    expect((retried as { reused?: boolean }).reused).toBe(true);

    const children = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.parentRunId, parentRunId));
    expect(children).toHaveLength(1);
  });

  it("follow-up delegation resumes the prior child session", async () => {
    const { companyId, ceoId, devId } = await seedOrg();
    const parentRunId = await seedRun({ companyId, agentId: ceoId });
    const { svc, wakeCalls } = buildService();

    const first = await svc.delegateFromRun(parentRunId, ceoId, {
      targetAgentId: devId,
      task: "initial work",
      issueId: null,
      createChildIssue: false,
      childIssueTitle: null,
      wait: false,
      waitTimeoutSec: 120,
    });

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, first.childRunId));
    const firstChild = await getRunRow(first.childRunId);
    await svc.handleChildRunCompleted(firstChild!);

    wakeCalls.length = 0;
    const followUp = await svc.delegateFromRun(parentRunId, ceoId, {
      targetAgentId: devId,
      task: "please also add tests",
      issueId: null,
      createChildIssue: false,
      childIssueTitle: null,
      wait: false,
      waitTimeoutSec: 120,
      followUpToChildRunId: first.childRunId,
    });

    expect(followUp.childRunId).not.toBe(first.childRunId);
    expect(wakeCalls).toHaveLength(1);
    expect((wakeCalls[0]!.opts?.payload as Record<string, unknown>).resumeFromRunId).toBe(first.childRunId);
    const context = (await getRunRow(followUp.childRunId))?.contextSnapshot as Record<string, unknown>;
    expect(context.delegationFollowUpOfRunId).toBe(first.childRunId);
  });

  it("cancelDelegatedChild cancels one child and joins the rest", async () => {
    const { companyId, ceoId, devId } = await seedOrg();
    const parentRunId = await seedRun({ companyId, agentId: ceoId });
    const { svc } = buildService();

    const first = await svc.delegateFromRun(parentRunId, ceoId, {
      targetAgentId: devId,
      task: "will be cancelled",
      issueId: null,
      createChildIssue: false,
      childIssueTitle: null,
      wait: false,
      waitTimeoutSec: 120,
    });

    const cancelled = await svc.cancelDelegatedChild(parentRunId, first.childRunId, "changed my mind");
    expect(cancelled?.status).toBe("cancelled");
    expect((await getRunRow(first.childRunId))?.delegationStatus).toBe("cancelled");

    // Parent still running: join settles delegation as cancelled without a wake.
    const parent = await getRunRow(parentRunId);
    expect(parent?.delegationStatus).toBe("cancelled");
  });

  it("rejects delegation to a non-report", async () => {
    const { companyId, ceoId, peerId, devId } = await seedOrg();
    const devRunId = await seedRun({ companyId, agentId: devId });
    const { svc } = buildService();

    await expect(
      svc.delegateFromRun(devRunId, devId, {
        targetAgentId: peerId,
        task: "not allowed",
        issueId: null,
        createChildIssue: false,
        childIssueTitle: null,
        wait: false,
        waitTimeoutSec: 120,
      }),
    ).rejects.toMatchObject({ status: 403 });

    // CEO is also not a report of Dev (upward delegation denied).
    await expect(
      svc.delegateFromRun(devRunId, devId, {
        targetAgentId: ceoId,
        task: "upward",
        issueId: null,
        createChildIssue: false,
        childIssueTitle: null,
        wait: false,
        waitTimeoutSec: 120,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("enforces the delegation depth limit", async () => {
    const { companyId, ceoId, devId } = await seedOrg();
    const parentRunId = await seedRun({
      companyId,
      agentId: ceoId,
      contextSnapshot: { delegationDepth: DELEGATION_MAX_DEPTH },
    });
    const { svc } = buildService();

    await expect(
      svc.delegateFromRun(parentRunId, ceoId, {
        targetAgentId: devId,
        task: "too deep",
        issueId: null,
        createChildIssue: false,
        childIssueTitle: null,
        wait: false,
        waitTimeoutSec: 120,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("wait:true resolves via child-terminal notification without polling", async () => {
    const { companyId, ceoId, devId } = await seedOrg();
    const parentRunId = await seedRun({ companyId, agentId: ceoId });
    const { svc } = buildService();

    const delegatePromise = svc.delegateFromRun(parentRunId, ceoId, {
      targetAgentId: devId,
      task: "quick job",
      issueId: null,
      createChildIssue: false,
      childIssueTitle: null,
      wait: true,
      waitTimeoutSec: 30,
    });

    // Give the delegate call time to enqueue the child and start waiting.
    await vi.waitFor(async () => {
      const [child] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.parentRunId, parentRunId));
      expect(child).toBeTruthy();
    });

    const [child] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.parentRunId, parentRunId));
    const finishedChild = await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", resultJson: { summary: "done" }, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, child!.id))
      .returning()
      .then((rows) => rows[0]!);

    await svc.handleChildRunCompleted(finishedChild);

    const result = await delegatePromise;
    expect(result.timedOut).toBe(false);
    expect(result.delegationStatus).toBe("completed");
    expect(result.a2aTaskState).toBe("completed");

    const parent = await getRunRow(parentRunId);
    expect(parent?.delegationStatus).toBe("completed");
    expect(parent?.livenessState).toBe("advanced");
  }, 20_000);

  it("wakes the parent agent after child completes when parent already succeeded", async () => {
    const { companyId, ceoId, devId } = await seedOrg();
    const parentRunId = await seedRun({ companyId, agentId: ceoId, status: "succeeded", delegationStatus: "pending" });
    const childRunId = await seedRun({
      companyId,
      agentId: devId,
      status: "succeeded",
      parentRunId,
      delegationStatus: "pending",
    });
    const { svc, wakeCalls } = buildService();

    const child = await getRunRow(childRunId);
    await svc.handleChildRunCompleted(child!);

    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]!.agentId).toBe(ceoId);
    expect(wakeCalls[0]!.opts?.reason).toBe("delegation_child_completed");

    const parent = await getRunRow(parentRunId);
    expect(parent?.delegationStatus).toBe("completed");
  });

  it("does not wake the parent agent when the parent run was cancelled", async () => {
    const { companyId, ceoId, devId } = await seedOrg();
    const parentRunId = await seedRun({ companyId, agentId: ceoId, status: "cancelled", delegationStatus: "pending" });
    const childRunId = await seedRun({
      companyId,
      agentId: devId,
      status: "succeeded",
      parentRunId,
      delegationStatus: "pending",
    });
    const { svc, wakeCalls } = buildService();

    const child = await getRunRow(childRunId);
    await svc.handleChildRunCompleted(child!);

    expect(wakeCalls).toHaveLength(0);
    const parent = await getRunRow(parentRunId);
    expect(parent?.delegationStatus).toBe("cancelled");
  });

  it("cancelChildDelegations cancels children and settles the parent", async () => {
    const { companyId, ceoId, devId } = await seedOrg();
    const parentRunId = await seedRun({ companyId, agentId: ceoId, delegationStatus: "pending" });
    const childRunId = await seedRun({
      companyId,
      agentId: devId,
      status: "running",
      parentRunId,
      delegationStatus: "pending",
    });
    const { svc } = buildService();

    await svc.cancelChildDelegations(parentRunId, "Agent paused");

    const child = await getRunRow(childRunId);
    expect(child?.status).toBe("cancelled");
    expect(child?.delegationStatus).toBe("cancelled");

    const parent = await getRunRow(parentRunId);
    expect(parent?.delegationStatus).toBe("cancelled");
  });

  it("sweep settles a stale pending parent whose child already finished", async () => {
    const { companyId, ceoId, devId } = await seedOrg();
    const parentRunId = await seedRun({ companyId, agentId: ceoId, status: "succeeded", delegationStatus: "pending" });
    await seedRun({
      companyId,
      agentId: devId,
      status: "succeeded",
      parentRunId,
      delegationStatus: "pending",
    });
    const { svc, wakeCalls } = buildService();

    const outcome = await svc.sweepStalePendingDelegations();
    expect(outcome.settled).toBe(1);

    const parent = await getRunRow(parentRunId);
    expect(parent?.delegationStatus).toBe("completed");
    expect(wakeCalls).toHaveLength(1);
  });

  it("sweep repairs a pending parent with no children", async () => {
    const { companyId, ceoId } = await seedOrg();
    const parentRunId = await seedRun({ companyId, agentId: ceoId, status: "succeeded", delegationStatus: "pending" });
    const { svc } = buildService();

    const outcome = await svc.sweepStalePendingDelegations();
    expect(outcome.settled).toBe(1);

    const parent = await getRunRow(parentRunId);
    expect(parent?.delegationStatus).toBe("cancelled");
  });
});
