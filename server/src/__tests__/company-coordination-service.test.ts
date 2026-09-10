import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  type Db,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import {
  COORDINATION_HANDOFF_ACTIVITY_ACTION,
  COORDINATION_HANDOFF_WAKE_IDEMPOTENCY_PREFIX,
  type CoordinationHandoffResponse,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  companyCoordinationService,
  type CoordinationWakeDispatcher,
} from "../services/company-coordination.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const companyId = randomUUID();
const otherCompanyId = randomUUID();
const callerAgentId = randomUUID();
const leadAgentId = randomUUID();
const workerAgentId = randomUUID();
const callerRunId = randomUUID();

// One stable source issue stays bound to the caller's run for the whole file.
// Every scenario seeds its own project, lead issue, and target issue.
const sourceIssueId = randomUUID();
const otherCompanyTargetIssueId = randomUUID();

let identifierSeq = 0;
const nextIdentifier = () => `COC-${(identifierSeq += 1)}`;

const grantedWake: CoordinationWakeDispatcher = async () => ({ wakeupRequestId: randomUUID() });

interface ScenarioInput {
  leadAgentId: string | null;
  leadAssigneeAgentId?: string | null;
  leadStatus?: string;
  targetAssigneeAgentId?: string | null;
  targetStatus?: string;
  targetHasParent?: boolean;
  runStatus?: string;
  callerPermissions?: Record<string, unknown>;
}

interface Scenario {
  projectId: string;
  leadIssueId: string;
  targetIssueId: string;
}

