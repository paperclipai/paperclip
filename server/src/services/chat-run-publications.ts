import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  chatConversations,
  chatPublications,
  heartbeatRuns,
} from "@paperclipai/db";
import { projectSafeChatPublication } from "./chat-publication-projection.js";

type SafeRunMilestone = "queued" | "working" | "failed";

function milestoneForStatus(status: string): SafeRunMilestone | null {
  if (status === "queued") return "queued";
  if (status === "running") return "working";
  if (["failed", "timed_out", "cancelled"].includes(status)) return "failed";
  return null;
}

function safeMilestoneText(input: {
  agentName: string;
  milestone: SafeRunMilestone;
  issueId: string;
  publicBaseUrl?: string | null;
}): string {
  if (input.milestone === "queued") return `${input.agentName} is queued.`;
  if (input.milestone === "working") return `${input.agentName} is working…`;
  let taskUrl: string | null = null;
  if (input.publicBaseUrl) {
    try {
      const origin = new URL(input.publicBaseUrl).origin;
      taskUrl = `${origin}/issues/${input.issueId}`;
    } catch {
      taskUrl = null;
    }
  }
  return `${input.agentName} stopped before completing this turn.${
    taskUrl
      ? ` Open the task in Paperclip: ${taskUrl}`
      : " Open the task in Paperclip for details."
  }`;
}

/**
 * Project only coarse run lifecycle into bound external conversations. Raw
 * output, errors, tool events, and reasoning stay in Paperclip. Idempotency is
 * keyed by run, milestone, and endpoint so polling and restarts are harmless.
 */
export async function enqueueChatRunMilestones(
  db: Db,
  input: {
    publicBaseUrl?: string | null;
    since?: Date;
    limit?: number;
  } = {},
): Promise<number> {
  const since = input.since ?? new Date(Date.now() - 24 * 60 * 60_000);
  const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000));
  const issueIdFromContext = sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
  const milestoneFromStatus = sql<string>`case
    when ${heartbeatRuns.status} = 'queued' then 'queued'
    when ${heartbeatRuns.status} = 'running' then 'working'
    else 'failed'
  end`;
  const rows = await db
    .select({
      runId: heartbeatRuns.id,
      runStatus: heartbeatRuns.status,
      issueId: chatConversations.issueId,
      companyId: chatConversations.companyId,
      endpointId: chatConversations.endpointId,
      conversationId: chatConversations.id,
      agentName: agents.name,
    })
    .from(heartbeatRuns)
    .innerJoin(
      chatConversations,
      and(
        eq(chatConversations.companyId, heartbeatRuns.companyId),
        sql`${issueIdFromContext} = ${chatConversations.issueId}::text`,
        inArray(chatConversations.state, ["active", "waiting"]),
      ),
    )
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .leftJoin(
      chatPublications,
      and(
        eq(chatPublications.companyId, heartbeatRuns.companyId),
        eq(chatPublications.endpointId, chatConversations.endpointId),
        sql`${chatPublications.idempotencyKey} = 'run:' || ${heartbeatRuns.id}::text || ':' || ${milestoneFromStatus} || ':' || ${chatConversations.endpointId}::text`,
      ),
    )
    .where(
      and(
        inArray(heartbeatRuns.status, [
          "queued",
          "running",
          "failed",
          "timed_out",
          "cancelled",
        ]),
        gte(heartbeatRuns.updatedAt, since),
        isNull(chatPublications.id),
      ),
    )
    .orderBy(asc(heartbeatRuns.updatedAt), asc(heartbeatRuns.id))
    .limit(limit);

  let inserted = 0;
  for (const row of rows) {
    const milestone = milestoneForStatus(row.runStatus);
    if (!milestone) continue;
    const result = await db
      .insert(chatPublications)
      .values({
        companyId: row.companyId,
        endpointId: row.endpointId,
        conversationId: row.conversationId,
        issueId: row.issueId,
        idempotencyKey: `run:${row.runId}:${milestone}:${row.endpointId}`,
        payload: projectSafeChatPublication({
          classification: "external",
          source: "safe_milestone",
          text: safeMilestoneText({
            agentName: row.agentName,
            milestone,
            issueId: row.issueId,
            publicBaseUrl: input.publicBaseUrl,
          }),
          progressState: milestone,
        }),
        state: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: chatPublications.id });
    inserted += result.length;
  }
  return inserted;
}
