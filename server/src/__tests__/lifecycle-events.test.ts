import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { transitionHeartbeatRunStatus } from "../services/heartbeat-run-lifecycle.js";
import { issueService } from "../services/issues.js";

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;

describePostgres("lifecycle events of committed status changes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  const info = vi.spyOn(logger, "info");

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-lifecycle-events-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Lifecycle", issuePrefix: "LCE" }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Lifecycle agent",
      role: "engineer",
      adapterType: "process",
    }).returning();
    companyId = company!.id;
    agentId = agent!.id;
  }, 30_000);

  afterEach(() => {
    info.mockClear();
  });

  afterAll(async () => {
    info.mockRestore();
    await database?.cleanup();
  });

  function lifecycleEvents(eventType: "run_transition" | "task_transition") {
    return info.mock.calls
      .map(([fields]) => (fields as { lifecycleEvent?: { eventType: string } }).lifecycleEvent)
      .filter((event) => event?.eventType === eventType);
  }

  async function createRun(status: string) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status, invocationSource: "on_demand" }).returning();
    return run!.id;
  }

  async function createIssue(status: "todo" | "in_progress") {
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Lifecycle task",
      status,
      assigneeAgentId: agentId,
      priority: "medium",
      issueNumber: Math.floor(Math.random() * 1_000_000),
    }).returning();
    return issue!.id;
  }

  it("logs a run transition once, after its transaction commits", async () => {
    const runId = await createRun("queued");
    let loggedBeforeCommit = -1;

    await db.transaction(async (tx) => {
      await transitionHeartbeatRunStatus(tx, runId, { toStatus: "running" });
      loggedBeforeCommit = lifecycleEvents("run_transition").length;
    });

    expect(loggedBeforeCommit).toBe(0);
    expect(lifecycleEvents("run_transition")).toEqual([
      expect.objectContaining({ runId, fromStatus: "queued", toStatus: "running", terminal: false }),
    ]);
  });

  it("logs nothing for a rolled-back or same-status run write", async () => {
    const runId = await createRun("running");

    await expect(db.transaction(async (tx) => {
      await transitionHeartbeatRunStatus(tx, runId, { toStatus: "failed" });
      throw new Error("roll back");
    })).rejects.toThrow("roll back");
    await transitionHeartbeatRunStatus(db, runId, { toStatus: "running", patch: { error: "unchanged status" } });

    expect(lifecycleEvents("run_transition")).toEqual([]);
  });

  it("logs exactly one task transition when a task enters review", async () => {
    const issueId = await createIssue("in_progress");

    await issueService(db).update(issueId, { status: "in_review" });

    expect(lifecycleEvents("task_transition")).toEqual([
      expect.objectContaining({ issueId, fromStatus: "in_progress", toStatus: "in_review", terminal: false }),
    ]);
  });

  it("logs no task transition for an update that keeps the status or rolls back", async () => {
    const issueId = await createIssue("todo");

    await issueService(db).update(issueId, { title: "Renamed task" });
    await expect(db.transaction(async (tx) => {
      await issueService(db).update(issueId, { status: "in_progress" }, tx);
      throw new Error("roll back");
    })).rejects.toThrow("roll back");

    expect(lifecycleEvents("task_transition")).toEqual([]);
  });

  it("gives each transition of a task its own event id", async () => {
    const issueId = await createIssue("todo");
    const svc = issueService(db);

    for (const status of ["in_progress", "todo", "in_progress", "done"] as const) {
      await svc.update(issueId, { status });
    }

    const eventIds = lifecycleEvents("task_transition").map((event) => (event as { eventId: string }).eventId);
    expect(new Set(eventIds).size).toBe(4);
  });
});
