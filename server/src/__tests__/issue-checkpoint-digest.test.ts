import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  postIssueCheckpointDigest,
  postParkCheckpointsForAgent,
} from "../services/issue-checkpoint-digest.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue-checkpoint-digest tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue-checkpoint-digest (TSMC-20213)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-checkpoint-digest-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("posts a takeover digest with summary, next action, blockers, and redaction", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const blockerId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TSMC",
      issuePrefix: "TSMC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        identifier: "TSMC-20213",
        title: "Failover checkpoint",
        status: "in_progress",
        priority: "critical",
        assigneeAgentId: agentId,
      },
      {
        id: blockerId,
        companyId,
        identifier: "TSMC-999",
        title: "Open blocker",
        status: "todo",
        priority: "high",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-08-06T09:00:00.000Z"),
      finishedAt: new Date("2026-08-06T09:05:00.000Z"),
      contextSnapshot: { issueId },
      nextAction: "Implement park checkpoint path",
      resultJson: {
        summary:
          "Landed takeover digest. Remaining: checkpoint-on-park. token Bearer sk-abcdefghijklmnopqrstuvwxyz123456 should redact.",
      },
    });

    const result = await postIssueCheckpointDigest(db, {
      companyId,
      issueId,
      agentId,
      kind: "takeover",
      contextLine: "Fallback reassigned → sister",
    });
    expect(result.posted).toBe(true);
    expect(result.bodyLength).toBeGreaterThan(40);

    const comments = await db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    expect(comments).toHaveLength(1);
    const body = comments[0]!.body;
    expect(body).toContain("## Takeover checkpoint (auto-generated");
    expect(body).toContain("Implement park checkpoint path");
    expect(body).toContain("TSMC-999");
    expect(body).toContain("Resume from here");
    expect(body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(body).toMatch(/\[redacted/i);
  });

  it("posts park checkpoints for non-terminal assigned issues on lane park", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const activeId = randomUUID();
    const doneId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TSMC",
      issuePrefix: "TSMC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "paused",
      pauseReason: "session_limit",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: activeId,
        companyId,
        identifier: "TSMC-1",
        title: "Active",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: doneId,
        companyId,
        identifier: "TSMC-2",
        title: "Done",
        status: "done",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "succeeded",
      startedAt: new Date("2026-08-06T08:00:00.000Z"),
      finishedAt: new Date("2026-08-06T08:10:00.000Z"),
      contextSnapshot: { issueId: activeId },
      resultJson: { summary: "Halfway through park path." },
      nextAction: "Finish tests",
    });

    const result = await postParkCheckpointsForAgent(db, {
      companyId,
      agentId,
      pauseReason: "session_limit",
    });
    expect(result.issuesConsidered).toBe(1);
    expect(result.posted).toBe(1);

    const activeComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, activeId));
    expect(activeComments).toHaveLength(1);
    expect(activeComments[0]!.body).toContain("## Park checkpoint (auto-generated");
    expect(activeComments[0]!.body).toContain("Halfway through park path");

    const doneComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, doneId));
    expect(doneComments).toHaveLength(0);
  });
});
