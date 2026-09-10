import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  collectDispositionRepairSourceState,
  isDeliveryWaitActorCapable,
} from "../services/recovery/disposition-repair.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres durable-path capability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("durable waiting paths require an actor who can act", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-durable-path-capability-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(input: { agentStatus?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Owner",
      role: "engineer",
      status: input.agentStatus ?? "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(input: {
    companyId: string;
    agentId: string;
    executionState: Record<string, unknown> | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Durable path fixture",
      description: "Fixture issue for durable-path capability.",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: input.agentId,
      createdByUserId: "responsible-user",
      identifier: `T-${issueId.slice(0, 6)}`,
      executionState: input.executionState,
    });
    return await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
  }

  /** A schema-valid pending execution state; `currentParticipant` decides
   * whether it is a routable live path. */
  function pendingExecutionState(input: {
    agentId: string;
    currentParticipant: Record<string, unknown> | null;
  }) {
    const stageId = randomUUID();
    return {
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: input.currentParticipant,
      returnAssignee: { type: "agent", agentId: input.agentId, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: null,
    };
  }

  it("does not treat a pending execution stage without a participant as a live path", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issue = await seedIssue({
      companyId,
      agentId,
      executionState: pendingExecutionState({ agentId, currentParticipant: null }),
    });

    const state = await collectDispositionRepairSourceState(db, { issue });
    expect(state.hasDurableWaitingPath).toBe(false);
    expect(state.durablePathReason).toBeNull();
  });

  it("treats a pending execution stage with a named participant as a live path", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issue = await seedIssue({
      companyId,
      agentId,
      executionState: pendingExecutionState({
        agentId,
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
      }),
    });

    const state = await collectDispositionRepairSourceState(db, { issue });
    expect(state.hasDurableWaitingPath).toBe(true);
    expect(state.durablePathReason).toBe("execution_stage");
    expect(state.durablePathActorCapable).toBe(true);
  });

  it("keeps a controller-owned delivery wait capable and drops an owner who cannot run", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const pausedAgentId = randomUUID();
    await db.insert(agents).values({
      id: pausedAgentId,
      companyId,
      name: "PausedOwner",
      role: "engineer",
      status: "paused",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    expect(
      await isDeliveryWaitActorCapable(db, {
        companyId,
        nextActor: "controller",
        ownerAgentId: null,
      }),
    ).toBe(true);
    expect(
      await isDeliveryWaitActorCapable(db, {
        companyId,
        nextActor: "implementation_owner",
        ownerAgentId: agentId,
      }),
    ).toBe(true);
    expect(
      await isDeliveryWaitActorCapable(db, {
        companyId,
        nextActor: "implementation_owner",
        ownerAgentId: pausedAgentId,
      }),
    ).toBe(false);
    expect(
      await isDeliveryWaitActorCapable(db, {
        companyId,
        nextActor: "implementation_owner",
        ownerAgentId: null,
      }),
    ).toBe(false);
    expect(
      await isDeliveryWaitActorCapable(db, {
        companyId,
        nextActor: "implementation_owner",
        ownerAgentId: randomUUID(),
      }),
    ).toBe(false);
  });
});