describeEmbeddedPostgres("company coordination service", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let scenarioIssueIds: string[] = [];
  let scenarioProjectIds: string[] = [];
  let scenarioRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-coordination-");
    db = createDb(tempDb.connectionString);

    // The run's responsible user lands on the handoff comment as
    // onBehalfOfUserId, which carries a real user FK — seed it once.
    await db.insert(authUsers).values({
      id: "board-user",
      name: "Board User",
      email: "board-user@example.test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companies).values([
      { id: companyId, name: "Coordination Co", issuePrefix: "COC", defaultResponsibleUserId: "board-user" },
      { id: otherCompanyId, name: "Other Co", issuePrefix: "OTH", defaultResponsibleUserId: "board-user" },
    ]);
    await db.insert(agents).values([
      {
        id: callerAgentId,
        companyId,
        name: "Coordinator",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: { canCoordinateCompanyWork: true },
      },
      {
        id: leadAgentId,
        companyId,
        name: "Project Lead",
        role: "cto",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Worker",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        name: "Other Lead",
        role: "cto",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: callerRunId,
      companyId,
      agentId: callerAgentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      identifier: nextIdentifier(),
      title: "Caller run source",
      status: "todo",
      priority: "medium",
      assigneeAgentId: callerAgentId,
    });
    // A target in the other company: proves same-company checks on every row.
    await db.insert(issues).values({
      id: otherCompanyTargetIssueId,
      companyId: otherCompanyId,
      identifier: "OTH-1",
      title: "Foreign target",
      status: "todo",
      priority: "medium",
    });
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog).where(inArray(activityLog.companyId, [companyId, otherCompanyId]));
    await db.delete(agentWakeupRequests).where(inArray(agentWakeupRequests.companyId, [companyId, otherCompanyId]));
    for (const runId of scenarioRunIds) {
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    }
    scenarioRunIds = [];
    if (scenarioIssueIds.length > 0) {
      for (const issueId of [...scenarioIssueIds].reverse()) {
        await db.delete(issues).where(eq(issues.id, issueId));
      }
      scenarioIssueIds = [];
    }
    for (const projectId of scenarioProjectIds) {
      await db.delete(projects).where(eq(projects.id, projectId));
    }
    scenarioProjectIds = [];
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertScenarioIssue(input: {
    projectId?: string | null;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    status?: string;
    title?: string;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      identifier: nextIdentifier(),
      title: input.title ?? "Scenario issue",
      status: input.status ?? "todo",
      priority: "medium",
      projectId: input.projectId ?? null,
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
    });
    scenarioIssueIds.push(id);
    return id;
  }

  /** An extra caller run bound to its own source issue, for multi-run scenarios. */
  async function insertCallerRunForSource(boundSourceIssueId: string): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: callerAgentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: { issueId: boundSourceIssueId },
    });
    scenarioRunIds.push(runId);
    return runId;
  }

  async function seedScenario(input: ScenarioInput): Promise<Scenario> {
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Delivery Project", leadAgentId: input.leadAgentId });
    scenarioProjectIds.push(projectId);

    const leadIssueId = await insertScenarioIssue({
      projectId,
      parentId: null,
      assigneeAgentId: input.leadAssigneeAgentId ?? input.leadAgentId,
      status: input.leadStatus ?? "in_progress",
      title: "Coordination root",
    });
    const targetIssueId = await insertScenarioIssue({
      projectId,
      parentId: input.targetHasParent === false ? null : leadIssueId,
      assigneeAgentId: input.targetAssigneeAgentId ?? workerAgentId,
      status: "todo",
      title: "Handoff target",
    });

    await db
      .update(heartbeatRuns)
      .set({ status: input.runStatus ?? "running", contextSnapshot: { issueId: sourceIssueId } })
      .where(eq(heartbeatRuns.id, callerRunId));
    await db
      .update(agents)
      .set({ permissions: input.callerPermissions ?? { canCoordinateCompanyWork: true } })
      .where(eq(agents.id, callerAgentId));

    return { projectId, leadIssueId, targetIssueId };
  }

  function makeService(wake: CoordinationWakeDispatcher = grantedWake) {
    return companyCoordinationService(db, wake);
  }

  function handoffBody(overrides: Record<string, unknown> = {}) {
    return {
      sourceIssueId,
      targetIssueId: "",
      message: "Please take over the delivery",
      idempotencyKey: "handoff-key",
      ...overrides,
    };
  }

  const actor = { agentId: callerAgentId, runId: callerRunId } as const;

  it("lists open same-company work in stable id order with the exact shared shape", async () => {
    const scenario = await seedScenario({ leadAgentId });
    const doneIssueId = await insertScenarioIssue({ projectId: scenario.projectId, status: "done" });
    const hiddenIssueId = await insertScenarioIssue({ projectId: scenario.projectId });
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hiddenIssueId));
    const harnessIssueId = await insertScenarioIssue({ projectId: scenario.projectId });
    await db.update(issues).set({ harnessKind: "skill_test" }).where(eq(issues.id, harnessIssueId));

    const result = await makeService().listCompanyWork(companyId, { offset: 0 });

    const ids = result.items.map((item) => item.id);
    expect(ids).toContain(scenario.targetIssueId);
    expect(ids).toContain(sourceIssueId);
    expect(ids).not.toContain(doneIssueId);
    expect(ids).not.toContain(hiddenIssueId);
    expect(ids).not.toContain(harnessIssueId);
    expect(ids).not.toContain(otherCompanyTargetIssueId);
    expect(ids).toEqual([...ids].sort());

    const target = result.items.find((item) => item.id === scenario.targetIssueId);
    expect(target).toMatchObject({
      title: "Handoff target",
      status: "todo",
      priority: "medium",
      projectId: scenario.projectId,
      assigneeAgentId: workerAgentId,
      executionRunId: null,
      project: { id: scenario.projectId, name: "Delivery Project", leadAgentId },
    });
    // Exactly the shared contract fields — no description, no comments, no secrets.
    expect(Object.keys(target ?? {}).sort()).toEqual(
      ["assigneeAgentId", "executionRunId", "id", "identifier", "priority", "project", "projectId", "status", "title"].sort(),
    );
    expect(JSON.stringify(result.items)).not.toContain("description");
  });

  it("pages at the fixed size and keeps pages disjoint", async () => {
    await seedScenario({ leadAgentId });
    for (let index = 0; index < 52; index += 1) {
      await insertScenarioIssue({ projectId: null });
    }
    const svc = makeService();
    const pageOne = await svc.listCompanyWork(companyId, { offset: 0 });
    expect(pageOne.items).toHaveLength(50);
    expect(pageOne.nextOffset).toBe(50);
    const pageTwo = await svc.listCompanyWork(companyId, { offset: pageOne.nextOffset ?? 0 });
    expect(pageTwo.items.length).toBeGreaterThan(0);
    expect(pageTwo.items.length).toBeLessThanOrEqual(50);
    const pageOneIds = new Set(pageOne.items.map((item) => item.id));
    for (const item of pageTwo.items) {
      expect(pageOneIds.has(item.id)).toBe(false);
    }
    const combined = [...pageOne.items, ...pageTwo.items].map((item) => item.id);
    expect(combined).toEqual([...combined].sort());
  });

  it("filters by projectId when provided", async () => {
    const scenario = await seedScenario({ leadAgentId });
    const otherProjectId = randomUUID();
    await db.insert(projects).values({ id: otherProjectId, companyId, name: "Other Project", leadAgentId });
    scenarioProjectIds.push(otherProjectId);
    const otherProjectIssueId = await insertScenarioIssue({ projectId: otherProjectId });

    const result = await makeService().listCompanyWork(companyId, { offset: 0, projectId: scenario.projectId });
    const ids = result.items.map((item) => item.id);
    expect(ids).toContain(scenario.targetIssueId);
    expect(ids).not.toContain(otherProjectIssueId);
  });

  it("rejects a caller without the coordination grant and writes nothing", async () => {
    const scenario = await seedScenario({ leadAgentId, callerPermissions: { canCoordinateCompanyWork: false } });
    await expect(
      makeService().createHandoff({ companyId, body: handoffBody({ targetIssueId: scenario.targetIssueId }), actor }),
    ).rejects.toMatchObject({ status: 403, details: { code: "coordination_permission_required" } });
    const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, scenarioIssueIds));
    expect(comments).toHaveLength(0);
  });

  it("rejects a run bound to a different source issue", async () => {
    const scenario = await seedScenario({ leadAgentId });
    await expect(
      makeService().createHandoff({
        companyId,
        body: handoffBody({ sourceIssueId: scenario.targetIssueId, targetIssueId: scenario.targetIssueId }),
        actor,
      }),
    ).rejects.toMatchObject({ status: 403, details: { code: "coordination_run_source_mismatch" } });
    const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, scenarioIssueIds));
    expect(comments).toHaveLength(0);
  });

  it("rejects a terminal run as the handoff context", async () => {
    const scenario = await seedScenario({ leadAgentId, runStatus: "succeeded" });
    await expect(
      makeService().createHandoff({ companyId, body: handoffBody({ targetIssueId: scenario.targetIssueId }), actor }),
    ).rejects.toMatchObject({ status: 403, details: { code: "coordination_run_context_required" } });
  });

  it("returns 404 for a target in another company", async () => {
    await seedScenario({ leadAgentId });
    await expect(
      makeService().createHandoff({ companyId, body: handoffBody({ targetIssueId: otherCompanyTargetIssueId }), actor }),
    ).rejects.toMatchObject({ status: 404 });
    const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, scenarioIssueIds));
    expect(comments).toHaveLength(0);
  });

  it("completes a handoff to the lead's root issue and leaves source and target ownership untouched", async () => {
    const scenario = await seedScenario({ leadAgentId });
    const response = await makeService().createHandoff({
      companyId,
      body: handoffBody({ targetIssueId: scenario.targetIssueId }),
      actor,
    });
    expect(response).toMatchObject({
      sourceIssueId,
      targetIssueId: scenario.targetIssueId,
      leadAgentId,
      leadIssueId: scenario.leadIssueId,
    } satisfies Partial<CoordinationHandoffResponse>);
    expect(response.commentId).toBeTruthy();
    expect(typeof response.wakeRequestId === "string" || response.wakeRequestId === null).toBe(true);

    const [targetAfter] = await db.select().from(issues).where(eq(issues.id, scenario.targetIssueId));
    const [sourceAfter] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect({
      status: targetAfter?.status,
      assigneeAgentId: targetAfter?.assigneeAgentId,
      checkoutRunId: targetAfter?.checkoutRunId,
      executionRunId: targetAfter?.executionRunId,
    }).toEqual({ status: "todo", assigneeAgentId: workerAgentId, checkoutRunId: null, executionRunId: null });
    expect({
      status: sourceAfter?.status,
      assigneeAgentId: sourceAfter?.assigneeAgentId,
      checkoutRunId: sourceAfter?.checkoutRunId,
    }).toEqual({ status: "todo", assigneeAgentId: callerAgentId, checkoutRunId: null });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, scenario.leadIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorAgentId).toBe(callerAgentId);
    expect(comments[0]?.body).toContain("Coordination handoff requested for");
  });

  it("replays the same idempotency key without a duplicate comment or wake", async () => {
    const scenario = await seedScenario({ leadAgentId });
    const wakeCalls: string[] = [];
    const svc = makeService(async (agentId) => {
      wakeCalls.push(agentId);
      return { wakeupRequestId: randomUUID() };
    });
    const first: CoordinationHandoffResponse = await svc.createHandoff({
      companyId,
      body: handoffBody({ targetIssueId: scenario.targetIssueId }),
      actor,
    });
    const second = await svc.createHandoff({
      companyId,
      body: handoffBody({ targetIssueId: scenario.targetIssueId }),
      actor,
    });
    expect(second).toEqual(first);
    expect(wakeCalls).toEqual([leadAgentId]);
    const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, scenarioIssueIds));
    expect(comments).toHaveLength(1);
    // Exactly one fresh influence observation for the committed handoff; the
    // replay consumes none, so the shared per-run cap is never double-counted.
    const influenceRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.cross_issue_influence_observed"));
    expect(influenceRows).toHaveLength(1);
  });

  it("rejects a reused idempotency key with a changed message or target", async () => {
    const scenario = await seedScenario({ leadAgentId });
    const svc = makeService();
    await svc.createHandoff({ companyId, body: handoffBody({ targetIssueId: scenario.targetIssueId }), actor });
    await expect(
      svc.createHandoff({
        companyId,
        body: handoffBody({ targetIssueId: scenario.targetIssueId, message: "Changed message" }),
        actor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "coordination_handoff_key_reused" } });
    // A different but existing target with the same key is also a conflict.
    await expect(
      makeService().createHandoff({
        companyId,
        body: handoffBody({ targetIssueId: sourceIssueId }),
        actor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "coordination_handoff_key_reused" } });
    const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, scenarioIssueIds));
    expect(comments).toHaveLength(1);
  });

  it("serializes concurrent different-source requests on one idempotency key to a single handoff", async () => {
    const scenarioA = await seedScenario({ leadAgentId });
    const scenarioB = await seedScenario({ leadAgentId });
    // A second run bound to a second source issue: the two requests collide on
    // the idempotency key while holding different source-issue rows.
    const secondSourceIssueId = await insertScenarioIssue({
      assigneeAgentId: callerAgentId,
      title: "Second caller run source",
    });
    const secondRunId = await insertCallerRunForSource(secondSourceIssueId);

    const wakeCalls: string[] = [];
    const svc = makeService(async (agentId) => {
      wakeCalls.push(agentId);
      return { wakeupRequestId: randomUUID() };
    });

    const results = await Promise.allSettled([
      svc.createHandoff({
        companyId,
        body: handoffBody({ targetIssueId: scenarioA.targetIssueId, idempotencyKey: "shared-key" }),
        actor,
      }),
      svc.createHandoff({
        companyId,
        body: handoffBody({ sourceIssueId: secondSourceIssueId, targetIssueId: scenarioB.targetIssueId, idempotencyKey: "shared-key" }),
        actor: { agentId: callerAgentId, runId: secondRunId },
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<CoordinationHandoffResponse> => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect([scenarioA.targetIssueId, scenarioB.targetIssueId]).toContain(fulfilled[0]?.value.targetIssueId);
    expect(rejected[0]?.reason).toMatchObject({ status: 409, details: { code: "coordination_handoff_key_reused" } });

    // Exactly one comment, one wake, and one durable record across both scenarios.
    expect(wakeCalls).toEqual([leadAgentId]);
    const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, scenarioIssueIds));
    expect(comments).toHaveLength(1);
    const records = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, COORDINATION_HANDOFF_ACTIVITY_ACTION));
    expect(records).toHaveLength(1);
  });

  it("serializes concurrent identical handoffs to one comment and one wake", async () => {
    const scenario = await seedScenario({ leadAgentId });
    const wakeCalls: string[] = [];
    const svc = makeService(async (agentId) => {
      wakeCalls.push(agentId);
      return { wakeupRequestId: randomUUID() };
    });
    const body = handoffBody({ targetIssueId: scenario.targetIssueId });

    const [first, second] = await Promise.all([
      svc.createHandoff({ companyId, body, actor }),
      svc.createHandoff({ companyId, body, actor }),
    ]);

    expect(second).toEqual(first);
    expect(wakeCalls).toEqual([leadAgentId]);
    const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, scenarioIssueIds));
    expect(comments).toHaveLength(1);
    const records = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, COORDINATION_HANDOFF_ACTIVITY_ACTION));
    expect(records).toHaveLength(1);
  });

  it("returns 409 when no target ancestor is assigned to the project lead", async () => {
    const scenario = await seedScenario({ leadAgentId, leadAssigneeAgentId: workerAgentId });
    await expect(
      makeService().createHandoff({ companyId, body: handoffBody({ targetIssueId: scenario.targetIssueId }), actor }),
    ).rejects.toMatchObject({ status: 409, details: { code: "coordination_lead_issue_missing" } });
    const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, scenarioIssueIds));
    expect(comments).toHaveLength(0);
  });

  it("returns 409 when the target project has no lead agent", async () => {
    const scenario = await seedScenario({ leadAgentId: null });
    await expect(
      makeService().createHandoff({ companyId, body: handoffBody({ targetIssueId: scenario.targetIssueId }), actor }),
    ).rejects.toMatchObject({ status: 409, details: { code: "coordination_lead_missing" } });
  });

  it("skips a terminal lead ancestor", async () => {
    const scenario = await seedScenario({ leadAgentId, leadStatus: "done" });
    await expect(
      makeService().createHandoff({ companyId, body: handoffBody({ targetIssueId: scenario.targetIssueId }), actor }),
    ).rejects.toMatchObject({ status: 409, details: { code: "coordination_lead_issue_missing" } });
  });

  it("uses the target itself as the lead issue when the lead owns it directly", async () => {
    const scenario = await seedScenario({ leadAgentId, targetAssigneeAgentId: leadAgentId });
    const response = await makeService().createHandoff({
      companyId,
      body: handoffBody({ targetIssueId: scenario.targetIssueId }),
      actor,
    });
    expect(response.leadIssueId).toBe(scenario.targetIssueId);
    expect(response.leadAgentId).toBe(leadAgentId);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, scenario.targetIssueId));
    expect(comments).toHaveLength(1);
  });

  it("keeps a failed wake pending and recovers it on replay", async () => {
    const scenario = await seedScenario({ leadAgentId });
    let failingWakeCalls = 0;
    const failing = makeService(async () => {
      failingWakeCalls += 1;
      throw new Error("budget blocked");
    });
    // The wake failure propagates — never a fake success — while the durable
    // comment and a retryable pending record survive it.
    await expect(
      failing.createHandoff({ companyId, body: handoffBody({ targetIssueId: scenario.targetIssueId }), actor }),
    ).rejects.toMatchObject({ message: "budget blocked" });
    expect(failingWakeCalls).toBe(1);
    const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, scenarioIssueIds));
    expect(comments).toHaveLength(1);
    const [pending] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, COORDINATION_HANDOFF_ACTIVITY_ACTION));
    expect(pending?.details).toMatchObject({
      wakePending: true,
      wakeError: "budget blocked",
      wakeRequestId: null,
    });

    // Replay settles the stranded wake without a duplicate comment.
    const replay = await makeService().createHandoff({
      companyId,
      body: handoffBody({ targetIssueId: scenario.targetIssueId }),
      actor,
    });
    expect(typeof replay.wakeRequestId === "string").toBe(true);
    expect(replay.commentId).toBeTruthy();
    const commentsAfter = await db.select().from(issueComments).where(inArray(issueComments.issueId, scenarioIssueIds));
    expect(commentsAfter).toHaveLength(1);
    const [settled] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, COORDINATION_HANDOFF_ACTIVITY_ACTION));
    expect(settled?.details).toMatchObject({ wakePending: false, wakeRequestId: replay.wakeRequestId });
    expect(settled?.details).not.toHaveProperty("wakeError");
  });

  it("reconcilePendingHandoffs dispatches a stranded pending record exactly once", async () => {
    const scenario = await seedScenario({ leadAgentId });
    const failing = makeService(async () => {
      throw new Error("dispatch crashed before outcome");
    });
    await expect(
      failing.createHandoff({ companyId, body: handoffBody({ targetIssueId: scenario.targetIssueId }), actor }),
    ).rejects.toMatchObject({ message: "dispatch crashed before outcome" });
    const [stranded] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, COORDINATION_HANDOFF_ACTIVITY_ACTION));
    expect(stranded?.details).toMatchObject({ wakePending: true });

    const wakeCalls: string[] = [];
    const recovered = await makeService(async (agentId) => {
      wakeCalls.push(agentId);
      return { wakeupRequestId: randomUUID() };
    }).reconcilePendingHandoffs({ companyId });
    expect(recovered).toEqual({ scanned: 1, dispatched: 1, repaired: 0, failed: 0 });
    expect(wakeCalls).toEqual([leadAgentId]);

    const [settled] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, COORDINATION_HANDOFF_ACTIVITY_ACTION));
    expect(settled?.details).toMatchObject({ wakePending: false });
    expect(typeof (settled?.details as Record<string, unknown>).wakeRequestId === "string").toBe(true);
    const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, scenarioIssueIds));
    expect(comments).toHaveLength(1);

    // The second pass finds nothing pending: recovery is not a retry loop.
    const second = await makeService().reconcilePendingHandoffs({ companyId });
    expect(second).toEqual({ scanned: 0, dispatched: 0, repaired: 0, failed: 0 });
  });

  it("repairs a pending record from an existing durable wake without enqueueing twice", async () => {
    const scenario = await seedScenario({ leadAgentId });
    const wakeKey = `${COORDINATION_HANDOFF_WAKE_IDEMPOTENCY_PREFIX}${companyId}:handoff-key`;
    const durableWakeId = randomUUID();
    const crashing = makeService(async () => {
      // Simulates a process death in the window after the wake landed durably
      // but before the activity outcome was written.
      await db.insert(agentWakeupRequests).values({
        id: durableWakeId,
        companyId,
        agentId: leadAgentId,
        source: "on_demand",
        triggerDetail: "system",
        reason: "coordination_handoff",
        payload: { issueId: scenario.leadIssueId },
        status: "queued",
        requestedByActorType: "agent",
        requestedByActorId: callerAgentId,
        idempotencyKey: wakeKey,
      });
      throw new Error("crashed after enqueue");
    });
    await expect(
      crashing.createHandoff({ companyId, body: handoffBody({ targetIssueId: scenario.targetIssueId }), actor }),
    ).rejects.toMatchObject({ message: "crashed after enqueue" });

    const wakeCalls: string[] = [];
    const result = await makeService(async (agentId) => {
      wakeCalls.push(agentId);
      return { wakeupRequestId: randomUUID() };
    }).reconcilePendingHandoffs({ companyId });
    expect(result).toEqual({ scanned: 1, dispatched: 0, repaired: 1, failed: 0 });
    expect(wakeCalls).toEqual([]);

    const [record] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, COORDINATION_HANDOFF_ACTIVITY_ACTION));
    expect(record?.details).toMatchObject({ wakePending: false, wakeRequestId: durableWakeId });
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, wakeKey));
    expect(wakes).toHaveLength(1);
  });

  it("writes the audited activity record with the durable handoff fields", async () => {
    const scenario = await seedScenario({ leadAgentId });
    await makeService().createHandoff({ companyId, body: handoffBody({ targetIssueId: scenario.targetIssueId }), actor });
    const records = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, COORDINATION_HANDOFF_ACTIVITY_ACTION));
    expect(records).toHaveLength(1);
    expect(records[0]?.companyId).toBe(companyId);
    expect(records[0]?.entityId).toBe(scenario.leadIssueId);
    expect(records[0]?.actorType).toBe("agent");
    expect(records[0]?.runId).toBe(callerRunId);
    const details = records[0]?.details as Record<string, unknown>;
    expect(details).toMatchObject({
      sourceIssueId,
      targetIssueId: scenario.targetIssueId,
      leadAgentId,
      leadIssueId: scenario.leadIssueId,
      idempotencyKey: "handoff-key",
      leadIssueStatus: "in_progress",
      wakePending: false,
    });
    expect(typeof details.commentId).toBe("string");
    expect(typeof details.messageSha256).toBe("string");
  });

  it("dispatches the addressed wake with the lead issue payload and state guard", async () => {
    const scenario = await seedScenario({ leadAgentId });
    const wakeCalls: Array<{ agentId: string; opts: Record<string, unknown> }> = [];
    const svc = makeService(async (agentId, opts) => {
      wakeCalls.push({ agentId, opts: opts as unknown as Record<string, unknown> });
      return { wakeupRequestId: randomUUID() };
    });
    await svc.createHandoff({ companyId, body: handoffBody({ targetIssueId: scenario.targetIssueId }), actor });
    expect(wakeCalls).toHaveLength(1);
    const wake = wakeCalls[0];
    expect(wake?.agentId).toBe(leadAgentId);
    expect(wake?.opts.reason).toBe("coordination_handoff");
    expect(wake?.opts.requestedByActorType).toBe("agent");
    expect(wake?.opts.requestedByActorId).toBe(callerAgentId);
    expect(wake?.opts.idempotencyKey).toBe(`${COORDINATION_HANDOFF_WAKE_IDEMPOTENCY_PREFIX}${companyId}:handoff-key`);
    expect(wake?.opts.payload).toMatchObject({ issueId: scenario.leadIssueId });
    expect(wake?.opts.issueStateGuard).toEqual({ statuses: ["in_progress"], assigneeAgentId: leadAgentId });
  });

  it("keeps list and handoff strictly inside the caller's company", async () => {
    await seedScenario({ leadAgentId });
    const svc = makeService();
    const other = await svc.listCompanyWork(otherCompanyId, { offset: 0 });
    const own = await svc.listCompanyWork(companyId, { offset: 0 });
    const otherIds = other.items.map((item) => item.id);
    const ownIds = own.items.map((item) => item.id);
    // The other company's listing shows its own seeded issue — and nothing of
    // this company's; this company's listing never leaks the foreign issue.
    expect(otherIds).toContain(otherCompanyTargetIssueId);
    expect(ownIds).not.toContain(otherCompanyTargetIssueId);
    expect(ownIds.length).toBeGreaterThan(0);
    expect(otherIds.filter((id) => ownIds.includes(id))).toEqual([]);
  });
});
