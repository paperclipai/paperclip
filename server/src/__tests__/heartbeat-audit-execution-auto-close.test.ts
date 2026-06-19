import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

let dbSupport: Awaited<ReturnType<typeof getEmbeddedPostgresTestSupport>>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  dbSupport = await getEmbeddedPostgresTestSupport();
  const port = await startEmbeddedPostgresTestDatabase(dbSupport);
  const databaseUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/test_db`;
  db = createDb(databaseUrl);
});

afterEach(async () => {
  // Clean up test data
  await db.delete(issues);
  await db.delete(heartbeatRuns);
  await db.delete(agents);
  await db.delete(companies);
});

afterAll(async () => {
  await dbSupport.closePool();
  await dbSupport.shutdownEmbeddedPostgres();
});

describe("autoCloseStaleAuditExecutionIssues", () => {
  it("closes audit-execution issues that remain in_progress for >30 minutes", async () => {
    // Setup
    const company = await db.insert(companies).values({
      id: randomUUID(),
      name: "Test Company",
      status: "active",
    }).returning();
    const companyId = company[0].id;

    const agent = await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name: "Test Agent",
      adapterType: "test",
      status: "active",
    }).returning();
    const agentId = agent[0].id;

    // Create a routine execution run
    const routineRun = await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "done",
    }).returning();
    const routineRunId = routineRun[0].id;

    // Create an audit-execution issue that's been in_progress for 40 minutes
    const now = new Date();
    const thirtyFiveMinutesAgo = new Date(now.getTime() - 35 * 60 * 1000);

    const auditIssue = await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Audit Execution",
      status: "in_progress",
      originKind: "routine_execution",
      originRunId: routineRunId,
      updatedAt: thirtyFiveMinutesAgo,
    }).returning();
    const issueId = auditIssue[0].id;

    // Run the auto-close function
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.autoCloseStaleAuditExecutionIssues({ now });

    // Verify the issue was closed
    expect(result.scanned).toBe(1);
    expect(result.closed).toBe(1);

    const [closedIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(closedIssue.status).toBe("done");
  });

  it("does not close audit-execution issues that have been updated recently", async () => {
    // Setup
    const company = await db.insert(companies).values({
      id: randomUUID(),
      name: "Test Company",
      status: "active",
    }).returning();
    const companyId = company[0].id;

    const agent = await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name: "Test Agent",
      adapterType: "test",
      status: "active",
    }).returning();
    const agentId = agent[0].id;

    // Create a routine execution run
    const routineRun = await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "done",
    }).returning();
    const routineRunId = routineRun[0].id;

    // Create an audit-execution issue updated just 10 minutes ago
    const now = new Date();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

    const auditIssue = await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Audit Execution",
      status: "in_progress",
      originKind: "routine_execution",
      originRunId: routineRunId,
      updatedAt: tenMinutesAgo,
    }).returning();
    const issueId = auditIssue[0].id;

    // Run the auto-close function
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.autoCloseStaleAuditExecutionIssues({ now });

    // Verify the issue was NOT closed
    expect(result.scanned).toBe(0);
    expect(result.closed).toBe(0);

    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(issue.status).toBe("in_progress");
  });

  it("ignores non-routine_execution issues", async () => {
    // Setup
    const company = await db.insert(companies).values({
      id: randomUUID(),
      name: "Test Company",
      status: "active",
    }).returning();
    const companyId = company[0].id;

    // Create a non-routine issue that's been in_progress for 40 minutes
    const now = new Date();
    const thirtyFiveMinutesAgo = new Date(now.getTime() - 35 * 60 * 1000);

    const manualIssue = await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Manual Issue",
      status: "in_progress",
      originKind: "manual",
      updatedAt: thirtyFiveMinutesAgo,
    }).returning();
    const issueId = manualIssue[0].id;

    // Run the auto-close function
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.autoCloseStaleAuditExecutionIssues({ now });

    // Verify the issue was NOT closed
    expect(result.scanned).toBe(0);
    expect(result.closed).toBe(0);

    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(issue.status).toBe("in_progress");
  });

  it("closes audit-execution issues that remain todo for >30 minutes", async () => {
    // Setup
    const company = await db.insert(companies).values({
      id: randomUUID(),
      name: "Test Company",
      status: "active",
    }).returning();
    const companyId = company[0].id;

    const agent = await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name: "Test Agent",
      adapterType: "test",
      status: "active",
    }).returning();
    const agentId = agent[0].id;

    // Create a routine execution run
    const routineRun = await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "done",
    }).returning();
    const routineRunId = routineRun[0].id;

    // Create an audit-execution issue that's been todo for 35 minutes (never picked up)
    const now = new Date();
    const thirtyFiveMinutesAgo = new Date(now.getTime() - 35 * 60 * 1000);

    const auditIssue = await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Audit Execution",
      status: "todo",
      originKind: "routine_execution",
      originRunId: routineRunId,
      updatedAt: thirtyFiveMinutesAgo,
    }).returning();
    const issueId = auditIssue[0].id;

    // Run the auto-close function
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.autoCloseStaleAuditExecutionIssues({ now });

    // Verify the issue was closed
    expect(result.scanned).toBe(1);
    expect(result.closed).toBe(1);

    const [closedIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(closedIssue.status).toBe("done");
  });

  it("does not close audit-execution todo issues updated recently", async () => {
    // Setup
    const company = await db.insert(companies).values({
      id: randomUUID(),
      name: "Test Company",
      status: "active",
    }).returning();
    const companyId = company[0].id;

    const agent = await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name: "Test Agent",
      adapterType: "test",
      status: "active",
    }).returning();
    const agentId = agent[0].id;

    // Create a routine execution run
    const routineRun = await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "done",
    }).returning();
    const routineRunId = routineRun[0].id;

    // Create an audit-execution todo issue updated just 5 minutes ago
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    const auditIssue = await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Audit Execution",
      status: "todo",
      originKind: "routine_execution",
      originRunId: routineRunId,
      updatedAt: fiveMinutesAgo,
    }).returning();
    const issueId = auditIssue[0].id;

    // Run the auto-close function
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.autoCloseStaleAuditExecutionIssues({ now });

    // Verify the issue was NOT closed
    expect(result.scanned).toBe(0);
    expect(result.closed).toBe(0);

    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(issue.status).toBe("todo");
  });

  it("supports custom timeout values", async () => {
    // Setup
    const company = await db.insert(companies).values({
      id: randomUUID(),
      name: "Test Company",
      status: "active",
    }).returning();
    const companyId = company[0].id;

    const agent = await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name: "Test Agent",
      adapterType: "test",
      status: "active",
    }).returning();
    const agentId = agent[0].id;

    // Create a routine execution run
    const routineRun = await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "done",
    }).returning();
    const routineRunId = routineRun[0].id;

    // Create an audit-execution issue that's been in_progress for 15 minutes
    const now = new Date();
    const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);

    const auditIssue = await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Audit Execution",
      status: "in_progress",
      originKind: "routine_execution",
      originRunId: routineRunId,
      updatedAt: fifteenMinutesAgo,
    }).returning();
    const issueId = auditIssue[0].id;

    // Run with a 10-minute timeout (should close the issue)
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.autoCloseStaleAuditExecutionIssues({
      now,
      timeoutMs: 10 * 60 * 1000,
    });

    // Verify the issue was closed
    expect(result.scanned).toBe(1);
    expect(result.closed).toBe(1);

    const [closedIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(closedIssue.status).toBe("done");
  });
});
