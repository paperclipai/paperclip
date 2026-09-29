import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import { WORKFORCE_OVERVIEW_LIMITS } from "@paperclipai/shared/workforce-overview";
import { workforceOverviewService } from "../services/workforce-overview.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("workforce overview read boundary", () => {
  it("stays on GET selects and does not resume, assign, or start work", () => {
    const service = readFileSync(new URL("../services/workforce-overview.ts", import.meta.url), "utf8");
    const route = readFileSync(new URL("../routes/workforce-overview.ts", import.meta.url), "utf8");
    for (const source of [service, route]) {
      expect(source).not.toMatch(/\.(insert|update|delete)\(/);
    }
    expect(route).toMatch(/router\.get\(/);
    expect(route).not.toMatch(/router\.(post|patch|put|delete)\(/);
    expect(`${service}\n${route}`).not.toMatch(/\b(checkout|wakeup|resumeAgent|startRun)\b/);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workforce overview tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workforce overview service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workforce-overview-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("does not count a paused Vulcan as executing and does not leak another company", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const vulcanId = randomUUID();
    const runnerId = randomUUID();
    const otherAgentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const marcId = "user-marc";
    const now = new Date();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "TYR",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(authUsers).values({
      id: marcId,
      name: "Marc",
      email: "marc@example.com",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: marcId,
      status: "active",
    });
    await db.insert(agents).values([
      {
        id: vulcanId,
        companyId,
        name: "Vulcan",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: now,
        adapterType: "cursor",
        adapterConfig: { model: "grok-4.7" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: runnerId,
        companyId,
        name: "Runner",
        role: "engineer",
        status: "running",
        adapterType: "cursor",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "Other runner",
        role: "engineer",
        status: "running",
        adapterType: "cursor",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Launch",
      status: "in_progress",
      leadAgentId: vulcanId,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Keep shipping",
      identifier: "TYR-10",
      status: "in_progress",
      assigneeAgentId: vulcanId,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: vulcanId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId },
      createdAt: now,
    });
    await db.insert(approvals).values({
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { title: "Hire a researcher" },
    });

    const overview = await workforceOverviewService(db).get(companyId, null);

    expect(overview.readOnly).toBe(true);
    expect(overview.counts.executingAgents.value).toBe(1);
    expect(overview.counts.pausedAgents.value).toBe(1);
    expect(overview.agents.map((agent) => agent.name).sort()).toEqual(["Runner", "Vulcan"]);
    const vulcan = overview.agents.find((agent) => agent.name === "Vulcan");
    expect(vulcan?.disposition).toBe("paused");
    expect(vulcan?.dispositionLabel).toBe("Paused");
    expect(vulcan?.model).toBe("grok-4.7");
    expect(overview.counts.activeProjects.value).toBe(1);
    expect(overview.counts.marcDecisions.value).toBe(1);
    expect(overview.projects[0]?.stage).toBe("In progress");
    expect(overview.projects[0]).not.toHaveProperty("percent");
    expect(overview.projects[0]).not.toHaveProperty("progress");
  });

  it("loads extra activity for the most recently updated initiative, including a completed one", async () => {
    const companyId = randomUUID();
    const openParentId = randomUUID();
    const openChildId = randomUUID();
    const doneParentId = randomUUID();
    const doneChildId = randomUUID();
    const now = new Date();
    const older = new Date(now.getTime() - 86_400_000);

    await db.insert(companies).values({
      id: companyId,
      name: "TYR",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: openParentId,
        companyId,
        title: "Open epic",
        identifier: `TYR-${openParentId.slice(0, 4)}`,
        status: "in_progress",
        updatedAt: older,
      },
      {
        id: openChildId,
        companyId,
        title: "Open child",
        identifier: `TYR-${openChildId.slice(0, 4)}`,
        status: "todo",
        parentId: openParentId,
        updatedAt: older,
      },
      {
        id: doneParentId,
        companyId,
        title: "Finished epic",
        identifier: `TYR-${doneParentId.slice(0, 4)}`,
        status: "done",
        updatedAt: now,
        completedAt: now,
      },
      {
        id: doneChildId,
        companyId,
        title: "Finished child",
        identifier: `TYR-${doneChildId.slice(0, 4)}`,
        status: "done",
        parentId: doneParentId,
        updatedAt: now,
        completedAt: now,
      },
    ]);
    await db.insert(activityLog).values([
      ...Array.from({ length: WORKFORCE_OVERVIEW_LIMITS.activity }, (_, index) => ({
        companyId,
        actorType: "system" as const,
        actorId: "system",
        action: "issue.updated",
        entityType: "issue",
        entityId: randomUUID(),
        details: { summary: `noise ${index}` },
        createdAt: now,
      })),
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.updated",
        entityType: "issue",
        entityId: doneChildId,
        details: { summary: "finished epic handoff" },
        createdAt: older,
      },
    ]);

    const overview = await workforceOverviewService(db).get(companyId, null);

    expect(overview.selectedInitiativeId).toBe(doneParentId);
    expect(overview.timeline.some((entry) => entry.summary === "finished epic handoff")).toBe(true);
  });

  it("omits non-execution issues from work counts and keeps cancelled blockers unresolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const readyId = randomUUID();
    const harnessId = randomUUID();
    const conversationId = randomUUID();
    const blockedId = randomUUID();
    const cancelledId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "TYR",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ready",
      role: "engineer",
      status: "idle",
      adapterType: "cursor",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: readyId,
        companyId,
        title: "Ready work",
        identifier: `TYR-${readyId.slice(0, 4)}`,
        status: "todo",
        assigneeAgentId: agentId,
        updatedAt: now,
      },
      {
        id: harnessId,
        companyId,
        title: "Harness ticket",
        identifier: `TYR-${harnessId.slice(0, 4)}`,
        status: "todo",
        assigneeAgentId: agentId,
        harnessKind: "skill_test",
        updatedAt: now,
      },
      {
        id: conversationId,
        companyId,
        title: "Conversation",
        identifier: `TYR-${conversationId.slice(0, 4)}`,
        status: "in_review",
        assigneeAgentId: agentId,
        conversationAgentId: agentId,
        conversationUserId: "board-user",
        conversationState: "active",
        updatedAt: now,
      },
      {
        id: blockedId,
        companyId,
        title: "Still blocked",
        identifier: `TYR-${blockedId.slice(0, 4)}`,
        status: "todo",
        assigneeAgentId: agentId,
        updatedAt: now,
      },
      {
        id: cancelledId,
        companyId,
        title: "Abandoned blocker",
        identifier: `TYR-${cancelledId.slice(0, 4)}`,
        status: "cancelled",
        updatedAt: now,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: cancelledId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const overview = await workforceOverviewService(db).get(companyId, null);

    expect(overview.counts.waitingEligible.value).toBe(1);
    expect(overview.counts.pendingReviews.value).toBe(0);
    expect(overview.counts.blocked.value).toBe(0);
  });
});
