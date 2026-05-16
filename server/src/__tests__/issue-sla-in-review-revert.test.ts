import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres SLA in-review revert tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("SLA in-review auto-revert", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sla-in-review-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function cleanupRows() {
    await db.delete(heartbeatRunEvents);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: {
    priority?: string;
    inReviewAt?: Date;
    assigneeAgentId?: string | null;
    issueStatus?: string;
  }) {
    const companyId = randomUUID();
    const agentId = input?.assigneeAgentId === null ? null : randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "SLA Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    if (agentId) {
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Reviewer Bot",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", ""],
          cwd: process.cwd(),
        },
        runtimeConfig: {
          heartbeat: { enabled: false, wakeOnDemand: true },
        },
        permissions: {},
      });
    }

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test in-review issue",
      status: input?.issueStatus ?? "in_review",
      priority: input?.priority ?? "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      inReviewAt: input?.inReviewAt ?? new Date("2026-04-10T00:00:00.000Z"),
    });

    return { companyId, agentId, issueId };
  }

  it("reverts a medium-priority issue after 72h SLA expires", async () => {
    const inReviewAt = new Date("2026-04-10T00:00:00.000Z");
    const { issueId, agentId } = await seedFixture({ priority: "medium", inReviewAt });
    const heartbeat = heartbeatService(db);
    const now = new Date("2026-04-13T00:01:00.000Z"); // 72h + 1min

    const result = await heartbeat.tickTimers(now);

    expect(result.enqueued).toBeGreaterThanOrEqual(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    expect(issue.status).toBe("in_progress");
    expect(issue.inReviewAt).toBeNull();

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments.length).toBe(1);
    expect(comments[0]!.body).toContain("SLA auto-revert");
    expect(comments[0]!.body).toContain("medium");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((r) => r.action));
    expect(activity).toContain("issue.sla_in_review_reverted");

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId!))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).not.toBeNull();
    expect(wakeup!.reason).toBe("issue_sla_in_review_reverted");
  });

  it("does not revert when SLA has not expired", async () => {
    const inReviewAt = new Date("2026-04-10T00:00:00.000Z");
    const { issueId } = await seedFixture({ priority: "medium", inReviewAt });
    const heartbeat = heartbeatService(db);
    const now = new Date("2026-04-12T23:00:00.000Z"); // 71h — within SLA

    await heartbeat.tickTimers(now);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    expect(issue.status).toBe("in_review");
    expect(issue.inReviewAt).not.toBeNull();
  });

  it("reverts critical-priority issue after 4h SLA", async () => {
    const inReviewAt = new Date("2026-04-10T12:00:00.000Z");
    const { issueId } = await seedFixture({ priority: "critical", inReviewAt });
    const heartbeat = heartbeatService(db);
    const now = new Date("2026-04-10T16:01:00.000Z"); // 4h + 1min

    await heartbeat.tickTimers(now);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    expect(issue.status).toBe("in_progress");
  });

  it("reverts high-priority issue after 24h SLA", async () => {
    const inReviewAt = new Date("2026-04-10T00:00:00.000Z");
    const { issueId } = await seedFixture({ priority: "high", inReviewAt });
    const heartbeat = heartbeatService(db);
    const now = new Date("2026-04-11T00:01:00.000Z"); // 24h + 1min

    await heartbeat.tickTimers(now);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    expect(issue.status).toBe("in_progress");
  });

  it("reverts low-priority issue after 7d SLA", async () => {
    const inReviewAt = new Date("2026-04-01T00:00:00.000Z");
    const { issueId } = await seedFixture({ priority: "low", inReviewAt });
    const heartbeat = heartbeatService(db);
    const now = new Date("2026-04-08T00:01:00.000Z"); // 7d + 1min

    await heartbeat.tickTimers(now);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    expect(issue.status).toBe("in_progress");
  });

  it("reverts to todo when no assignee agent", async () => {
    const inReviewAt = new Date("2026-04-10T00:00:00.000Z");
    const { issueId } = await seedFixture({
      priority: "medium",
      inReviewAt,
      assigneeAgentId: null,
    });
    const heartbeat = heartbeatService(db);
    const now = new Date("2026-04-13T00:01:00.000Z");

    await heartbeat.tickTimers(now);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    expect(issue.status).toBe("todo");

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments[0]!.body).toContain("`todo`");
  });

  it("expires pending request_confirmation interactions on revert", async () => {
    const inReviewAt = new Date("2026-04-10T00:00:00.000Z");
    const { issueId, companyId } = await seedFixture({ priority: "medium", inReviewAt });

    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { type: "request_confirmation", message: "Approve?" },
    });

    const heartbeat = heartbeatService(db);
    const now = new Date("2026-04-13T00:01:00.000Z");

    await heartbeat.tickTimers(now);

    const interactions = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issueId));
    expect(interactions.length).toBe(1);
    expect(interactions[0]!.status).toBe("expired");
    expect((interactions[0]!.result as any)?.outcome).toBe("sla_expired");
  });

  it("does not touch issues not in in_review status", async () => {
    const inReviewAt = new Date("2026-04-10T00:00:00.000Z");
    const { issueId } = await seedFixture({
      priority: "medium",
      inReviewAt,
      issueStatus: "in_progress",
    });
    const heartbeat = heartbeatService(db);
    const now = new Date("2026-04-13T00:01:00.000Z");

    await heartbeat.tickTimers(now);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    expect(issue.status).toBe("in_progress");
  });
});
