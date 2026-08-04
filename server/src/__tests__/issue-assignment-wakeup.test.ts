import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-assignment-wakeup durability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("queueIssueAssignmentWakeup durability", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("issue-assignment-wakeup-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Assignment Wakeup Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("persists a failed agentWakeupRequests record when the heartbeat wake rejects", async () => {
    const { companyId, agentId } = await insertAgent();
    const issueId = randomUUID();

    const result = await queueIssueAssignmentWakeup({
      db,
      heartbeat: {
        wakeup: async () => {
          throw new Error("boom: unexpected wakeup failure");
        },
      },
      issue: { id: issueId, assigneeAgentId: agentId, status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.assignment.test",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });

    expect(result).toBeNull();

    const failed = await db
      .select({
        companyId: agentWakeupRequests.companyId,
        agentId: agentWakeupRequests.agentId,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .then((rows) => rows.find((row) => row.agentId === agentId) ?? null);

    expect(failed).toMatchObject({
      companyId,
      status: "failed",
      reason: "issue_assignment_wakeup_failed",
      error: "boom: unexpected wakeup failure",
    });
  });

  it("still persists the failed record before rethrowing when rethrowOnError is set", async () => {
    const { agentId } = await insertAgent();
    const issueId = randomUUID();

    await expect(
      queueIssueAssignmentWakeup({
        db,
        heartbeat: {
          wakeup: async () => {
            throw new Error("boom: dispatch-lock wakeup failure");
          },
        },
        issue: { id: issueId, assigneeAgentId: agentId, status: "todo" },
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "routine.dispatch",
        requestedByActorType: "system",
        rethrowOnError: true,
      }),
    ).rejects.toThrow("boom: dispatch-lock wakeup failure");

    const failed = await db
      .select({ agentId: agentWakeupRequests.agentId, status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .then((rows) => rows.find((row) => row.agentId === agentId) ?? null);

    expect(failed).toMatchObject({
      status: "failed",
      reason: "issue_assignment_wakeup_failed",
    });
  });

  it("does not queue a wake or write a record for backlog issues", async () => {
    const { agentId } = await insertAgent();
    const issueId = randomUUID();
    let wakeupCalled = false;

    const result = await queueIssueAssignmentWakeup({
      db,
      heartbeat: {
        wakeup: async () => {
          wakeupCalled = true;
          return null;
        },
      },
      issue: { id: issueId, assigneeAgentId: agentId, status: "backlog" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.assignment.test",
    });

    expect(result).toBeUndefined();
    expect(wakeupCalled).toBe(false);

    const rows = await db
      .select({ agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .then((rows2) => rows2.filter((row) => row.agentId === agentId));
    expect(rows).toHaveLength(0);
  });
});
