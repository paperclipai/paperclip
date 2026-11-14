import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, chatConversations, chatEndpoints, chatPublications, companies, createDb,
  heartbeatRuns, issues, toolApplications, toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { enqueueChatRunMilestones, loadChatRunLifecycleMilestoneScopes } from "../services/chat-run-publications.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat milestone result TOAST reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("chat-milestone-toast-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  it.each([false, true])("does not read published runs' results (decision present: %s)", async (hasDecision) => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Toast", issuePrefix: hasDecision ? "TYES" : "TNO" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat agent" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Active chat" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId, assignedAgentId: agentId, publicationMode: "automatic" });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: conversationId, externalLabel: "Active", state: "active" });
    const runIds = Array.from({ length: 6 }, () => randomUUID());
    for (const runId of runIds) {
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId, status: "succeeded",
        contextSnapshot: { issueId, source: "chat:slack" },
        resultJson: {
          output: randomBytes(256_000).toString("hex"),
          ...(hasDecision ? { presentationDecision: { commentId: null } } : {}),
          nativeResult: { reportedWorkDisposition: "completed" },
        },
      });
      await db.insert(chatPublications).values({
        companyId, endpointId, conversationId, issueId, state: "published",
        idempotencyKey: `run:${runId}:completed:${endpointId}`,
        payload: { text: "Completed", progressState: "completed" },
      });
    }
    await db.transaction(async (tx) => {
      const fetched = async () => {
        const [row] = await tx.execute<{ blocks: number }>(
          sql`select pg_stat_get_xact_blocks_fetched(reltoastrelid)::int as blocks
            from pg_class where oid = 'heartbeat_runs'::regclass`,
        );
        return row.blocks;
      };
      const before = await fetched();
      expect(await enqueueChatRunMilestones(tx as unknown as typeof db)).toBe(0);
      expect(await fetched()).toBe(before);
      expect(await loadChatRunLifecycleMilestoneScopes(tx as unknown as typeof db, { companyId })).toEqual([]);
      expect(await fetched()).toBe(before);
      await tx.execute(sql`select result_json -> 'presentationDecision'
        from heartbeat_runs where id = ${runIds[0]}`);
      expect(await fetched()).toBeGreaterThan(before);
      await tx.delete(chatPublications).where(eq(chatPublications.companyId, companyId));
      const withoutLineage = await fetched();
      expect(await enqueueChatRunMilestones(tx as unknown as typeof db)).toBe(0);
      expect(await fetched()).toBe(withoutLineage);
    });
  });
});
