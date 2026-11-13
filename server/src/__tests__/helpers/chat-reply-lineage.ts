import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, agentWakeupRequests, chatConversations, chatEndpoints, chatMessageLinks, companies, heartbeatRuns, issueComments, issues, issueThreadInteractions, toolApplications, toolConnections, toolActionRequests, toolActionDeliveries, toolInvocations, type Db } from "@paperclipai/db";
import { resolveChatOriginPublicationBindings } from "../../services/issues.js";

export const lineageContextKeys = ["issueId", "taskId", "wakeCommentIds", "wakeCommentId", "commentId", "source", "sourceRunId", "interactionId", "endpointId"] as const;
export type LineageResolver = typeof resolveChatOriginPublicationBindings;
export type LineageQuery = { sql: string; params: unknown[]; rows: Array<Record<string, unknown>> };

export function captureLineageReads(db: Db, queries: LineageQuery[]): Db {
  return new Proxy(db, { get(target, key) {
    if (key !== "select") return Reflect.get(target, key);
    return (...fields: Parameters<Db["select"]>) => {
      const builder = target.select(...fields), from = builder.from.bind(builder);
      builder.from = ((...args: Parameters<typeof from>) => {
        const query = from(...args), execute = query.execute.bind(query);
        if (args[0] === heartbeatRuns) query.execute = async (...executeArgs: Parameters<typeof execute>) => {
          const statement = query.toSQL();
          const rows = await execute(...executeArgs);
          if (fields[0] && Object.keys(fields[0]).join(",") === "agentId,responsibleUserId,contextSnapshot") queries.push({ ...statement, rows });
          return rows;
        };
        return query;
      }) as typeof builder.from;
      return builder;
    };
  } });
}

export function expectedLineageContext(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(lineageContextKeys.filter(key => Object.hasOwn(value, key)).map(key => [key, (value as Record<string, unknown>)[key]]));
}

export async function chatReplyLineageFixture(db: Db, bytes = 192 * 1024) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic reply lineage", issuePrefix: `L${companyId.replaceAll("-", "").slice(0, 7)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic worker", adapterType: "paperclip_runner" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic external reply", status: "in_progress", assigneeAgentId: agentId });
  const [application] = await db.insert(toolApplications).values({ companyId, name: "Synthetic chat", applicationKey: randomUUID(), type: "chat" }).returning();
  const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "Synthetic chat", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
  const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection.id, assignedAgentId: agentId, provider: "slack", publicId: randomUUID(), status: "active" }).returning();
  const [conversation] = await db.insert(chatConversations).values({ companyId, endpointId: endpoint.id, issueId, externalConversationId: randomUUID(), externalThreadId: randomUUID(), externalLabel: "Synthetic conversation" }).returning();
  const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "synthetic-requester", body: "Please continue" }).returning();
  await db.insert(chatMessageLinks).values({ companyId, endpointId: endpoint.id, conversationId: conversation.id, commentId: comment.id, providerMessageId: randomUUID(), direction: "inbound" });
  const context = { source: "chat:slack", issueId, endpointId: endpoint.id, wakeCommentIds: [comment.id], prompt: randomBytes(bytes).toString("base64") };
  const insertRun = async (snapshot: unknown = context, overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) => {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", contextSnapshot: snapshot as never, ...overrides }).returning();
    return run;
  };
  const root = await insertRun();
  async function continueFrom(sourceRunId: string) {
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId, sourceRunId, kind: "request_confirmation", status: "accepted", payload: { version: 1 } as never }).returning();
    const run = await insertRun({ issueId, source: "issue.interaction.accept", sourceRunId, interactionId: interaction.id, prompt: context.prompt });
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", reason: "issue_commented", status: "claimed", runId: run.id, idempotencyKey: `interaction:${interaction.id}:accepted` }).returning();
    return { run, interaction, wake };
  }
  return { companyId, agentId, issueId, endpoint, conversation, comment, context, root, insertRun, continueFrom,
    expected: [{ companyId, endpointId: endpoint.id, conversationId: conversation.id }] };
}

export async function cleanupChatReplyLineageFixture(db: Db, companyId: string) {
  for (const table of [agentWakeupRequests, toolActionDeliveries, toolActionRequests, toolInvocations, issueThreadInteractions, chatMessageLinks, chatConversations, chatEndpoints, heartbeatRuns, issueComments, issues, toolConnections, toolApplications, agents]) {
    await db.delete(table).where(eq(table.companyId, companyId));
  }
  await db.delete(companies).where(eq(companies.id, companyId));
}
