import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  deliveryPolicies,
  deliveryRepositories,
  deliveryUnitIssues,
  deliveryUnits,
  heartbeatRuns,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  classifyNativeDeliveryHold,
  classifyNativeDeliveryWait,
  getNativeDeliveryHold,
  getNativeDeliveryWait,
  listNativeDeliveryWaits,
} from "../services/delivery/native-delivery-wait.js";
import { collectDispositionRepairSourceState } from "../services/recovery/disposition-repair.js";
import { classifyIssueGraphLiveness } from "../services/recovery/issue-graph-liveness.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres native delivery wait tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HEAD = "a".repeat(40);

/**
 * Native GitHub delivery is an owned waiting path. These regressions pin the
 * boundary: a persisted unit under an enabled, unpaused policy keeps the review
 * alive without a manufactured confirmation, and every operator/worker gate
 * (missing, disabled, or paused policy, paused unit, terminal unit, human
 * blocker) keeps its ordinary precedence.
 */
describeEmbeddedPostgres("native delivery wait", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-delivery-wait-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementation Agent",
      role: "engineer",
      status: "idle",
    });
    return agentId;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Delivery Wait Co",
      issuePrefix: `NDW${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = await seedAgent(companyId);
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Widget", status: "in_progress" });
    const [repository] = await db.insert(deliveryRepositories).values({
      companyId,
      owner: "acme",
      name: "widget",
      githubRepositoryId: `repo-${companyId}`,
      defaultBranch: "main",
    }).returning();
    return { companyId, agentId, projectId, repositoryId: repository!.id };
  }

  async function seedIssue(
    seeded: { companyId: string; agentId: string; projectId: string },
    input: { status?: string; title?: string } = {},
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      title: input.title ?? "Widget work",
      status: input.status ?? "in_review",
      priority: "medium",
      assigneeAgentId: seeded.agentId,
    });
    return issueId;
  }

  async function seedPolicy(
    seeded: { companyId: string; projectId: string; repositoryId: string },
    overrides: Partial<typeof deliveryPolicies.$inferInsert> = {},
  ) {
    const [policy] = await db.insert(deliveryPolicies).values({
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      repositoryId: seeded.repositoryId,
      targetBranch: "main",
      enabled: true,
      paused: false,
      requireIndependentApproval: true,
      ...overrides,
    }).returning();
    return policy!;
  }

  async function seedUnit(
    seeded: { companyId: string; agentId: string; projectId: string; repositoryId: string },
    issueId: string,
    overrides: Partial<typeof deliveryUnits.$inferInsert> = {},
  ) {
    const [unit] = await db.insert(deliveryUnits).values({
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      repositoryId: seeded.repositoryId,
      primaryIssueId: issueId,
      targetBranch: "main",
      sourceBranch: "delivery/widget",
      headSha: HEAD,
      status: "in_review",
      prNumber: 54,
      prUrl: "https://github.com/acme/widget/pull/54",
      ownerAgentId: seeded.agentId,
      artifactReady: true,
      ...overrides,
    }).returning();
    await db.insert(deliveryUnitIssues).values({
      companyId: seeded.companyId,
      unitId: unit!.id,
      issueId,
      role: "primary",
    });
    return unit!;
  }

  function deliveryApp(companyId: string, agentId: string, runId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", source: "agent_key", companyId, agentId, runId };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  async function seedRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  async function routeRequest(
    seeded: { companyId: string; agentId: string },
    runId: string,
    issueId: string,
    status: string,
  ) {
    return request(deliveryApp(seeded.companyId, seeded.agentId, runId))
      .patch(`/api/issues/${issueId}`)
      .send({ status });
  }

  async function seedHandoffRequired(companyId: string, issueId: string, agentId: string) {
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: issueId,
      agentId,
      runId: null,
      details: { sourceRunId: randomUUID(), detectedProgressSummary: "opened a pull request" },
    });
  }

  describe("classifyNativeDeliveryWait", () => {
    const unit = {
      id: "unit-1",
      status: "in_review",
      repositoryId: "repo-1",
      targetBranch: "main",
      pausedAt: null,
      blocker: null,
    };
    const policy = { id: "policy-1", enabled: true, paused: false, repositoryId: "repo-1" };

    it("claims an open unit under an enabled, unpaused policy for the controller", () => {
      expect(classifyNativeDeliveryWait({ unit, policy })).toEqual({
        kind: "wait",
        blocker: null,
        nextActor: "controller",
      });
    });

    it("points a controller-owned blocker at the implementation owner's bounded repair wake", () => {
      expect(classifyNativeDeliveryWait({
        unit: { ...unit, status: "blocked", blocker: { reasonCode: "review_blocking_findings", message: "blocking" } },
        policy,
      })).toEqual({
        kind: "wait",
        blocker: { reasonCode: "review_blocking_findings", message: "blocking", owner: null, nextAction: null },
        nextActor: "implementation_owner",
      });
    });

    it("keeps remote review and approval waits separate from implementation repair", () => {
      const waiting = { ...unit, status: "blocked", blocker: { reasonCode: "review_pending" } };
      expect(classifyNativeDeliveryWait({ unit: waiting, policy })).toMatchObject({
        kind: "wait",
        nextActor: "controller",
      });
      waiting.blocker.reasonCode = "review_approval_required";
      expect(classifyNativeDeliveryWait({ unit: waiting, policy })).toMatchObject({
        kind: "wait",
        nextActor: "controller",
      });
      waiting.blocker.reasonCode = "review_blocking_findings";
      expect(classifyNativeDeliveryWait({ unit: waiting, policy })).toMatchObject({
        kind: "wait",
        nextActor: "implementation_owner",
      });
      waiting.blocker.reasonCode = "review_conversations_unresolved";
      expect(classifyNativeDeliveryWait({ unit: waiting, policy })).toMatchObject({
        kind: "wait",
        nextActor: "implementation_owner",
      });
    });

    it("keeps provider merge waits controller-owned with no owner repair", () => {
      // A branch-protection / merge-queue refusal and the provider's
      // unclassified merge rejection name conditions no code edit resolves:
      // the controller re-reads the provider, and no repair wake is minted.
      const waiting = { ...unit, status: "blocked", blocker: { reasonCode: "merge_queue_blocked" } };
      expect(classifyNativeDeliveryWait({ unit: waiting, policy })).toEqual({
        kind: "wait",
        blocker: { reasonCode: "merge_queue_blocked", message: "merge_queue_blocked", owner: null, nextAction: null },
        nextActor: "controller",
      });
      waiting.blocker.reasonCode = "merge_rejected";
      expect(classifyNativeDeliveryWait({ unit: waiting, policy })).toMatchObject({
        kind: "wait",
        nextActor: "controller",
      });
    });

    it.each([
      ["terminal_unit", { unit: { ...unit, status: "merged" }, policy }],
      ["paused_unit", { unit: { ...unit, pausedAt: new Date() }, policy }],
      ["policy_missing", { unit, policy: null }],
      ["policy_disabled", { unit, policy: { ...policy, enabled: false } }],
      ["policy_paused", { unit, policy: { ...policy, paused: true } }],
      ["repository_mismatch", { unit, policy: { ...policy, repositoryId: "repo-2" } }],
      ["blocker_not_controller_owned", {
        unit: { ...unit, status: "blocked", blocker: { reasonCode: "policy_disabled" } },
        policy,
      }],
      ["blocker_not_controller_owned", {
        unit: { ...unit, status: "blocked", blocker: { reasonCode: "operator_paused" } },
        policy,
      }],
      ["blocker_not_controller_owned", {
        unit: { ...unit, status: "blocked", blocker: { reasonCode: "repair_attempts_exhausted" } },
        policy,
      }],
      ["blocker_not_controller_owned", {
        unit: { ...unit, status: "blocked", blocker: { reasonCode: "deployment_authority_missing" } },
        policy,
      }],
      ["blocker_not_controller_owned", { unit: { ...unit, status: "blocked", blocker: null }, policy }],
    ])("never claims a wait for %s", (reason, input) => {
      expect(classifyNativeDeliveryWait(input)).toEqual({ kind: "none", reason });
    });
  });

  describe("classifyNativeDeliveryHold", () => {
    it("surfaces an operator-held unit as an owned hold with its own blocker", () => {
      const pausedAt = new Date("2026-09-11T07:24:29Z");
      expect(classifyNativeDeliveryHold({
        unit: { status: "blocked", pausedAt, blocker: { reasonCode: "operator_paused", message: "Held by operator", owner: null, nextAction: null } },
        policy: { paused: false },
      })).toEqual({
        kind: "hold",
        hold: "operator_pause",
        blocker: { reasonCode: "operator_paused", message: "Held by operator", owner: null, nextAction: null },
      });
    });

    it("surfaces a paused policy as a hold and keeps disabled or missing policy out of it", () => {
      expect(classifyNativeDeliveryHold({ unit: { status: "in_review", pausedAt: null, blocker: null }, policy: { paused: true } }))
        .toEqual({ kind: "hold", hold: "policy_paused", blocker: null });
      expect(classifyNativeDeliveryHold({ unit: { status: "in_review", pausedAt: null, blocker: null }, policy: null }))
        .toEqual({ kind: "none" });
      expect(classifyNativeDeliveryHold({ unit: { status: "in_review", pausedAt: null, blocker: null }, policy: { paused: false } }))
        .toEqual({ kind: "none" });
      // The operator pause outranks the policy pause and precedes policy reads.
      expect(classifyNativeDeliveryHold({
        unit: { status: "in_review", pausedAt: new Date(), blocker: null },
        policy: { paused: true },
      })).toEqual({ kind: "hold", hold: "operator_pause", blocker: null });
      // Terminal units are not holds.
      expect(classifyNativeDeliveryHold({ unit: { status: "merged", pausedAt: new Date(), blocker: null }, policy: { paused: true } }))
        .toEqual({ kind: "none" });
    });
  });

  it("reads an operator-paused unit as an owned hold and nothing for a running wait", async () => {
    const seeded = await seedCompany();
    await seedPolicy(seeded);
    const heldIssueId = await seedIssue(seeded, { title: "operator held" });
    const waitingIssueId = await seedIssue(seeded, { title: "in review" });
    await seedUnit(seeded, heldIssueId, {
      status: "blocked",
      blocker: { reasonCode: "operator_paused", message: "Post-canary hold", owner: null, nextAction: null },
      pausedAt: new Date("2026-09-11T07:24:29Z"),
    });
    await seedUnit(seeded, waitingIssueId, { prNumber: 55, sourceBranch: "delivery/widget-2" });

    const hold = await getNativeDeliveryHold(db, seeded.companyId, heldIssueId);
    expect(hold).toMatchObject({
      issueId: heldIssueId,
      hold: "operator_pause",
      unitStatus: "blocked",
      candidateGeneration: 1,
      blocker: { reasonCode: "operator_paused" },
    });
    // A live controller-owned wait is not a hold.
    expect(await getNativeDeliveryHold(db, seeded.companyId, waitingIssueId)).toBeNull();
    expect(await getNativeDeliveryHold(db, seeded.companyId, randomUUID())).toBeNull();
    expect(await getNativeDeliveryHold(db, seeded.companyId, "")).toBeNull();
  });

  it("recognizes a persisted in-review unit as the issue's owned wait", async () => {
    const seeded = await seedCompany();
    await seedPolicy(seeded);
    const issueId = await seedIssue(seeded);
    const unit = await seedUnit(seeded, issueId);

    const wait = await getNativeDeliveryWait(db, seeded.companyId, issueId);
    expect(wait).toMatchObject({
      issueId,
      unitId: unit.id,
      unitStatus: "in_review",
      phase: "in_review",
      // Consumers that act on the wait re-validate against this generation, so
      // evidence for a replaced candidate can never describe the current one.
      candidateGeneration: 1,
      repository: "acme/widget",
      prNumber: 54,
      prUrl: "https://github.com/acme/widget/pull/54",
      headSha: HEAD,
      ownerAgentId: seeded.agentId,
      nextActor: "controller",
      blocker: null,
    });

    // Batch form answers many issues in one call, keyed by issue.
    const batch = await listNativeDeliveryWaits(db, seeded.companyId, [issueId, randomUUID()]);
    expect([...batch.keys()]).toEqual([issueId]);

    // A unit with no project policy is not a wait (no policy => ordinary review path).
    await db.update(deliveryPolicies).set({ enabled: false }).where(eq(deliveryPolicies.projectId, seeded.projectId));
    expect(await getNativeDeliveryWait(db, seeded.companyId, issueId)).toBeNull();
  });

  it("does not claim a wait for another company's issue", async () => {
    const first = await seedCompany();
    const second = await seedCompany();
    await seedPolicy(first);
    await seedPolicy(second);
    const firstIssueId = await seedIssue(first, { title: "first" });
    await seedUnit(first, firstIssueId);

    expect(await getNativeDeliveryWait(db, second.companyId, firstIssueId)).toBeNull();
    expect((await listNativeDeliveryWaits(db as unknown as Db, second.companyId, [firstIssueId])).size).toBe(0);
  });

  it("reports an in-review issue as covered by native delivery and stalled without one", async () => {
    const seeded = await seedCompany();
    await seedPolicy(seeded);
    const withUnit = await seedIssue(seeded, { title: "with unit" });
    const withoutUnit = await seedIssue(seeded, { title: "without unit" });
    await seedUnit(seeded, withUnit);

    const attention = await svc.listReviewAttention(seeded.companyId, [
      { id: withUnit, companyId: seeded.companyId, status: "in_review" },
      { id: withoutUnit, companyId: seeded.companyId, status: "in_review" },
    ]);

    expect(attention.get(withUnit)).toMatchObject({
      state: "covered",
      paths: [expect.objectContaining({ kind: "native_delivery", label: "Native delivery · acme/widget #54" })],
    });
    expect(attention.get(withoutUnit)).toMatchObject({ state: "stalled", paths: [] });

    // A disabled policy withdraws the wait: the review is stalled again.
    await db.update(deliveryPolicies).set({ enabled: false }).where(eq(deliveryPolicies.projectId, seeded.projectId));
    const afterDisable = await svc.listReviewAttention(seeded.companyId, [
      { id: withUnit, companyId: seeded.companyId, status: "in_review" },
    ]);
    expect(afterDisable.get(withUnit)).toMatchObject({ state: "stalled", paths: [] });
  });

  it("suppresses the in-review liveness finding while native delivery owns the wait", async () => {
    const seeded = await seedCompany();
    await seedPolicy(seeded);
    const issueId = await seedIssue(seeded);
    await seedUnit(seeded, issueId);

    const baseInput = {
      issues: [{
        id: issueId,
        companyId: seeded.companyId,
        identifier: "NDW-1",
        title: "Widget work",
        status: "in_review",
        projectId: seeded.projectId,
        goalId: null,
        parentId: null,
        assigneeAgentId: seeded.agentId,
        assigneeUserId: null,
        createdByAgentId: null,
        createdByUserId: null,
        executionPolicy: null,
        executionState: null,
        monitorNextCheckAt: null,
        monitorAttemptCount: null,
      }],
      relations: [],
      agents: [{
        id: seeded.agentId,
        companyId: seeded.companyId,
        name: "Implementation Agent",
        role: "engineer",
        title: null,
        status: "idle",
        reportsTo: null,
      }],
      now: new Date(),
    };

    expect(classifyIssueGraphLiveness(baseInput)).toHaveLength(1);

    const wait = await getNativeDeliveryWait(db, seeded.companyId, issueId);
    expect(classifyIssueGraphLiveness({
      ...baseInput,
      nativeDeliveryWaits: [{ id: wait!.unitId, companyId: seeded.companyId, issueId, status: wait!.unitStatus }],
    })).toHaveLength(0);
  });

  it("is a durable waiting path for disposition repair, and stops being one when the policy is disabled", async () => {
    const seeded = await seedCompany();
    await seedPolicy(seeded);
    const issueId = await seedIssue(seeded, { status: "in_progress" });
    await seedUnit(seeded, issueId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));

    const covered = await collectDispositionRepairSourceState(db as unknown as Db, { issue: issue! });
    expect(covered).toMatchObject({ hasDurableWaitingPath: true, durablePathReason: "native_delivery" });

    await db.update(deliveryPolicies).set({ enabled: false }).where(eq(deliveryPolicies.projectId, seeded.projectId));
    const uncovered = await collectDispositionRepairSourceState(db as unknown as Db, { issue: issue! });
    expect(uncovered).toMatchObject({ hasDurableWaitingPath: false, durablePathReason: null });

    // The fingerprint changes with the wait, so a decision made while delivery
    // owned the issue is never replayed against a different delivery state.
    expect(uncovered.fingerprint).not.toBe(covered.fingerprint);
  });

  it("accepts an agent's in_review transition only while native delivery owns the next action", async () => {
    const seeded = await seedCompany();
    const policy = await seedPolicy(seeded);
    const withUnit = await seedIssue(seeded, { status: "todo", title: "delivery pending" });
    const withoutUnit = await seedIssue(seeded, { status: "todo", title: "no delivery" });
    const runId = await seedRun(seeded.companyId, seeded.agentId, withUnit);

    const withoutDelivery = await routeRequest(seeded, runId, withoutUnit, "in_review");
    expect(withoutDelivery.status, JSON.stringify(withoutDelivery.body)).toBe(422);
    expect(withoutDelivery.body.details).toMatchObject({ code: "invalid_issue_disposition" });

    // The wait is derived from persisted delivery state, not from task prose.
    const unit = await seedUnit(seeded, withUnit);
    const accepted = await routeRequest(seeded, runId, withUnit, "in_review");
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.status).toBe("in_review");

    // A disabled policy is an operator gate: the delivery wait is withdrawn and
    // the ordinary review-path requirement applies again.
    await db.update(deliveryPolicies).set({ enabled: false }).where(eq(deliveryPolicies.id, policy.id));
    const otherIssue = await seedIssue(seeded, { status: "todo", title: "policy disabled" });
    await seedUnit(seeded, otherIssue, { prNumber: 56, sourceBranch: "delivery/widget-3" });
    const rejected = await routeRequest(seeded, runId, otherIssue, "in_review");
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
    expect(rejected.body.details).toMatchObject({ code: "invalid_issue_disposition" });
    expect(await getNativeDeliveryWait(db, seeded.companyId, otherIssue)).toBeNull();
    expect(unit.status).toBe("in_review");
  });

  it("keeps a board-visible missing-disposition card for an explicitly blocked issue", async () => {
    const seeded = await seedCompany();
    await seedPolicy(seeded);
    const blockedIssueId = await seedIssue(seeded, { status: "blocked", title: "operator blocked" });
    const inProgressIssueId = await seedIssue(seeded, { status: "in_progress", title: "waiting on delivery" });
    await seedUnit(seeded, blockedIssueId);
    await seedUnit(seeded, inProgressIssueId, { prNumber: 55, sourceBranch: "delivery/widget-2" });
    await seedHandoffRequired(seeded.companyId, blockedIssueId, seeded.agentId);
    await seedHandoffRequired(seeded.companyId, inProgressIssueId, seeded.agentId);

    const rows = await svc.list(seeded.companyId, { attention: "blocked" });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(blockedIssueId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
    });
    expect(byId.get(inProgressIssueId)?.blockedInboxAttention?.state).not.toBe("missing_disposition");

    // The delivery wait itself is still surfaced on the issue's review state.
    expect(await getNativeDeliveryWait(db, seeded.companyId, inProgressIssueId)).not.toBeNull();
  });
});
