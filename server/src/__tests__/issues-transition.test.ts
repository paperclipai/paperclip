import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documents,
  instanceSettings,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue transition tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issueService.update status transition guard", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-transition-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setup(opts: {
    initialStatus: string;
    withReviewGate?: boolean;
    reviewGateKey?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue at ${opts.initialStatus}`,
      status: opts.initialStatus,
      priority: "medium",
      assigneeAgentId: agentId,
      createdByAgentId: agentId,
    });

    if (opts.withReviewGate) {
      const documentId = randomUUID();
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Spec doc",
        latestBody: "# Spec body",
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: opts.reviewGateKey ?? "spec",
      });
    }

    return { companyId, agentId, issueId };
  }

  it("rejects an unknown destination status with 409", async () => {
    const { issueId } = await setup({ initialStatus: "todo" });
    await expect(svc.update(issueId, { status: "wat" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("walks the full happy path backlog -> todo -> in_progress -> in_review -> done", async () => {
    const { issueId } = await setup({ initialStatus: "backlog" });
    let row = await svc.update(issueId, { status: "todo" });
    expect(row?.status).toBe("todo");
    row = await svc.update(issueId, { status: "in_progress" });
    expect(row?.status).toBe("in_progress");
    row = await svc.update(issueId, { status: "in_review" });
    expect(row?.status).toBe("in_review");
    row = await svc.update(issueId, { status: "done" });
    expect(row?.status).toBe("done");
  });

  it("allows todo -> done when no review gate is present", async () => {
    const { issueId } = await setup({ initialStatus: "todo" });
    const row = await svc.update(issueId, { status: "done" });
    expect(row?.status).toBe("done");
  });

  it("rejects todo -> done when a review gate is present (review-gate guard fires on any from !== in_review)", async () => {
    const { issueId } = await setup({ initialStatus: "todo", withReviewGate: true });
    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects todo -> in_review (matrix requires transit via in_progress)", async () => {
    // The ALLOWED_TRANSITIONS matrix in services/issues.ts intentionally
    // does NOT include `in_review` in the `todo` source set: review pickup
    // happens via `in_progress` (work-then-review) rather than as a direct
    // skip from `todo`. If a workflow needs early-review-pickup, the matrix
    // is the right place to relax it; for now the strict pipeline keeps
    // execution lifecycle observable.
    const { issueId } = await setup({ initialStatus: "todo" });
    await expect(svc.update(issueId, { status: "in_review" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects in_progress -> done when a review gate is present", async () => {
    const { issueId } = await setup({ initialStatus: "in_progress", withReviewGate: true });
    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("allows in_progress -> done when no review gate is present", async () => {
    const { issueId } = await setup({ initialStatus: "in_progress" });
    const row = await svc.update(issueId, { status: "done" });
    expect(row?.status).toBe("done");
  });

  it("treats deliverable / qa / brief document keys as review gates too", async () => {
    for (const key of ["deliverable", "qa", "brief"] as const) {
      const { issueId } = await setup({
        initialStatus: "in_progress",
        withReviewGate: true,
        reviewGateKey: key,
      });
      await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
        status: 409,
      });
    }
  });

  it("allows done -> in_review for Bypass Sweep reversion", async () => {
    const { issueId } = await setup({ initialStatus: "done" });
    const row = await svc.update(issueId, { status: "in_review" });
    expect(row?.status).toBe("in_review");
  });

  it("allows done -> in_progress for re-open after close", async () => {
    const { issueId } = await setup({ initialStatus: "done" });
    const row = await svc.update(issueId, { status: "in_progress" });
    expect(row?.status).toBe("in_progress");
  });

  it("allows cancelled -> todo for un-cancel", async () => {
    const { issueId } = await setup({ initialStatus: "cancelled" });
    const row = await svc.update(issueId, { status: "todo" });
    expect(row?.status).toBe("todo");
  });

  it("rejects backlog -> done with 409", async () => {
    const { issueId } = await setup({ initialStatus: "backlog" });
    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("allows in_review -> todo for upstream acceptInteraction flow", async () => {
    // v2026.428.0 acceptInteraction (board user accepts agent-authored request)
    // moves the issue from in_review back to todo so the agent can pick it up.
    // Original 0005 design forbade this transition; relaxed at P-037j.1 rebase.
    const { issueId } = await setup({ initialStatus: "in_review" });
    const row = await svc.update(issueId, { status: "todo" });
    expect(row?.status).toBe("todo");
  });

  it("allows in_progress -> todo (downgrade by mistake)", async () => {
    const { issueId } = await setup({ initialStatus: "in_progress" });
    const row = await svc.update(issueId, { status: "todo" });
    expect(row?.status).toBe("todo");
  });

  it("treats same-to-same status as a no-op (idempotent)", async () => {
    const { issueId } = await setup({ initialStatus: "in_progress" });
    const row = await svc.update(issueId, { status: "in_progress" });
    expect(row?.status).toBe("in_progress");
  });

  it("emits an activityLog reverse_transition event on done -> in_review", async () => {
    const { companyId, issueId } = await setup({ initialStatus: "done" });
    await svc.update(issueId, { status: "in_review" });
    const logs = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.status.reverse_transition"),
        ),
      );
    expect(logs.length).toBe(1);
    expect(logs[0]!.actorType).toBe("system");
    expect(logs[0]!.actorId).toBe("issues.update");
    expect(logs[0]!.details).toMatchObject({
      from: "done",
      to: "in_review",
    });
  });

  it("emits an activityLog reverse_transition event on cancelled -> todo (un-cancel)", async () => {
    // Parallel to the done-revert audit: un-cancelling work leaves the
    // terminal-state footprint behind and downstream consumers (reporting,
    // productivity-review) need to see the trail entry to reason about the
    // lifecycle correctly.
    const { companyId, issueId } = await setup({ initialStatus: "cancelled" });
    await svc.update(issueId, { status: "todo" });
    const logs = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.status.reverse_transition"),
        ),
      );
    expect(logs.length).toBe(1);
    expect(logs[0]!.actorType).toBe("system");
    expect(logs[0]!.actorId).toBe("issues.update");
    expect(logs[0]!.details).toMatchObject({
      from: "cancelled",
      to: "todo",
      reason: "cancelled state un-cancelled",
    });
  });
});
