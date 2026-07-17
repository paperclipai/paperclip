import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import type { FactoryPolicyV1, IssueExecutionPolicy } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_FACTORY_POLICY_V1,
  effectiveFactoryExecutionLaneMaximum,
  factoryPolicyContentHash,
  factoryPolicyStageIsSelected,
  factoryStageEvidenceGates,
  factoryStageReturnTarget,
} from "../services/ai-factory-policy.js";
import {
  aiFactoryExecutionLaneService,
  factoryControlAuthorizationFingerprint,
} from "../services/ai-factory-execution-lanes.js";
import { buildInitialIssueExecutionWorkflow } from "../services/issue-execution-policy.js";
import {
  authorizeFactoryManagedCreate,
  authorizeFactoryManagedPolicyPin,
} from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

function factoryPolicy(allowParallelLanes: boolean): FactoryPolicyV1 {
  return {
    ...DEFAULT_FACTORY_POLICY_V1,
    topology: {
      ...DEFAULT_FACTORY_POLICY_V1.topology,
      maxExecutionLanes: allowParallelLanes ? 3 : 1,
      allowParallelLanes,
    },
  };
}

function factoryPolicies(input: {
  parentIssueId: string;
  coordinatorAgentId: string;
  engineerAgentId: string;
  qaAgentId: string;
  allowParallelLanes: boolean;
}) {
  const snapshot = factoryPolicy(input.allowParallelLanes);
  const policyHash = factoryPolicyContentHash(snapshot);
  const selectedStages = snapshot.stages.filter((stage) => factoryPolicyStageIsSelected(stage, false));
  const stages = selectedStages.map((stage, index) => ({
    id: randomUUID(),
    key: stage.key,
    type: stage.type,
    role: stage.role,
    independent: stage.independent ?? false,
    returnToStageKey: factoryStageReturnTarget(selectedStages, index),
    evidenceGates: factoryStageEvidenceGates(stage),
    approvalsNeeded: 1 as const,
    participants: [{
      id: randomUUID(),
      type: "agent" as const,
      agentId: stage.role === "qa"
        ? input.qaAgentId
        : stage.role === "engineer"
          ? input.engineerAgentId
          : input.coordinatorAgentId,
    }],
  }));
  const controlExecutionPolicy = {
    mode: "normal",
    commentRequired: true,
    stages: [],
    factory: {
      schemaVersion: 1,
      laneKind: "control",
      topologyMode: input.allowParallelLanes ? "direct_execution_lanes" : "single_execution_lane",
      controlIssueId: null,
      coordinator: { type: "agent", agentId: input.coordinatorAgentId },
      policyKey: "company/test/ai-factory-policy",
      policyVersion: "1",
      policyHash,
      maxExecutionLanes: effectiveFactoryExecutionLaneMaximum(snapshot),
      policySnapshot: snapshot,
    },
  } satisfies IssueExecutionPolicy;
  const laneExecutionPolicy = {
    mode: "normal",
    commentRequired: true,
    stages,
    factory: {
      schemaVersion: 1,
      laneKind: "execution",
      topologyMode: "same_issue_only",
      controlIssueId: input.parentIssueId,
      coordinator: { type: "agent", agentId: input.coordinatorAgentId },
      policyKey: "company/test/ai-factory-policy",
      policyVersion: "1",
      policyHash,
      maxExecutionLanes: effectiveFactoryExecutionLaneMaximum(snapshot),
      policySnapshot: snapshot,
      production: false,
    },
  } satisfies IssueExecutionPolicy;
  return { policyHash, controlExecutionPolicy, laneExecutionPolicy };
}

