import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, toolMcpGateways, toolProfileBindings, toolProfiles } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createToolGatewayService } from "../services/tool-gateway.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// A native run creates its agent's MCP gateway while it prepares. The create
// transaction locks the agent row, then its gateway insert takes key-share on
// the company row for the foreign key. A writer that locks the company row and
// then the agent row closes the cycle. Postgres aborts the gateway insert with
// 40P01, and the run fails before the provider starts.
describeEmbeddedPostgres("named MCP gateway creation under a deadlock", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-named-gateway-deadlock-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates the gateway after it loses a deadlock to a company-then-agent locker", async () => {
    const [company] = await db.insert(companies).values({
      name: `Gateway deadlock ${randomUUID()}`,
      issuePrefix: `GD${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Native agent",
      role: "engineer",
      adapterType: "paperclip_runner",
      adapterConfig: {},
    }).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `native:${randomUUID()}`,
      name: "Native assignment",
      defaultAction: "deny",
    }).returning();
    const slug = `native-${agent!.id.replaceAll("-", "").slice(0, 12)}-${randomUUID().slice(0, 8)}`;

    const locker = createDb(tempDb!.connectionString);
    let companyHeld!: () => void, lockAgent!: () => void;
    const companyLocked = new Promise<void>(resolve => { companyHeld = resolve; });
    const agentGate = new Promise<void>(resolve => { lockAgent = resolve; });
    // The locker waits longer before it checks for a deadlock, so the gateway
    // transaction is always the victim, as on staging.
    const lockerDone = locker.transaction(async tx => {
      await tx.execute(sql`set local deadlock_timeout = '20s'`);
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, company!.id)).for("update");
      companyHeld();
      await agentGate;
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agent!.id)).for("update");
    });
    try {
      await companyLocked;
      const create = createToolGatewayService(db).createNamedGateway({
        companyId: company!.id,
        body: {
          name: "Native gateway",
          slug,
          description: "Run-scoped Paperclip Runner MCP gateway.",
          profileId: profile!.id,
          defaultProfileMode: "gateway_only",
          agentId: agent!.id,
          contextScopeType: "agent",
          contextScopeId: agent!.id,
          metadata: { agentId: agent!.id },
        },
        actor: { agentId: agent!.id },
      }).then(value => ({ value }), error => ({ error }));
      await vi.waitFor(async () => {
        const [waiting] = await locker.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
          where wait_event_type = 'Lock' and query like 'insert into "tool_mcp_gateways"%'`);
        expect(waiting?.count).toBe(1);
      }, { timeout: 10_000, interval: 50 });
      lockAgent();
      await lockerDone;
      const outcome = await create;
      expect(outcome).not.toHaveProperty("error");
      expect(outcome).toMatchObject({ value: { slug, agentId: agent!.id, profileId: profile!.id } });
      expect(await db.select({ id: toolMcpGateways.id }).from(toolMcpGateways)
        .where(eq(toolMcpGateways.slug, slug))).toHaveLength(1);
      expect(await db.select({ id: toolProfileBindings.id }).from(toolProfileBindings)
        .where(eq(toolProfileBindings.targetId, (outcome as { value: { id: string } }).value.id))).toHaveLength(1);
    } finally {
      companyHeld();
      lockAgent();
      await lockerDone.catch(() => undefined);
      await locker.$client.end({ timeout: 1 });
    }
  }, 30_000);
});
