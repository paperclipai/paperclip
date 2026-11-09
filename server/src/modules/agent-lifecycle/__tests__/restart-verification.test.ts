import { randomUUID } from "node:crypto";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle, configureAgentLifecycle, createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { startAgentLifecycle } from "../index.js";
import { createLifecycleStore } from "../adapters/postgres.js";
import type { LifecycleAgent } from "../application/ports.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../../../services/recovery/ownership-invariant-report.js";
import {
  currentControllerProcessStamp,
  currentProcessSpaceHash,
  currentProcessStartedAtMs,
} from "../../../services/controller-process-identity.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("harness verification across a control-plane restart", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  const workers: Array<{ stop(): Promise<void> }> = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-restart-verification-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Restart verification", issuePrefix: `R${companyId.slice(0, 7)}` });
  });
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop();
    await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.companyId, companyId));
  });
  const current = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;

  /** An agent whose verification a controller claimed and was running when the controller died. */
  async function verifyingHeldBy(holder: Record<string, unknown>) {
    const runHost = vi.fn(async (agent: LifecycleAgent) => agent.lifecycleState === "verifying" ? "pending" as const : "complete" as const);
    const before = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runHost, runPlugin: async () => "complete" as const });
    const agent = await createAgentLifecycle(db).requestHire(companyId, { name: "Verifier", adapterType: "process", adapterConfig: { command: "true" } });
    await before.process(agent.id);
    await before.stop();
    expect((await current(agent.id)).lifecycleState).toBe("verifying");
    await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, agent.id));
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    expect(await store.claim(agent.id, "verifier-before-restart", new Date())).not.toBeNull();
    await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} || ${JSON.stringify({ leaseHolder: holder })}::jsonb` })
      .where(eq(agents.id, agent.id));
    return agent.id;
  }

  /** The restarted process: one startup reconciliation pass, then its lifecycle sweep. */
  async function restart() {
    const verify = vi.fn(async (agent: LifecycleAgent) => { void agent; return "complete" as const; });
    const restarted = startAgentLifecycle(db, createAgentLifecycleEffects(),
      { requiredPluginIds: async () => [], runHost: verify, runPlugin: async () => "complete" as const }, () => true);
    workers.push(restarted);
    const startedAt = performance.now();
    await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
    await restarted.sweep();
    return { verify, queuedMs: performance.now() - startedAt };
  }

  it("verifies again at once when the verifier's process is proven gone, not after the lease", async () => {
    const id = await verifyingHeldBy({ bootId: randomUUID(), pid: 2_000_000_001, hostHash: currentProcessSpaceHash(),
      processStartedAt: new Date(Date.now() - 60_000).toISOString() });
    const { verify, queuedMs } = await restart();
    expect(verify).toHaveBeenCalledOnce();
    // Runs gate on readiness; before this change they waited out the 120 s lease.
    expect((await current(id)).lifecycleState).toBe("ready");
    expect(queuedMs).toBeLessThan(10_000);
  });

  it("never takes over a verification whose process is alive", async () => {
    const id = await verifyingHeldBy({ ...currentControllerProcessStamp(), bootId: randomUUID(), pid: process.pid,
      processStartedAt: new Date((await currentProcessStartedAtMs())!).toISOString() });
    const before = await current(id);
    const { verify } = await restart();
    expect(verify).not.toHaveBeenCalled();
    const after = await current(id);
    expect(after.lifecycleState).toBe("verifying");
    expect(after.lifecycleOperation?.leaseOwner).toBe(before.lifecycleOperation?.leaseOwner);
  });

  it("stamps the claiming process on the lease and clears it with the lease", async () => {
    const id = await verifyingHeldBy(currentControllerProcessStamp() as unknown as Record<string, unknown>);
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'leaseOwner' - 'leaseUntil' - 'leaseHolder'` })
      .where(eq(agents.id, id));
    const claimed = await store.claim(id, "owner", new Date());
    expect(claimed?.lifecycleOperation?.leaseHolder).toMatchObject({ pid: process.pid, bootId: currentControllerProcessStamp().bootId });
    expect(await store.defer(claimed!, "owner", null, new Date())).toBe(true);
    expect((await current(id)).lifecycleOperation).not.toHaveProperty("leaseHolder");
  });
});