function laneInput(input: {
  companyId: string;
  parentIssueId: string;
  laneIssueId: string;
  coordinatorAgentId: string;
  engineerAgentId: string;
  qaAgentId: string;
  allowParallelLanes: boolean;
  idempotencyKey: string;
  requestFingerprint?: string;
  actorAgentId?: string | null;
}) {
  const policies = factoryPolicies(input);
  const initial = buildInitialIssueExecutionWorkflow({ policy: policies.laneExecutionPolicy })!;
  return {
    companyId: input.companyId,
    parentAuthorizationFingerprint: factoryControlAuthorizationFingerprint({
      id: input.parentIssueId,
      companyId: input.companyId,
      projectId: null,
      parentId: null,
      visibility: "company",
      createdByAgentId: null,
      createdByUserId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
      executionPolicy: null,
    }),
    authorizeLockedParent: async () => {},
    controlExecutionPolicy: policies.controlExecutionPolicy,
    factoryManagedPolicyPin: authorizeFactoryManagedPolicyPin(policies.policyHash),
    actorUserId: "board-user",
    idempotency: {
      key: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint ?? "a".repeat(64),
    },
    child: {
      id: input.laneIssueId,
      title: "Atomic factory lane",
      description: "Create the complete lane or create nothing.",
      status: initial.status as string,
      priority: "medium",
      assigneeAgentId: initial.assigneeAgentId as string,
      createdByUserId: "board-user",
      actorAgentId: input.actorAgentId ?? null,
      actorUserId: "board-user",
      blockParentUntilDone: true,
      executionPolicy: policies.laneExecutionPolicy as unknown as Record<string, unknown>,
      executionState: initial.executionState as Record<string, unknown>,
      executionContract: {
        schemaVersion: 2,
        revision: 1,
        contractType: "delegated_task",
        taskType: "implementation",
        core: {
          objective: "Ship the atomic lane",
          why: "The control issue needs a bounded execution lane.",
          sourceOfTruth: [{ kind: "control_issue", issueId: input.parentIssueId }],
          acceptanceChecks: [{ stageKey: "implementation", required: true }],
          constraints: ["Do not create child issues."],
          evidenceRequired: ["Record authoritative delivery evidence."],
          handoffNotes: { managerReasoning: "Keep the factory transaction atomic." },
        },
        extensions: {
          aiFactory: {
            laneKind: "execution",
            controlIssueId: input.parentIssueId,
            topologyMode: "same_issue_only",
            companyPolicyKey: "company/test/ai-factory-policy",
            companyPolicyHash: policies.policyHash,
            production: false,
          },
        },
      },
      factoryManagedCreate: authorizeFactoryManagedCreate(policies.policyHash, input.parentIssueId),
    },
  };
}

