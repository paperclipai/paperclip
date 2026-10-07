import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { retireExecutionReplayHoldOnStatusRestore } from "../services/execution-recovery-resolution.ts";
import { getExecutionBlocker } from "../services/execution-blocker.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres replay-hold status-restore tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("execution replay hold status restore", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-replay-hold-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(input?: { status?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Restore Bot",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Storm-scrambled task",
      status: input?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function seedHeldAction(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
    replay?: string;
    workspaceRestoreFailure?: string | null;
  }) {
    const sourceRunId = randomUUID();
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId: input.companyId,
        sourceIssueId: input.issueId,
        kind: "active_run_watchdog",
        status: input.status ?? "resolved",
        ownerType: "agent",
        ownerAgentId: input.agentId,
        cause: "uncertain_provider_action",
        fingerprint: `storm-${input.issueId}-${randomUUID().slice(0, 8)}`,
        evidence: {
          policy: "preserve_without_replay_v1",
          runId: sourceRunId,
          automaticRecovery: {
            policy: "preserve_without_replay_v1",
            runId: sourceRunId,
            replay: input.replay ?? "blocked",
            actionOutcome: "unknown",
            recordedAt: "2026-04-11T12:00:00.000Z",
          },
          ...(input.workspaceRestoreFailure
            ? { workspaceRestoreFailure: input.workspaceRestoreFailure }
            : {}),
        },
        nextAction: "Automatic recovery stopped. Recorded work is preserved.",
        outcome: "cancelled",
        resolvedAt: new Date("2026-04-11T12:00:00.000Z"),
      })
      .returning();
    return { action, sourceRunId };
  }

  it("retires the resolved no-replay hold on a user status restore and leaves an audit row", async () => {
    const seed = await seedIssue({ status: "blocked" });
    const { action } = await seedHeldAction(seed);
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();

    const result = await retireExecutionReplayHoldOnStatusRestore(db, {
      companyId: seed.companyId,
      issueId: seed.issueId,
      fromStatus: "blocked",
      toStatus: "in_progress",
      actorId: "board-operator",
      now: new Date("2026-04-11T13:00:00.000Z"),
    });

    expect(result.retiredRecoveryActionIds).toEqual([action.id]);

    const [folded] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id))
      .then((rows) => rows);
    // The hold folds to a reconciled marker; the original evidence survives.
    expect(folded.evidence).toMatchObject({
      policy: "preserve_without_replay_v1",
      automaticRecovery: {
        policy: "preserve_without_replay_v1",
        replay: "user_status_restore",
        actionOutcome: "unknown",
        recordedAt: "2026-04-11T12:00:00.000Z",
        clearedAt: "2026-04-11T13:00:00.000Z",
        clearedBy: "board-operator",
        fromStatus: "blocked",
        toStatus: "in_progress",
      },
    });
    expect(folded.evidence.automaticRecovery).not.toMatchObject({ replay: "blocked" });

    // The zombie state is gone: no execution blocker remains, so wakes and
    // monitors on the restored issue are admitted again.
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).toBeNull();

    const settled = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, seed.issueId))
      .then((rows) => rows.find((row) => row.action === "issue.execution_recovery_settled") ?? null);
    expect(settled).not.toBeNull();
    expect(settled?.details).toMatchObject({
      continuation: "user_status_restore",
      fromStatus: "blocked",
      toStatus: "in_progress",
      replayHoldRetired: true,
      recoveryActionIds: [action.id],
    });

    // Idempotent: a second restore finds nothing left to fold.
    const second = await retireExecutionReplayHoldOnStatusRestore(db, {
      companyId: seed.companyId,
      issueId: seed.issueId,
      fromStatus: "in_progress",
      toStatus: "todo",
      actorId: "board-operator",
    });
    expect(second.retiredRecoveryActionIds).toEqual([]);
  });

  it("never retires unsafe-workspace holds or still-active recovery actions", async () => {
    const seed = await seedIssue({ status: "in_progress" });
    await seedHeldAction({ ...seed, workspaceRestoreFailure: "restore_unsafe_archive" });
    await seedHeldAction({ ...seed, status: "active", replay: "blocked" });

    const result = await retireExecutionReplayHoldOnStatusRestore(db, {
      companyId: seed.companyId,
      issueId: seed.issueId,
      fromStatus: "in_progress",
      toStatus: "todo",
      actorId: "board-operator",
    });

    expect(result.retiredRecoveryActionIds).toEqual([]);

    const [unsafeHold] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, seed.issueId))
      .then((rows) => rows.filter((row) => row.evidence.workspaceRestoreFailure === "restore_unsafe_archive"));
    expect(unsafeHold.evidence.automaticRecovery).toMatchObject({ replay: "blocked" });

    // The unsafe-workspace execution hold still blocks wakes after the
    // status change, and the active recovery action keeps its own flow.
    const blocker = await getExecutionBlocker(db, seed.companyId, seed.issueId);
    expect(blocker).not.toBeNull();
  });

  it("leaves other issues' holds untouched", async () => {
    const held = await seedIssue({ status: "blocked" });
    await seedHeldAction(held);
    const restored = await seedIssue({ status: "blocked" });

    const result = await retireExecutionReplayHoldOnStatusRestore(db, {
      companyId: restored.companyId,
      issueId: restored.issueId,
      fromStatus: "blocked",
      toStatus: "in_progress",
      actorId: "board-operator",
    });

    expect(result.retiredRecoveryActionIds).toEqual([]);
    const [stillHeld] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, held.issueId))
      .then((rows) => rows);
    expect(stillHeld.evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
    expect(await getExecutionBlocker(db, held.companyId, held.issueId)).not.toBeNull();
  });
});
