import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueWatchdogs,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-watchdog auto-set tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("auto-set Watchdog on task blocking (DES-34)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-watchdog-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issueWatchdogs);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function uniqueIssuePrefix() {
    return `B${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
  }

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: overrides.name ?? "Agent",
      role: overrides.role ?? "engineer",
      status: overrides.status ?? "active",
      adapterType: overrides.adapterType ?? "codex_local",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: overrides.permissions ?? {},
      reportsTo: overrides.reportsTo,
    });
    return id;
  }

  async function activeWatchdogAgentId(companyId: string, issueId: string) {
    const watchdog = await taskWatchdogService(db).getActiveForIssue(companyId, issueId);
    return watchdog?.watchdogAgentId ?? null;
  }

  it("sets Watchdog to the assignee's manager when a task becomes blocked, and clears it on unblock", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { name: "Theo (manager)", role: "pm" });
    const assigneeId = await seedAgent(companyId, { name: "Maya", role: "engineer", reportsTo: managerId });
    const svc = issueService(db);

    const issue = await svc.create(companyId, {
      title: "Task that will block",
      status: "in_progress",
      assigneeAgentId: assigneeId,
    } as any);

    // Entering blocked -> Watchdog = assignee.manager
    await svc.update(issue.id, { status: "blocked", actorAgentId: assigneeId });
    expect(await activeWatchdogAgentId(companyId, issue.id)).toBe(managerId);

    // Leaving blocked -> Watchdog cleared (None)
    await svc.update(issue.id, { status: "in_progress", actorAgentId: assigneeId });
    expect(await activeWatchdogAgentId(companyId, issue.id)).toBeNull();
  });

  it("falls back to the company CTO when the assignee has no manager", async () => {
    const companyId = await seedCompany();
    const ctoId = await seedAgent(companyId, { name: "CTO", role: "cto" });
    const assigneeId = await seedAgent(companyId, { name: "Solo", role: "engineer" });
    const svc = issueService(db);

    const issue = await svc.create(companyId, {
      title: "Task with no manager",
      status: "in_progress",
      assigneeAgentId: assigneeId,
    } as any);

    await svc.update(issue.id, { status: "blocked", actorAgentId: assigneeId });
    expect(await activeWatchdogAgentId(companyId, issue.id)).toBe(ctoId);
  });

  it("auto-populates the Watchdog for a task created directly in the blocked state", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { name: "Manager", role: "pm" });
    const assigneeId = await seedAgent(companyId, { name: "Worker", role: "engineer", reportsTo: managerId });
    const svc = issueService(db);

    const issue = await svc.create(companyId, {
      title: "Born blocked",
      status: "blocked",
      assigneeAgentId: assigneeId,
    } as any);

    expect(await activeWatchdogAgentId(companyId, issue.id)).toBe(managerId);
  });
});