describeEmbeddedPostgres("AI Factory execution-lane atomic transaction", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-factory-lane-atomic-");
    db = createDb(tempDb.connectionString);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedControl(allowParallelLanes: boolean) {
    const companyId = randomUUID();
    const parentIssueId = randomUUID();
    const coordinatorAgentId = randomUUID();
    const engineerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Atomic Factory",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: coordinatorAgentId, companyId, name: "CTO", role: "cto", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: engineerAgentId, companyId, name: "Engineer", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Factory control",
      status: "in_progress",
      priority: "medium",
    });
    return { companyId, parentIssueId, coordinatorAgentId, engineerAgentId, qaAgentId, allowParallelLanes };
  }

  it("rolls back the first policy pin and child when the blocker relation fails, then retries cleanly", async () => {
    const seeded = await seedControl(true);
    const laneIssueId = randomUUID();
    const invalidActorAgentId = randomUUID();
    const service = aiFactoryExecutionLaneService(db);
    const failedInput = laneInput({
      ...seeded,
      laneIssueId,
      idempotencyKey: "rollback-then-retry",
      actorAgentId: invalidActorAgentId,
    });
    // The child itself does not persist actorAgentId, but the final blocker
    // relation does. Its FK failure proves a failure after child insertion
    // still rolls the parent pin and child back together.
    await expect(service.create(seeded.parentIssueId, failedInput)).rejects.toThrow();

    const parentAfterFailure = await db
      .select({ executionPolicy: issues.executionPolicy })
      .from(issues)
      .where(eq(issues.id, seeded.parentIssueId))
      .then((rows) => rows[0]);
    expect(parentAfterFailure?.executionPolicy).toBeNull();
    expect(await db.select().from(issues).where(eq(issues.id, laneIssueId))).toHaveLength(0);

    const retried = await service.create(seeded.parentIssueId, {
      ...failedInput,
      child: { ...failedInput.child, actorAgentId: null },
    });
    expect(retried).toMatchObject({
      issue: { id: laneIssueId },
      parentPinned: true,
      parentBlockerAdded: true,
      idempotentReplay: false,
    });
    expect(await db.select().from(issueRelations).where(and(
      eq(issueRelations.issueId, laneIssueId),
      eq(issueRelations.relatedIssueId, seeded.parentIssueId),
    ))).toHaveLength(1);
  });

  it("deduplicates concurrent and sequential retries and rejects key reuse with another request", async () => {
    const seeded = await seedControl(true);
    const laneIssueId = randomUUID();
    const service = aiFactoryExecutionLaneService(db);
    const input = laneInput({
      ...seeded,
      laneIssueId,
      idempotencyKey: "same-logical-lane",
    });

    const concurrent = await Promise.all([
      service.create(seeded.parentIssueId, input),
      service.create(seeded.parentIssueId, input),
    ]);
    expect(new Set(concurrent.map((result) => result.issue.id))).toEqual(new Set([laneIssueId]));
    expect(concurrent.filter((result) => result.idempotentReplay)).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.parentId, seeded.parentIssueId))).toHaveLength(1);
    expect(await db.select().from(issueRelations).where(and(
      eq(issueRelations.issueId, laneIssueId),
      eq(issueRelations.relatedIssueId, seeded.parentIssueId),
    ))).toHaveLength(1);

    const replay = await service.create(seeded.parentIssueId, input);
    expect(replay).toMatchObject({ issue: { id: laneIssueId }, idempotentReplay: true });
    await expect(service.create(seeded.parentIssueId, {
      ...input,
      idempotency: { ...input.idempotency, requestFingerprint: "b".repeat(64) },
    })).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({ code: "factory_lane_idempotency_conflict" }),
    });
  });

  it("commits the pin and lane without inventing a parent blocker when the option is disabled", async () => {
    const seeded = await seedControl(true);
    const laneIssueId = randomUUID();
    const service = aiFactoryExecutionLaneService(db);
    const input = laneInput({
      ...seeded,
      laneIssueId,
      idempotencyKey: "no-parent-blocker",
      requestFingerprint: "e".repeat(64),
    });
    input.child.blockParentUntilDone = false;

    const created = await service.create(seeded.parentIssueId, input);
    expect(created).toMatchObject({
      issue: { id: laneIssueId },
      parentPinned: true,
      parentBlockerAdded: false,
      idempotentReplay: false,
    });
    expect(await db.select().from(issueRelations).where(and(
      eq(issueRelations.issueId, laneIssueId),
      eq(issueRelations.relatedIssueId, seeded.parentIssueId),
    ))).toHaveLength(0);
  });

  it("serializes different requests at the frozen lane cap while keeping one complete lane", async () => {
    const seeded = await seedControl(false);
    const service = aiFactoryExecutionLaneService(db);
    const attempts = await Promise.allSettled([
      service.create(seeded.parentIssueId, laneInput({
        ...seeded,
        laneIssueId: randomUUID(),
        idempotencyKey: "cap-race-a",
        requestFingerprint: "c".repeat(64),
      })),
      service.create(seeded.parentIssueId, laneInput({
        ...seeded,
        laneIssueId: randomUUID(),
        idempotencyKey: "cap-race-b",
        requestFingerprint: "d".repeat(64),
      })),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: {
        status: 422,
        details: expect.objectContaining({
          code: "factory_policy_conflict",
          rule: "max_execution_lanes",
          maxExecutionLanes: 1,
        }),
      },
    });
    const children = await db.select().from(issues).where(eq(issues.parentId, seeded.parentIssueId));
    expect(children).toHaveLength(1);
    expect(await db.select().from(issueRelations).where(and(
      eq(issueRelations.issueId, children[0]!.id),
      eq(issueRelations.relatedIssueId, seeded.parentIssueId),
    ))).toHaveLength(1);
    const parent = await db.select().from(issues).where(eq(issues.id, seeded.parentIssueId)).then((rows) => rows[0]);
    expect((parent?.executionPolicy as IssueExecutionPolicy).factory).toMatchObject({
      laneKind: "control",
      topologyMode: "single_execution_lane",
      maxExecutionLanes: 1,
    });
  });

  it("serializes lane creation behind control completion and rejects the new lane", async () => {
    const seeded = await seedControl(true);
    const service = aiFactoryExecutionLaneService(db);
    let markParentLocked!: () => void;
    const parentLocked = new Promise<void>((resolve) => {
      markParentLocked = resolve;
    });
    let releaseCompletion!: () => void;
    const completionRelease = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const completion = db.transaction(async (tx) => {
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, seeded.parentIssueId))
        .for("update");
      await tx.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.parentIssueId));
      markParentLocked();
      await completionRelease;
    });
    await parentLocked;

    let creationSettled = false;
    const creation = service.create(seeded.parentIssueId, laneInput({
      ...seeded,
      laneIssueId: randomUUID(),
      idempotencyKey: "terminal-control-race",
      requestFingerprint: "f".repeat(64),
    })).finally(() => {
      creationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(creationSettled).toBe(false);
    releaseCompletion();
    await completion;

    await expect(creation).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        code: "factory_control_terminal",
        controlIssueId: seeded.parentIssueId,
        status: "done",
      }),
    });
    expect(await db.select().from(issues).where(eq(issues.parentId, seeded.parentIssueId))).toHaveLength(0);
  });

  it("rejects a lane when the authorized visibility boundary changes before the parent lock", async () => {
    const seeded = await seedControl(true);
    const service = aiFactoryExecutionLaneService(db);
    const input = laneInput({
      ...seeded,
      laneIssueId: randomUUID(),
      idempotencyKey: "authorization-boundary-race",
      requestFingerprint: "1".repeat(64),
    });
    let markParentLocked!: () => void;
    const parentLocked = new Promise<void>((resolve) => {
      markParentLocked = resolve;
    });
    let releaseVisibilityChange!: () => void;
    const visibilityChangeRelease = new Promise<void>((resolve) => {
      releaseVisibilityChange = resolve;
    });
    const visibilityChange = db.transaction(async (tx) => {
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, seeded.parentIssueId))
        .for("update");
      await tx
        .update(issues)
        .set({ visibility: "private" })
        .where(eq(issues.id, seeded.parentIssueId));
      markParentLocked();
      await visibilityChangeRelease;
    });
    await parentLocked;

    let creationSettled = false;
    const creation = service.create(seeded.parentIssueId, input).finally(() => {
      creationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(creationSettled).toBe(false);
    releaseVisibilityChange();
    await visibilityChange;

    await expect(creation).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        code: "factory_control_authorization_stale",
        controlIssueId: seeded.parentIssueId,
      }),
    });
    expect(await db.select().from(issues).where(eq(issues.parentId, seeded.parentIssueId))).toHaveLength(0);
  });

  it("runs the route authorization callback against the parent held by the transaction", async () => {
    const seeded = await seedControl(true);
    const input = laneInput({
      ...seeded,
      laneIssueId: randomUUID(),
      idempotencyKey: "locked-authorization-callback",
      requestFingerprint: "3".repeat(64),
    });
    const authorizeLockedParent = vi.fn(async (parent: { id: string; visibility: string }) => {
      expect(parent).toMatchObject({ id: seeded.parentIssueId, visibility: "company" });
      throw new Error("locked authorization revoked");
    });
    input.authorizeLockedParent = authorizeLockedParent;

    await expect(
      aiFactoryExecutionLaneService(db).create(seeded.parentIssueId, input),
    ).rejects.toThrow("locked authorization revoked");

    expect(authorizeLockedParent).toHaveBeenCalledTimes(1);
    expect(await db.select().from(issues).where(eq(issues.parentId, seeded.parentIssueId))).toHaveLength(0);
  });

  it("derives child project and visibility only from the locked control issue", async () => {
    const seeded = await seedControl(true);
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId: seeded.companyId,
      name: "Locked factory project",
      status: "in_progress",
    });
    await db
      .update(issues)
      .set({ projectId, visibility: "private" })
      .where(eq(issues.id, seeded.parentIssueId));
    const input = laneInput({
      ...seeded,
      laneIssueId: randomUUID(),
      idempotencyKey: "locked-parent-inheritance",
      requestFingerprint: "2".repeat(64),
    });
    input.parentAuthorizationFingerprint = factoryControlAuthorizationFingerprint({
      id: seeded.parentIssueId,
      companyId: seeded.companyId,
      projectId,
      parentId: null,
      visibility: "private",
      createdByAgentId: null,
      createdByUserId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
      executionPolicy: null,
    });
    input.child.projectId = null;
    input.child.visibility = "company";

    const created = await aiFactoryExecutionLaneService(db).create(seeded.parentIssueId, input);

    expect(created.issue).toMatchObject({
      parentId: seeded.parentIssueId,
      projectId,
      visibility: "private",
    });
  });
});
