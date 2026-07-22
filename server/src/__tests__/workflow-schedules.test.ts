import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, workflowSchedules, workflows } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockRunManual = vi.hoisted(() => vi.fn(async () => ({ id: "run-1" })));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/workflows.js", () => ({
  workflowService: () => ({
    runManual: mockRunManual,
  }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    child: () => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

import { workflowScheduleService } from "../services/workflow-schedules.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow schedule tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workflowScheduleService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-schedule-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.delete(workflowSchedules);
    await db.delete(workflows);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWorkflow(status: "active" | "paused" | "archived" = "active") {
    const companyId = randomUUID();
    const workflowId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Brief generator",
      status,
      runnerType: "google_adk",
      runnerConfig: { agentPath: "/tmp/agent.py" },
      pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
      pipelineSourceHash: null,
    });

    return { companyId, workflowId };
  }

  it("dispatches a workflow run with the schedule body only", async () => {
    const { workflowId } = await seedWorkflow("active");
    const svc = workflowScheduleService(db);

    const schedule = await svc.create(workflowId, {
      title: "Daily brief",
      cronExpression: "0 9 * * *",
      templateMarkdown: "Send the morning brief.",
      status: "active",
    }, { userId: "board-user" });

    await db.update(workflowSchedules).set({
      nextRunAt: new Date("2026-06-10T08:59:00.000Z"),
    }).where(eq(workflowSchedules.id, schedule.id));

    const result = await svc.tickScheduledRuns(new Date("2026-06-10T09:00:00.000Z"));

    expect(result.triggered).toBe(1);
    expect(mockRunManual).toHaveBeenCalledWith(workflowId, {
      inputMarkdown: "Send the morning brief.",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "workflow.run_started",
        entityType: "workflow_run",
        entityId: "run-1",
      }),
    );

    const updated = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, schedule.id)).then((rows) => rows[0] ?? null);
    expect(updated?.lastFiredAt).toBeInstanceOf(Date);
  });

  it("does not stamp lastFiredAt when dispatch fails", async () => {
    const { workflowId } = await seedWorkflow("active");
    const svc = workflowScheduleService(db);

    mockRunManual.mockRejectedValueOnce(new Error("dispatch failed"));

    const schedule = await svc.create(workflowId, {
      title: "Daily brief",
      cronExpression: "0 9 * * *",
      templateMarkdown: "Send the morning brief.",
      status: "active",
    }, { userId: "board-user" });

    await db.update(workflowSchedules).set({
      nextRunAt: new Date("2026-06-10T08:59:00.000Z"),
    }).where(eq(workflowSchedules.id, schedule.id));

    const result = await svc.tickScheduledRuns(new Date("2026-06-10T09:00:00.000Z"));

    expect(result.triggered).toBe(0);
    expect(mockRunManual).toHaveBeenCalledWith(workflowId, {
      inputMarkdown: "Send the morning brief.",
    });
    expect(mockLogActivity).not.toHaveBeenCalled();

    const updated = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, schedule.id)).then((rows) => rows[0] ?? null);
    expect(updated?.nextRunAt).toBeInstanceOf(Date);
    expect(updated?.lastFiredAt).toBeNull();
  });

  it("skips missed fires when the workflow is paused", async () => {
    const { workflowId } = await seedWorkflow("paused");
    const svc = workflowScheduleService(db);

    const schedule = await svc.create(workflowId, {
      title: "Daily brief",
      cronExpression: "0 9 * * *",
      templateMarkdown: "Send the morning brief.",
      status: "active",
    }, { userId: "board-user" });

    await db.update(workflowSchedules).set({
      nextRunAt: new Date("2026-06-10T08:59:00.000Z"),
    }).where(eq(workflowSchedules.id, schedule.id));

    const result = await svc.tickScheduledRuns(new Date("2026-06-10T09:00:00.000Z"));

    expect(result.triggered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockRunManual).not.toHaveBeenCalled();

    const updated = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, schedule.id)).then((rows) => rows[0] ?? null);
    expect(updated?.nextRunAt).toBeInstanceOf(Date);
    expect(updated?.lastFiredAt).toBeNull();
  });

  it("skips scheduled fires when the workflow is archived while retaining schedule", async () => {
    const { workflowId } = await seedWorkflow("archived");
    const svc = workflowScheduleService(db);
    const schedule = await svc.create(workflowId, {
      title: "Daily brief",
      cronExpression: "0 9 * * *",
      templateMarkdown: "Send the morning brief.",
      status: "active",
    }, { userId: "board-user" });

    await db.update(workflowSchedules).set({
      nextRunAt: new Date("2026-06-10T08:59:00.000Z"),
    }).where(eq(workflowSchedules.id, schedule.id));

    const result = await svc.tickScheduledRuns(new Date("2026-06-10T09:00:00.000Z"));

    expect(result.triggered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockRunManual).not.toHaveBeenCalled();
    await expect(db.select().from(workflowSchedules).where(eq(workflowSchedules.id, schedule.id)))
      .resolves.toHaveLength(1);
  });
});
