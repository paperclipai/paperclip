import { randomBytes, randomUUID } from "node:crypto";
import { agents, companies, createDb, issueRecoveryActions, issues } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { recoveryService } from "./service.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("recovery issue state reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("recovery-issue-state-");
    db = createDb(database.connectionString);
  });
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  it.each([false, true])("does not load unused source and child descriptions (child=%s)", async (withChild) => {
    const [company] = await db.insert(companies).values({
      name: "Recovery state reads",
      issuePrefix: `R${randomUUID().slice(0, 7).toUpperCase()}`,
    }).returning();
    const description = randomBytes(128 * 1024).toString("base64");
    const [parent] = await db.insert(issues).values({
      companyId: company.id,
      title: "Await the board decision",
      description,
      status: "blocked",
    }).returning();
    const child = withChild
      ? (await db.insert(issues).values({
          companyId: company.id,
          title: "A child that also needs a decision",
          description,
          status: "blocked",
          parentId: parent.id,
        }).returning())[0]
      : null;
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: company.id,
      sourceIssueId: parent.id,
      kind: "stranded_assigned_issue",
      cause: "stranded_assigned_issue",
      fingerprint: randomUUID(),
      status: "active",
      ownerType: "board",
      wakePolicy: { type: "board_escalation" },
      nextAction: "Choose the next disposition",
      evidence: { retainedControl: { proof: "unchanged" } },
    }).returning();
    const enqueueWakeup = vi.fn(async () => {
      throw new Error("Board-owned work must remain pending");
    });
    const service = recoveryService(db, { enqueueWakeup });
    const events: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { issues, issueRecoveryActions }, capture);
    try {
      await service.reconcileStrandedAssignedIssues();
    } finally {
      capture.flush();
    }
    expect(Number(events.at(-1)?.completedQueries)).toBeGreaterThan(5);
    expect(Number(events.at(-1)?.responseValueBytes)).toBeLessThan(16_384);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, parent.id)))[0]).toEqual(parent);
    if (child) {
      expect((await db.select().from(issues).where(eq(issues.id, child.id)))[0]).toEqual(child);
    }
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0]).toEqual(action);
  });

  it("keeps a candidate waiting for agent setup without reading its description", async () => {
    const [company] = await db.insert(companies).values({
      name: "Recovery candidate read",
      issuePrefix: `R${randomUUID().slice(0, 7).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Preparing agent",
      lifecycleState: "preparing",
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Wait for agent setup",
      description: randomBytes(128 * 1024).toString("base64"),
      status: "todo",
      assigneeAgentId: agent.id,
    }).returning();
    const enqueueWakeup = vi.fn(async () => {
      throw new Error("Setup still owns this task");
    });
    const service = recoveryService(db, { enqueueWakeup });
    const events: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { agents, issues, issueRecoveryActions }, capture);
    try {
      expect(await service.reconcileStrandedAssignedIssues()).toMatchObject({ skipped: 1 });
    } finally {
      capture.flush();
    }
    expect(Number(events.at(-1)?.completedQueries)).toBeGreaterThan(5);
    expect(Number(events.at(-1)?.responseValueBytes)).toBeLessThan(16_384);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]).toEqual(issue);
    expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]).toEqual(agent);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, company.id))).toEqual([]);
  });
});
