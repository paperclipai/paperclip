import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  goals,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat goal/project intake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat goal/project intake", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-heartbeat-intake-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("includes company-scoped linked records, active milestones, and changed-since deltas", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const goalId = randomUUID();
    const activeMilestoneId = randomUUID();
    const inactiveMilestoneId = randomUUID();
    const crossCompanyMilestoneId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const previousRunId = randomUUID();
    const currentRunId = randomUUID();
    const baselineAt = new Date("2026-07-22T12:00:00.000Z");
    const changedAt = new Date("2026-07-23T10:00:00.000Z");
    const currentRunAt = new Date("2026-07-23T12:00:00.000Z");

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Portfolio Company",
        issuePrefix: "PORT",
      },
      {
        id: otherCompanyId,
        name: "Other Company",
        issuePrefix: "OTHR",
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Portfolio Lead",
      role: "lead",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
    });
    await db.insert(goals).values([
      {
        id: goalId,
        companyId,
        title: "Build a repeatable growth engine",
        description:
          "Outcome, owner, horizon, dependencies, evidence, approval boundary, and ranking inputs.",
        level: "team",
        status: "active",
        ownerAgentId: agentId,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: changedAt,
      },
      {
        id: activeMilestoneId,
        companyId,
        title: "Reach $100 MRR",
        description: "Exit evidence and milestone dependencies.",
        level: "task",
        status: "active",
        parentId: goalId,
        ownerAgentId: agentId,
        createdAt: new Date("2026-07-02T00:00:00.000Z"),
        updatedAt: changedAt,
      },
      {
        id: inactiveMilestoneId,
        companyId,
        title: "Reach $1k MRR",
        level: "task",
        status: "planned",
        parentId: goalId,
        ownerAgentId: agentId,
      },
      {
        id: crossCompanyMilestoneId,
        companyId: otherCompanyId,
        title: "Foreign milestone",
        level: "task",
        status: "active",
        parentId: goalId,
      },
    ]);
    await db.insert(projects).values({
      id: projectId,
      companyId,
      goalId,
      name: "Portfolio intelligence",
      description:
        "Planning horizon, evidence source, approval boundary, and ranking inputs.",
      status: "in_progress",
      leadAgentId: agentId,
      targetDate: "2026-09-30",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: changedAt,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      goalId,
      identifier: "PORT-1",
      title: "Validate portfolio intake",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: previousRunId,
      companyId,
      agentId,
      status: "succeeded",
      createdAt: baselineAt,
      contextSnapshot: {
        issueId,
        paperclipWake: {
          goalProjectIntake: {
            capturedAt: baselineAt.toISOString(),
            project: { id: projectId },
            goal: { id: goalId },
            activeMilestones: [
              { id: activeMilestoneId },
              { id: "milestone-no-longer-active" },
            ],
          },
        },
      },
    });

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      run: {
        id: currentRunId,
        agentId,
        createdAt: currentRunAt,
      },
      issueSummary: {
        id: issueId,
        identifier: "PORT-1",
        title: "Validate portfolio intake",
        status: "in_progress",
        priority: "high",
        workMode: "standard",
        projectId,
        goalId,
      },
    });

    expect(payload?.issue).toMatchObject({ projectId, goalId });
    expect(payload?.goalProjectIntake).toMatchObject({
      changedSince: baselineAt.toISOString(),
      baselineRunId: previousRunId,
      baselineKind: "incremental",
      project: {
        id: projectId,
        leadAgentId: agentId,
        targetDate: "2026-09-30",
      },
      goal: {
        id: goalId,
        ownerAgentId: agentId,
      },
      activeMilestoneCount: 1,
      includedActiveMilestoneCount: 1,
      truncated: false,
      deltas: {
        project: { id: projectId, changeKind: "updated" },
        goal: { id: goalId, changeKind: "updated" },
        activeMilestones: [
          { id: activeMilestoneId, changeKind: "updated" },
        ],
        noLongerActiveMilestoneIds: ["milestone-no-longer-active"],
      },
    });
    expect(payload?.goalProjectIntake.activeMilestones).toEqual([
      expect.objectContaining({
        id: activeMilestoneId,
        description: "Exit evidence and milestone dependencies.",
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain(inactiveMilestoneId);
    expect(JSON.stringify(payload)).not.toContain(crossCompanyMilestoneId);
    expect(payload?.fallbackFetchNeeded).toBe(false);
  });
});
