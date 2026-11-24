import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues,
  sandboxCreationOperations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { attachSandboxCreation, environmentService } from "./environments.js";

// Staging: a sandbox run failed during setup with "Failed to acquire lease ...
// Failed query: insert into environment_leases ..." caused by 40P01. The
// provider had already started the sandbox. Recording it locks the environment,
// the creation operation and the run row, then the lease insert takes a
// key-share lock on its parent issue. A writer that holds the issue row and then
// asks for the run row (the usual issue-before-run order) closes a lock cycle,
// and PostgreSQL aborts the lease insert. The aborted transaction rolled back
// whole, yet it failed the run and discarded the started sandbox.
describe("recording a created sandbox lease under an issue-then-run lock cycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const environmentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("lease-attach-deadlock-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Lease deadlock", issuePrefix: "LAD" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Sandbox agent", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: environmentId, name: "Sandbox", driver: "sandbox",
      config: { provider: "creation-fixture", image: "fixture", reuseLease: false } });
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });

  it("retries a lease insert that lost a deadlock and records the started sandbox once", async () => {
    const issueId = randomUUID();
    const runId = randomUUID();
    const operationId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Fix the bug", status: "in_progress", workMode: "standard",
      assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "assignment",
      contextSnapshot: { issueId } });
    await db.insert(sandboxCreationOperations).values({ id: operationId, companyId, environmentId, originalEnvironmentId: environmentId,
      runId, issueId, provider: "creation-fixture", driverKey: "creation-fixture", state: "pending", config: {}, metadata: {},
      nextAttemptAt: new Date(Date.now() + 60_000) });

    // Another writer holds the issue row before the lease is recorded. Once the
    // recording holds the run row and waits for the issue (the lease foreign
    // key), the writer asks for the run row: a deadlock. The writer's own
    // detector waits longer, so PostgreSQL always aborts the lease recording.
    let writerBlockedAttach = false;
    let releaseWriter!: () => void;
    const writerHoldsIssue = new Promise<void>(resolve => { releaseWriter = resolve; });
    const writer = db.transaction(async tx => {
      await tx.execute(sql`set local deadlock_timeout = '10s'`);
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      const writerPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;
      releaseWriter();
      for (let poll = 0; poll < 1_000 && !writerBlockedAttach; poll++) {
        const rows = (await db.execute(
          sql`select 1 from pg_stat_activity where ${writerPid} = any(pg_blocking_pids(pid))`,
        )) as unknown as Array<unknown>;
        if (rows[0]) writerBlockedAttach = true;
        else await new Promise(resolve => setTimeout(resolve, 10));
      }
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
    });
    await writerHoldsIssue;

    const outcome = await environmentService(db).acquireLease({
      creationOperationId: operationId, companyId, environmentId, issueId, heartbeatRunId: runId,
      leasePolicy: "ephemeral", provider: "creation-fixture", providerLeaseId: "provider-sandbox-1",
      metadata: { agentId, driver: "sandbox" },
    }).then(lease => ({ lease }), (error: unknown) => ({ error }));
    await writer;

    expect(writerBlockedAttach).toBe(true);
    expect(outcome).not.toHaveProperty("error");
    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
    expect(leases).toEqual([expect.objectContaining({ status: "active", providerLeaseId: "provider-sandbox-1", issueId })]);
    expect((outcome as { lease: { id: string } }).lease.id).toBe(leases[0]!.id);
    const [operation] = await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.id, operationId));
    expect(operation).toMatchObject({ state: "attached", leaseId: leases[0]!.id });
  }, 120_000);

  it("does not retry a deterministic failure while recording the lease", async () => {
    const runId = randomUUID();
    const operationId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "assignment" });
    await db.insert(sandboxCreationOperations).values({ id: operationId, companyId, environmentId, originalEnvironmentId: environmentId,
      runId, provider: "creation-fixture", driverKey: "creation-fixture", state: "pending", config: {}, metadata: {},
      nextAttemptAt: new Date(Date.now() + 60_000) });
    let attempts = 0;
    await expect(attachSandboxCreation(db, operationId, { companyId, environmentId, heartbeatRunId: runId }, async () => {
      attempts += 1;
      throw new Error("deterministic attach failure");
    })).rejects.toThrow("deterministic attach failure");
    expect(attempts).toBe(1);
    const [operation] = await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.id, operationId));
    expect(operation).toMatchObject({ state: "pending", leaseId: null });
  }, 60_000);
});
