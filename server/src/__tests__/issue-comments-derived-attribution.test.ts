import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

// Regression test for `enrichCommentsWithDerivedAgentAttribution`:
// the heartbeat-run time-window predicates used to bind raw `Date` objects
// into a postgres-js prepared statement, which threw
// `TypeError [ERR_INVALID_ARG_TYPE] ... Received an instance of Date`
// inside `Buffer.byteLength` and surfaced as a 500 on
// `GET /api/issues/:id/comments` whenever the issue had a user-authored
// comment with no `createdByRunId`. The fix stringifies the bounds with
// `toISOString()` so they bind as text parameters.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-comment derived attribution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function shortPrefix() {
  return `T${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("listComments derived agent attribution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-comments-derived-attr-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns 200 with comments covering all three derivation branches without throwing on Date params", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();

    const agentCommentId = randomUUID();
    const userCommentId = randomUUID();
    const runCommentId = randomUUID();

    const commentCreatedAt = new Date("2026-05-01T10:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: shortPrefix(),
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
      startedAt: new Date(commentCreatedAt.getTime() - 5_000),
      finishedAt: new Date(commentCreatedAt.getTime() + 5_000),
      createdAt: new Date(commentCreatedAt.getTime() - 10_000),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with mixed comment attributions",
      status: "in_progress",
      priority: "medium",
      createdAt: new Date(commentCreatedAt.getTime() - 60_000),
    });

    // a) agent-authored
    await db.insert(issueComments).values({
      id: agentCommentId,
      companyId,
      issueId,
      authorAgentId: agentId,
      authorUserId: null,
      authorType: "agent",
      createdByRunId: runId,
      body: "agent-authored comment",
      createdAt: new Date(commentCreatedAt.getTime() - 1_000),
      updatedAt: new Date(commentCreatedAt.getTime() - 1_000),
    });

    // b) user-authored with no createdByRunId — this is the branch that
    //    used to trigger the 500. The enrichment path must execute the
    //    heartbeatRuns time-window query without throwing.
    await db.insert(issueComments).values({
      id: userCommentId,
      companyId,
      issueId,
      authorAgentId: null,
      authorUserId: "user-123",
      authorType: "user",
      createdByRunId: null,
      body: "user-authored comment with no run id",
      createdAt: commentCreatedAt,
      updatedAt: commentCreatedAt,
    });

    // c) run-log-based derivation (createdByRunId set, no author agent)
    await db.insert(issueComments).values({
      id: runCommentId,
      companyId,
      issueId,
      authorAgentId: null,
      authorUserId: "user-456",
      authorType: "user",
      createdByRunId: runId,
      body: "comment derived from run log",
      createdAt: new Date(commentCreatedAt.getTime() + 1_000),
      updatedAt: new Date(commentCreatedAt.getTime() + 1_000),
    });

    const svc = issueService(db);

    // Must not throw — the bug surfaced as
    // `TypeError [ERR_INVALID_ARG_TYPE] ... Received an instance of Date`
    // inside postgres-js's prepared-statement path.
    const comments = await svc.listComments(issueId, { order: "asc" });

    expect(comments.map((c) => c.id)).toEqual([agentCommentId, userCommentId, runCommentId]);

    const agentComment = comments.find((c) => c.id === agentCommentId);
    const userComment = comments.find((c) => c.id === userCommentId);
    const runComment = comments.find((c) => c.id === runCommentId);

    expect(agentComment?.authorAgentId).toBe(agentId);
    // user-authored with no run id stays user-attributed
    expect(userComment?.authorAgentId).toBeNull();
    expect(userComment?.authorUserId).toBe("user-123");
    // run-log derivation candidate retains its run linkage; derivation
    // only fires when the run log content references the comment, which
    // it doesn't here, so we just assert no enrichment crash + payload shape.
    expect(runComment?.createdByRunId).toBe(runId);
  });

  it("getComment for a single user-authored comment with no run id does not throw", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: shortPrefix(),
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with single user comment",
      status: "in_progress",
      priority: "medium",
    });

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: null,
      authorUserId: "user-123",
      authorType: "user",
      createdByRunId: null,
      body: "lonely user comment",
    });

    const svc = issueService(db);
    const comment = await svc.getComment(commentId);

    expect(comment?.id).toBe(commentId);
    expect(comment?.authorUserId).toBe("user-123");
  });
});
