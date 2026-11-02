import { randomUUID } from "node:crypto";
import { agents, companies, costEvents, createDb } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRecordQueries } from "../lib/agent-records.js";
import { agentService } from "../services/agents.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("agent roster read projections", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-roster-read-");
    db = createDb(database.connectionString);
  }, 60_000);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2020-06-15T12:00:00Z"));
  });

  afterEach(() => { vi.useRealTimers(); });

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), foreignCompanyId = randomUUID();
    const managerId = randomUUID(), workerId = randomUUID(), unrelatedId = randomUUID(), archivedId = randomUUID(), foreignId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Roster fixture", issuePrefix: `R${companyId.slice(0, 7).toUpperCase()}` },
      { id: foreignCompanyId, name: "Foreign roster", issuePrefix: `F${foreignCompanyId.slice(0, 7).toUpperCase()}` },
    ]);
    const bulk = "retained-other-agent-configuration🙂".repeat(32_768);
    await db.insert(agents).values([
      { id: managerId, companyId, name: "Manager", status: "terminated", adapterType: "process", adapterConfig: { instructions: bulk } },
      { id: unrelatedId, companyId, name: "Other worker", status: "idle", adapterType: "process", adapterConfig: { instructions: bulk } },
      { id: archivedId, companyId, name: "Archived worker", status: "terminated", adapterType: "process", runtimeConfig: { retained: bulk } },
      { id: foreignId, companyId: foreignCompanyId, name: "Foreign manager", status: "idle", adapterType: "process", adapterConfig: { instructions: bulk } },
    ]);
    const [worker] = await db.insert(agents).values({ id: workerId, companyId, name: "Selected worker", status: "idle",
      reportsTo: managerId, adapterType: "process", adapterConfig: { instructions: "selected instructions", model: "fixture-model" },
      runtimeConfig: { heartbeat: { enabled: false } }, metadata: { retained: "selected metadata" },
      permissions: { canCreateAgents: true }, spentMonthlyCents: 999,
    }).returning();
    const now = new Date();
    await db.insert(costEvents).values([
      { companyId, agentId: workerId, provider: "fixture", model: "fixture-model", costCents: 19.5, occurredAt: now },
      { companyId, agentId: workerId, provider: "fixture", model: "fixture-model", costCents: 50,
        occurredAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)) },
      { companyId: foreignCompanyId, agentId: foreignId, provider: "fixture", model: "fixture-model", costCents: 100, occurredAt: now },
    ]);
    return { companyId, foreignCompanyId, managerId, workerId, unrelatedId, archivedId, foreignId, worker, bulk };
  }

  async function observe<T>(run: (observed: ReturnType<typeof createDb>) => Promise<T>) {
    const observed = createDb(database.connectionString), events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(observed, { agents, costEvents }, capture);
    try {
      const result = await run(observed);
      capture.flush();
      const reads = events.filter(event => event.table === "agents" && event.operation === "select");
      return { result, calls: reads.reduce((n, event) => n + Number(event.calls), 0),
        bytes: reads.reduce((n, event) => n + Number(event.responseValueBytes), 0), events };
    } finally {
      capture.flush();
      await observed.$client.end();
    }
  }

  it.each([false, true])("reads one full roster for list, preserving terminated-manager evidence and configurations (includeTerminated=%s)", async includeTerminated => {
    const f = await fixture();
    const captured = await observe(observed => agentService(observed).list(f.companyId, { includeTerminated }));
    expect(captured.calls).toBe(1);
    expect(captured.result.map(row => row.id).sort()).toEqual((includeTerminated
      ? [f.workerId, f.managerId, f.archivedId, f.unrelatedId] : [f.workerId, f.unrelatedId]).sort());
    const selected = captured.result.find(row => row.id === f.workerId)!;
    expect(selected).toMatchObject({ adapterConfig: f.worker.adapterConfig, runtimeConfig: f.worker.runtimeConfig,
      metadata: f.worker.metadata, permissions: { canCreateAgents: true }, spentMonthlyCents: 19.5,
      orgChainHealth: { status: "invalid_org_chain", reason: "terminated_ancestor", firstInvalidAncestor: { id: f.managerId } } });
    expect(captured.result.find(row => row.id === f.unrelatedId)?.adapterConfig.instructions).toBe(f.bulk);
    if (includeTerminated) expect(captured.result.find(row => row.id === f.archivedId)?.runtimeConfig.retained).toBe(f.bulk);
    expect((await db.select().from(agents).where(eq(agents.id, f.workerId)))[0]).toEqual(f.worker);
    expect(JSON.stringify(captured.events)).not.toContain("retained-other-agent-configuration");
  });

  it("keeps detail reads small while returning the selected agent's complete current configuration", async () => {
    const f = await fixture();
    const captured = await observe(observed => agentRecordQueries(observed).getById(f.workerId));
    expect(captured.calls).toBe(2);
    expect(captured.bytes).toBeLessThan(8192);
    expect(captured.result).toMatchObject({ id: f.workerId, companyId: f.companyId, adapterConfig: f.worker.adapterConfig,
      runtimeConfig: f.worker.runtimeConfig, metadata: f.worker.metadata, permissions: { canCreateAgents: true }, spentMonthlyCents: 19.5,
      orgChainHealth: { reason: "terminated_ancestor", firstInvalidAncestor: { id: f.managerId, name: "Manager" } } });
    expect((await db.select().from(agents).where(eq(agents.id, f.workerId)))[0]).toEqual(f.worker);
  });

  it("projects only current company chain fields for plugin normalization", async () => {
    const f = await fixture();
    const captured = await observe(observed => agentRecordQueries(observed).listCompanyAgentEligibilityRows(f.companyId));
    expect(captured.calls).toBe(1);
    expect(captured.bytes).toBeLessThan(4096);
    expect(captured.result.map(row => row.id).sort()).toEqual([f.workerId, f.managerId, f.unrelatedId, f.archivedId].sort());
    for (const row of captured.result) expect(Object.keys(row).sort()).toEqual(["companyId", "id", "name", "reportsTo", "status"]);
    const normalized = agentRecordQueries(db).normalizeAgentRow(f.worker, captured.result);
    expect(normalized).toMatchObject({ adapterConfig: f.worker.adapterConfig, metadata: f.worker.metadata,
      orgChainHealth: { reason: "terminated_ancestor", firstInvalidAncestor: { id: f.managerId } } });
    expect(await agentRecordQueries(db).listCompanyAgentEligibilityRows(randomUUID())).toEqual([]);
    expect(await agentRecordQueries(db).getById(randomUUID())).toBeNull();
  });

  it("rechecks manager status, name, selected configuration, missing managers, and cycles on later reads", async () => {
    const f = await fixture(), records = agentRecordQueries(db);
    expect((await records.getById(f.workerId))?.orgChainHealth.reason).toBe("terminated_ancestor");
    await db.update(agents).set({ status: "paused", name: "Current manager" }).where(eq(agents.id, f.managerId));
    await db.update(agents).set({ adapterConfig: { instructions: "changed instructions" } }).where(eq(agents.id, f.workerId));
    expect(await records.getById(f.workerId)).toMatchObject({ adapterConfig: { instructions: "changed instructions" },
      orgChainHealth: { status: "healthy", pausedAncestors: [{ id: f.managerId, name: "Current manager", status: "paused" }] } });
    await db.update(agents).set({ reportsTo: f.foreignId }).where(eq(agents.id, f.workerId));
    expect((await records.getById(f.workerId))?.orgChainHealth.reason).toBe("missing_manager");
    await db.update(agents).set({ reportsTo: f.managerId }).where(eq(agents.id, f.workerId));
    await db.update(agents).set({ reportsTo: f.workerId }).where(eq(agents.id, f.managerId));
    expect((await records.getById(f.workerId))?.orgChainHealth.reason).toBe("cycle");
  });
});
