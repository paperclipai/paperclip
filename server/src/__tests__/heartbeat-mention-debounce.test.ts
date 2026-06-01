// BEY-1751: @-Mention-Debounce im Heartbeat-Service.
// Zwei aufeinanderfolgende Mention-Wakes auf denselben Agent + dasselbe Issue
// innerhalb des Debounce-Fensters (Default 60s, via PAPERCLIP_MENTION_DEBOUNCE_MS
// überschreibbar) collapsen zu einem einzigen Wake. Der zweite Wake wird mit
// status "skipped" / reason "mention_debounced" geloggt; coalescedCount auf
// dem vorhandenen Wake-Request wird erhöht.

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

describe("heartbeat mention debounce", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-mention-debounce-");
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_MENTION_DEBOUNCE_MS;
  });

  async function seedMentionScenario() {
    const companyId = randomUUID();
    const authorAgentId = randomUUID();
    const mentionedAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: authorAgentId,
        companyId,
        name: "Author Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: mentionedAgentId,
        companyId,
        name: "Mentioned Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mention debounce guard",
      status: "todo",
      priority: "medium",
      assigneeAgentId: authorAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, authorAgentId, mentionedAgentId, issueId };
  }

  async function createMentionComment(opts: {
    companyId: string;
    issueId: string;
    authorAgentId: string;
    body: string;
  }) {
    return db
      .insert(issueComments)
      .values({
        companyId: opts.companyId,
        issueId: opts.issueId,
        authorAgentId: opts.authorAgentId,
        body: opts.body,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  it("collapsed zwei Mentions auf denselben Agent + Issue innerhalb 60s zu einem Wake", async () => {
    const { companyId, authorAgentId, mentionedAgentId, issueId } = await seedMentionScenario();
    const heartbeat = heartbeatService(db);

    const firstComment = await createMentionComment({
      companyId,
      issueId,
      authorAgentId,
      body: "Erster @-Mention",
    });

    const firstRun = await heartbeat.wakeup(mentionedAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId: firstComment.id },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: firstComment.id,
        wakeCommentId: firstComment.id,
        wakeReason: "issue_comment_mentioned",
      },
      requestedByActorType: "agent",
      requestedByActorId: authorAgentId,
    });
    expect(firstRun).not.toBeNull();

    const secondComment = await createMentionComment({
      companyId,
      issueId,
      authorAgentId,
      body: "Zweiter @-Mention kurz danach",
    });

    const secondRun = await heartbeat.wakeup(mentionedAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId: secondComment.id },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: secondComment.id,
        wakeCommentId: secondComment.id,
        wakeReason: "issue_comment_mentioned",
      },
      requestedByActorType: "agent",
      requestedByActorId: authorAgentId,
    });
    expect(secondRun).toBeNull();

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, mentionedAgentId),
        ),
      )
      .orderBy(asc(agentWakeupRequests.requestedAt));

    expect(wakeups).toHaveLength(2);

    const queuedWake = wakeups.find(
      (row) => row.reason === "issue_comment_mentioned" && row.status !== "skipped",
    );
    const skippedWake = wakeups.find((row) => row.status === "skipped");
    expect(queuedWake).toBeDefined();
    expect(skippedWake).toBeDefined();
    expect(skippedWake?.reason).toBe("mention_debounced");
    expect(queuedWake?.coalescedCount ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("respektiert PAPERCLIP_MENTION_DEBOUNCE_MS=0 (Debounce deaktiviert)", async () => {
    process.env.PAPERCLIP_MENTION_DEBOUNCE_MS = "0";
    const { companyId, authorAgentId, mentionedAgentId, issueId } = await seedMentionScenario();
    const heartbeat = heartbeatService(db);

    const firstComment = await createMentionComment({
      companyId,
      issueId,
      authorAgentId,
      body: "Erster @-Mention",
    });
    await heartbeat.wakeup(mentionedAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId: firstComment.id },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: firstComment.id,
        wakeCommentId: firstComment.id,
        wakeReason: "issue_comment_mentioned",
      },
      requestedByActorType: "agent",
      requestedByActorId: authorAgentId,
    });

    const secondComment = await createMentionComment({
      companyId,
      issueId,
      authorAgentId,
      body: "Zweiter @-Mention",
    });
    await heartbeat.wakeup(mentionedAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId: secondComment.id },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: secondComment.id,
        wakeCommentId: secondComment.id,
        wakeReason: "issue_comment_mentioned",
      },
      requestedByActorType: "agent",
      requestedByActorId: authorAgentId,
    });

    // Debounce ist deaktiviert → KEIN "mention_debounced"-Skip-Eintrag.
    const debouncedSkips = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, mentionedAgentId),
          eq(agentWakeupRequests.reason, "mention_debounced"),
        ),
      );
    expect(debouncedSkips).toHaveLength(0);
  });

  it("collapsed nicht über verschiedene Issues hinweg", async () => {
    const { companyId, authorAgentId, mentionedAgentId, issueId } = await seedMentionScenario();
    const heartbeat = heartbeatService(db);

    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Other issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: authorAgentId,
      issueNumber: 2,
      identifier: "OTHER-2",
    });

    const firstComment = await createMentionComment({
      companyId,
      issueId,
      authorAgentId,
      body: "Mention auf Issue 1",
    });
    const firstRun = await heartbeat.wakeup(mentionedAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId: firstComment.id },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: firstComment.id,
        wakeCommentId: firstComment.id,
        wakeReason: "issue_comment_mentioned",
      },
      requestedByActorType: "agent",
      requestedByActorId: authorAgentId,
    });
    expect(firstRun).not.toBeNull();

    const otherComment = await createMentionComment({
      companyId,
      issueId: otherIssueId,
      authorAgentId,
      body: "Mention auf Issue 2",
    });
    const secondRun = await heartbeat.wakeup(mentionedAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId: otherIssueId, commentId: otherComment.id },
      contextSnapshot: {
        issueId: otherIssueId,
        taskId: otherIssueId,
        commentId: otherComment.id,
        wakeCommentId: otherComment.id,
        wakeReason: "issue_comment_mentioned",
      },
      requestedByActorType: "agent",
      requestedByActorId: authorAgentId,
    });
    expect(secondRun).not.toBeNull();

    const debouncedSkips = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, mentionedAgentId),
          eq(agentWakeupRequests.status, "skipped"),
          eq(agentWakeupRequests.reason, "mention_debounced"),
        ),
      );
    expect(debouncedSkips).toHaveLength(0);
  });
});
