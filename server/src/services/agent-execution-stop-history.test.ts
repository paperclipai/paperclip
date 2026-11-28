import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, applyPendingMigrations, closeRegisteredClients, companies, createDb, environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { agentExecutionStopBlocker } from "./agent-execution-stop.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_LIFECYCLE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent execution stop history filter", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (external) { await applyPendingMigrations(external); db = createDb(external); }
    else { database = await startEmbeddedPostgresTestDatabase("paperclip-stop-history-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterAll(async () => { if (external) await closeRegisteredClients(external); else await database?.cleanup(); });

  it("keeps a never-started cancelled run whose only evidence is a released remote lease", async () => {
    const id = randomUUID();
    const [company] = await db.insert(companies).values({ name: "Stop history", issuePrefix: `H${id.slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Long history agent",
      adapterType: "claude_local", status: "idle", lifecycleState: "ready" }).returning();
    await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "succeeded",
      startedAt: new Date("2000-01-01T00:00:00Z"), finishedAt: new Date("2000-01-01T00:00:05Z"),
      resultJson: { summary: "finished" } });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "cancelled",
      startedAt: null, finishedAt: new Date("2000-01-02T00:00:00Z") }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, heartbeatRunId: run.id,
      provider: "ssh", providerLeaseId: "synthetic-remote", status: "released",
      releasedAt: new Date("2000-01-02T00:00:01Z"), cleanupStatus: "success" }).returning();

    expect(await agentExecutionStopBlocker(db, [agent.id])).toBe("remote_stop_unconfirmed");

    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination:
      remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }) } })
      .where(eq(environmentLeases.id, lease.id));
    expect(await agentExecutionStopBlocker(db, [agent.id])).toBeNull();
  });
});
