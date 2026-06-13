import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issues,
  projects,
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
    `Skipping embedded Postgres issue dedup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

describeEmbeddedPostgres("issue create dedupByFingerprint", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-dedup-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (tempDb) await tempDb.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Recurring",
      status: "in_progress",
    });

    return { companyId, agentId, projectId, svc: issueService(db) };
  }

  async function openIssuesFor(companyId: string, originFingerprint: string) {
    return db
      .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originFingerprint, originFingerprint),
          inArray(issues.status, [...OPEN_STATUSES]),
        ),
      );
  }

  it("cancels the prior open issue with the same fingerprint + assignee", async () => {
    const { companyId, agentId, projectId, svc } = await seed();

    const first = await svc.create(companyId, {
      projectId,
      title: "Strategic review (run 1)",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "manual",
      originFingerprint: "strategic-review",
      dedupByFingerprint: true,
    });

    const second = await svc.create(companyId, {
      projectId,
      title: "Strategic review (run 2)",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "manual",
      originFingerprint: "strategic-review",
      dedupByFingerprint: true,
    });

    const open = await openIssuesFor(companyId, "strategic-review");
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe(second.id);

    const [firstRow] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, first.id));
    expect(firstRow?.status).toBe("cancelled");
  });

  it("posts a superseded-by comment on the cancelled issue", async () => {
    const { companyId, agentId, projectId, svc } = await seed();

    const first = await svc.create(companyId, {
      projectId,
      title: "Strategic review (run 1)",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "manual",
      originFingerprint: "strategic-review",
      dedupByFingerprint: true,
    });

    const second = await svc.create(companyId, {
      projectId,
      title: "Strategic review (run 2)",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "manual",
      originFingerprint: "strategic-review",
      dedupByFingerprint: true,
    });

    const comments = await db
      .select({ body: issueComments.body, issueId: issueComments.issueId })
      .from(issueComments)
      .where(eq(issueComments.issueId, first.id));

    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(second.identifier ?? "");
    expect(comments[0]?.body).toContain("superseded by");
  });

  it("does not dedup the sentinel 'default' fingerprint", async () => {
    const { companyId, agentId, projectId, svc } = await seed();

    await svc.create(companyId, {
      projectId,
      title: "Default fp (run 1)",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "manual",
      originFingerprint: "default",
      dedupByFingerprint: true,
    });

    await svc.create(companyId, {
      projectId,
      title: "Default fp (run 2)",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "manual",
      originFingerprint: "default",
      dedupByFingerprint: true,
    });

    const open = await openIssuesFor(companyId, "default");
    expect(open).toHaveLength(2);
  });

  it("does not cancel across different assignees", async () => {
    const { companyId, agentId, projectId, svc } = await seed();

    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Engineer 2",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await svc.create(companyId, {
      projectId,
      title: "Shared fingerprint, agent A",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "manual",
      originFingerprint: "morning-brief",
      dedupByFingerprint: true,
    });

    await svc.create(companyId, {
      projectId,
      title: "Shared fingerprint, agent B",
      status: "todo",
      priority: "high",
      assigneeAgentId: otherAgentId,
      originKind: "manual",
      originFingerprint: "morning-brief",
      dedupByFingerprint: true,
    });

    const open = await openIssuesFor(companyId, "morning-brief");
    expect(open).toHaveLength(2);
    expect(new Set(open.map((row) => row.assigneeAgentId))).toEqual(new Set([agentId, otherAgentId]));
  });

  it("auto-dedups manual recurring issues with a stable fingerprint even without the flag", async () => {
    const { companyId, agentId, projectId, svc } = await seed();

    // Simulates the real strategic-review generator (GRA-2691): manual origin +
    // stable fingerprint, but the caller never passes dedupByFingerprint.
    const first = await svc.create(companyId, {
      projectId,
      title: "Strategic review (run 1)",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "manual",
      originFingerprint: "strategic-review",
    });

    const second = await svc.create(companyId, {
      projectId,
      title: "Strategic review (run 2)",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "manual",
      originFingerprint: "strategic-review",
    });

    const open = await openIssuesFor(companyId, "strategic-review");
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe(second.id);

    const [firstRow] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, first.id));
    expect(firstRow?.status).toBe("cancelled");
  });

  it("respects an explicit dedupByFingerprint:false opt-out", async () => {
    const { companyId, agentId, projectId, svc } = await seed();

    await svc.create(companyId, {
      projectId,
      title: "No-dedup (run 1)",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "manual",
      originFingerprint: "ad-hoc-batch",
      dedupByFingerprint: false,
    });

    await svc.create(companyId, {
      projectId,
      title: "No-dedup (run 2)",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "manual",
      originFingerprint: "ad-hoc-batch",
      dedupByFingerprint: false,
    });

    const open = await openIssuesFor(companyId, "ad-hoc-batch");
    expect(open).toHaveLength(2);
  });
});
