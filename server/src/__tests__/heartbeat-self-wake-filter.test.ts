// BEY-1737: Self-Wake-Filter und Heartbeat-Mute-Window im Heartbeat-Service.
// Verifiziert, dass enqueueWakeup einen Wake skippt, sobald die ausloesende
// Comment-Author-Agent-Id mit der Empfaenger-Agent-Id uebereinstimmt, und dass
// nach diesem Skip waehrend 5 Minuten kein weiterer Comment-getriebener Wake
// fuer denselben Agent durchgeht.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("heartbeat self-wake filter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-self-wake-");
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function seedAgentAndIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Filter Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Self-wake regression guard",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  it("skipt Comment-Wake, wenn der Comment-Autor die Empfaenger-Agent-Id ist", async () => {
    const { companyId, agentId, issueId } = await seedAgentAndIssue();
    const heartbeat = heartbeatService(db);

    const selfComment = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorAgentId: agentId,
        body: "Eigener Comment vom Empfaenger-Agent",
      })
      .returning()
      .then((rows) => rows[0]);

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: selfComment.id },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: selfComment.id,
        wakeReason: "issue_commented",
      },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });

    expect(run).toBeNull();

    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, agentId),
        ),
      );

    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.status).toBe("skipped");
    expect(skipped[0]?.reason).toBe("self_comment_wake_skipped");
  });

  it("blockiert weitere Comment-Wakes innerhalb des 5-Min-Mute-Windows", async () => {
    const { companyId, agentId, issueId } = await seedAgentAndIssue();
    const heartbeat = heartbeatService(db);

    const selfComment = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorAgentId: agentId,
        body: "Self-comment, oeffnet Mute-Window",
      })
      .returning()
      .then((rows) => rows[0]);

    const firstRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: selfComment.id },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: selfComment.id,
        wakeReason: "issue_commented",
      },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });
    expect(firstRun).toBeNull();

    // Innerhalb des Mute-Windows: Comment von einem Nutzer darf nicht aufwecken.
    const userComment = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorUserId: "user-during-mute",
        body: "Nutzer-Comment waehrend Mute-Window",
      })
      .returning()
      .then((rows) => rows[0]);

    const secondRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: userComment.id },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: userComment.id,
        wakeReason: "issue_commented",
      },
      requestedByActorType: "user",
      requestedByActorId: "user-during-mute",
    });

    expect(secondRun).toBeNull();

    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, agentId),
        ),
      );

    expect(skipped).toHaveLength(2);
    const reasons = skipped.map((r) => r.reason).sort();
    expect(reasons).toEqual(["self_comment_mute_window_active", "self_comment_wake_skipped"]);
  });
});
