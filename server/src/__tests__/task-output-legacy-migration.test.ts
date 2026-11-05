import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, chatConversations, chatEndpoints, companies, createDb, issues,
  taskProviderOutputPolicies, toolApplications, toolConnections,
} from "@paperclipai/db";
import { taskForbidsProviderOutput } from "../services/task-provider-output-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const migration = readFileSync(new URL("../../../packages/db/src/migrations/0432_task_provider_output_policies.sql", import.meta.url), "utf8");
type Transaction = Parameters<Parameters<ReturnType<typeof createDb>["transaction"]>[0]>[0];

describePostgres("legacy task output migration", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-legacy-output-");
    db = createDb(database.connectionString);
    await db.execute(sql.raw('DROP TABLE "task_provider_output_policies"'));
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function isolated(test: (tx: Transaction) => Promise<void>) {
    const rollback = new Error("Roll back migration fixture");
    try {
      await db.transaction(async tx => {
        await test(tx);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  async function migrate(tx: Transaction) {
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await tx.execute(sql.raw(statement));
    }
  }

  async function fixture(tx: Transaction, state: typeof chatConversations.$inferInsert.state = "active") {
    const companyId = randomUUID(), issueId = randomUUID(), endpointId = randomUUID();
    const agentId = randomUUID(), connectionId = randomUUID(), applicationId = randomUUID();
    await tx.insert(companies).values({ id: companyId, name: "Legacy chat", issuePrefix: `L${companyId.slice(0, 8)}` });
    await tx.insert(agents).values({ id: agentId, companyId, name: "Legacy agent", role: "engineer", adapterType: "process" });
    await tx.insert(issues).values({ id: issueId, companyId, title: "Retained chat task" });
    await tx.insert(toolApplications).values({ id: applicationId, companyId, name: "Legacy chat app", type: "custom" });
    await tx.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Legacy connection", uid: connectionId,
      transport: "chat_sdk", connectionPurpose: "channel" });
    await tx.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId, assignedAgentId: agentId });
    await tx.insert(chatConversations).values({ companyId, endpointId, issueId, externalConversationId: "synthetic-channel",
      externalThreadId: "synthetic-thread", externalLabel: "Synthetic thread", state });
    return { companyId, issueId, endpointId };
  }

  it.each(["active", "waiting", "completed", "unavailable", "endpoint_removed"] as const)(
    "retains %s legacy quarantine after the last binding is deleted", async state => {
      await isolated(async tx => {
        const f = await fixture(tx, state);
        await migrate(tx);
        expect(await taskForbidsProviderOutput(tx, f)).toBe(true);
        await tx.delete(chatConversations).where(eq(chatConversations.issueId, f.issueId));
        expect(await tx.select().from(issues).where(eq(issues.id, f.issueId))).toHaveLength(1);
        expect(await taskForbidsProviderOutput(tx, f)).toBe(true);
        expect(await tx.select().from(taskProviderOutputPolicies).where(eq(taskProviderOutputPolicies.issueId, f.issueId)))
          .toMatchObject([{ companyId: f.companyId, disposition: "forbidden" }]);
      });
    },
  );

  it("retains quarantine through the actual endpoint foreign-key cascade", async () => {
    await isolated(async tx => {
      const f = await fixture(tx);
      await migrate(tx);
      await tx.delete(chatEndpoints).where(eq(chatEndpoints.id, f.endpointId));
      expect(await tx.select().from(chatConversations).where(eq(chatConversations.issueId, f.issueId))).toHaveLength(0);
      expect(await taskForbidsProviderOutput(tx, f)).toBe(true);
    });
  });

  it("deduplicates multiple retained generations and scopes each policy to its company", async () => {
    await isolated(async tx => {
      const first = await fixture(tx), second = await fixture(tx);
      await tx.insert(chatConversations).values({ companyId: first.companyId, endpointId: first.endpointId, issueId: first.issueId,
        externalConversationId: "synthetic-channel", externalThreadId: "synthetic-thread", sessionGeneration: 2, externalLabel: "Next generation" });
      await migrate(tx);
      const rows = await tx.select().from(taskProviderOutputPolicies);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ issueId: first.issueId, companyId: first.companyId, disposition: "forbidden" }),
        expect.objectContaining({ issueId: second.issueId, companyId: second.companyId, disposition: "forbidden" }),
      ]));
      expect(await tx.select().from(taskProviderOutputPolicies).where(and(
        eq(taskProviderOutputPolicies.companyId, second.companyId), eq(taskProviderOutputPolicies.issueId, first.issueId),
      ))).toHaveLength(0);
    });
  });

  it("holds source mutations until migration commit without blocking ordinary reads", async () => {
    await isolated(async tx => {
      await fixture(tx);
      await migrate(tx);
      const observer = createDb(database.connectionString, { prepare: false, maxConnections: 1 });
      try {
        await expect(observer.transaction(async other => {
          await other.execute(sql.raw("SET LOCAL statement_timeout = '2s'"));
          await other.select({ id: chatConversations.id }).from(chatConversations).limit(1);
          await other.select({ id: issues.id }).from(issues).limit(1);
          await other.execute(sql.raw('LOCK TABLE "chat_conversations" IN ROW EXCLUSIVE MODE NOWAIT'));
        })).rejects.toMatchObject({ cause: { code: "55P03" } });
      } finally {
        await observer.$client.end({ timeout: 1 });
      }
    });
    await db.transaction(async tx => {
      await tx.execute(sql.raw('LOCK TABLE "chat_conversations" IN ROW EXCLUSIVE MODE NOWAIT'));
    });
  });

  it("rolls migration schema and backfill back together", async () => {
    let companyId = "";
    await isolated(async tx => {
      const f = await fixture(tx);
      companyId = f.companyId;
      await migrate(tx);
      expect(await tx.select().from(taskProviderOutputPolicies)).toHaveLength(1);
    });
    expect(await db.execute(sql`select to_regclass('public.task_provider_output_policies') as name`))
      .toMatchObject([{ name: null }]);
    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
  });

  it("does not quarantine unrelated ordinary tasks and follows the task lifetime", async () => {
    await isolated(async tx => {
      const f = await fixture(tx), ordinaryId = randomUUID();
      await tx.insert(issues).values({ id: ordinaryId, companyId: f.companyId, title: "Ordinary native task" });
      await migrate(tx);
      expect(await taskForbidsProviderOutput(tx, { companyId: f.companyId, issueId: ordinaryId })).toBe(false);
      await tx.delete(chatConversations).where(eq(chatConversations.issueId, f.issueId));
      await tx.delete(issues).where(eq(issues.id, f.issueId));
      expect(await tx.select().from(taskProviderOutputPolicies)).toHaveLength(0);
      expect(await tx.select().from(issues).where(eq(issues.id, ordinaryId))).toHaveLength(1);
    });
  });
});
