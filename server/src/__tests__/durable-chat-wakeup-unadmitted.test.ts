import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  chatActions,
  chatConversations,
  chatEndpoints,
  companies,
  createDb,
  issues,
  toolApplications,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { unadmittedChatWakeupCondition } from "../services/durable-chat-wakeup.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("unadmitted chat wakeup check (real PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    if (externalTestDatabaseUrl) db = createDb(externalTestDatabaseUrl);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("durable-chat-wakeup-unadmitted-");
      db = createDb(temporary.connectionString);
    }
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Held input", issuePrefix: companyId.slice(0, 8) });
    const [agent] = await db.insert(agents).values({ companyId, name: "Reviewer", role: "engineer", adapterType: "codex_local" }).returning();
    const endpointId = randomUUID();
    const [application] = await db.insert(toolApplications).values({
      companyId, applicationKey: `chat:slack:${endpointId}`, name: `Slack ${endpointId}`, type: "chat", status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application.id, name: "Slack", uid: `chat-slack-${endpointId}`,
      connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true,
    }).returning();
    await db.insert(chatEndpoints).values({
      id: endpointId, companyId, connectionId: connection.id, provider: "slack", publicId: randomUUID(),
      assignedAgentId: agent.id, status: "active",
    });
    const addIssue = async () => (await db.insert(issues).values({ companyId, title: "Task", status: "todo" }).returning())[0]!.id;
    const chatTask = await addIssue();
    const plainTask = await addIssue();
    const [conversation] = await db.insert(chatConversations).values({
      companyId, endpointId, issueId: chatTask, externalConversationId: randomUUID(), externalLabel: "Slack thread",
    }).returning();
    return { companyId, agentId: agent.id, endpointId, conversationId: conversation!.id, chatTask, plainTask };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  async function addInboundWakeup(f: Fixture, status: string, options: { sessionGeneration?: number; createdAt?: Date } = {}) {
    const deliveryId = randomUUID();
    const [action] = await db.insert(chatActions).values({
      companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId, kind: "inbound_wakeup",
      providerActionId: `inbound_wakeup:${deliveryId}`, status,
      payload: {
        version: 1, issueId: f.chatTask, agentId: f.agentId, commentId: randomUUID(),
        sessionGeneration: options.sessionGeneration ?? 1, requestedByActorType: "system", requestedByActorId: randomUUID(),
      },
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    }).returning();
    return action!.id;
  }

  async function admit(f: Fixture, actionId: string, status = "queued") {
    await db.insert(agentWakeupRequests).values({
      id: actionId, companyId: f.companyId, agentId: f.agentId, source: "on_demand", status, payload: {},
    });
  }

  const held = (f: Fixture, issueId: string, tx: Db = db) => tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, f.companyId), unadmittedChatWakeupCondition(issues.id, issues.companyId)))
    .limit(1)
    .then((rows) => rows.length > 0);

  it("holds a task while an inbound wakeup on its conversation is not admitted", async () => {
    const f = await seed();
    expect(await held(f, f.chatTask)).toBe(false);
    const issued = await addInboundWakeup(f, "issued");
    expect(await held(f, f.chatTask)).toBe(true);
    expect(await held(f, f.plainTask)).toBe(false);
    await admit(f, issued, "skipped");
    expect(await held(f, f.chatTask)).toBe(true);
    await db.update(agentWakeupRequests).set({ status: "failed" }).where(eq(agentWakeupRequests.id, issued));
    expect(await held(f, f.chatTask)).toBe(false);
    await addInboundWakeup(f, "processed");
    await addInboundWakeup(f, "cancelled");
    expect(await held(f, f.chatTask)).toBe(false);
  });

  it("releases a failed wakeup once a later wakeup of the same session is admitted", async () => {
    const f = await seed();
    await addInboundWakeup(f, "failed", { createdAt: new Date(Date.now() - 60_000) });
    expect(await held(f, f.chatTask)).toBe(true);
    const otherSession = await addInboundWakeup(f, "processed", { sessionGeneration: 2 });
    await admit(f, otherSession);
    expect(await held(f, f.chatTask)).toBe(true);
    const later = await addInboundWakeup(f, "processed");
    await admit(f, later);
    expect(await held(f, f.chatTask)).toBe(false);
  });

  async function actionBlocks(work: (tx: Db) => Promise<unknown>) {
    const blocks = (tx: Db) => tx.execute<{ blocks: string }>(sql`
      with rel as (
        select 'chat_actions'::regclass::oid as oid
        union all select reltoastrelid from pg_class where oid = 'chat_actions'::regclass and reltoastrelid <> 0
      )
      select coalesce(sum(pg_stat_get_xact_blocks_fetched(c.oid)), 0)::text as blocks
      from pg_class c
      where c.oid in (select oid from rel) or c.oid in (select indexrelid from pg_index where indrelid in (select oid from rel))
    `).then((result) => Number([...result][0]!.blocks));
    let fetched = -1;
    const rollback = new Error("rollback");
    await db.transaction(async (tx) => {
      const before = await blocks(tx as unknown as Db);
      await work(tx as unknown as Db);
      fetched = (await blocks(tx as unknown as Db)) - before;
      throw rollback;
    }).catch((error) => {
      if (error !== rollback) throw error;
    });
    return fetched;
  }

  async function addHistory(f: Fixture, count: number) {
    const rows = Array.from({ length: count }, () => ({
      companyId: f.companyId, endpointId: f.endpointId, kind: "github_review_check", providerActionId: `github-check:${randomUUID()}`,
      status: "processed", payload: { version: 1, event: { deliveryId: randomUUID(), body: randomBytes(1500).toString("base64") } },
    }));
    for (let index = 0; index < rows.length; index += 200) await db.insert(chatActions).values(rows.slice(index, index + 200));
    await db.execute(sql`analyze chat_actions`);
  }

  it("reads no chat action for a task with no conversation, whatever the company's chat actions hold", async () => {
    const f = await seed();
    await addInboundWakeup(f, "issued");
    await addHistory(f, 400);
    const small = await actionBlocks((tx) => held(f, f.plainTask, tx));
    await addHistory(f, 3600);
    const large = await actionBlocks((tx) => held(f, f.plainTask, tx));
    expect(await held(f, f.plainTask)).toBe(false);
    expect(await held(f, f.chatTask)).toBe(true);
    expect(large - small).toBeLessThanOrEqual(2);
    expect(large).toBeLessThanOrEqual(8);
  });
});
