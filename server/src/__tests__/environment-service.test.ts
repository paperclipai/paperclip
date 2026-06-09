import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRuns,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { EnvironmentLeaseConflictError, environmentService } from "../services/environments.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres environment service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("environmentService leases", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof environmentService>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-service");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    svc = environmentService(db);
  });

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedEnvironment() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(environments).values({
      id: environmentId,
      companyId,
      name: "Local",
      driver: "local",
      status: "active",
      config: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Shared checkout",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared",
      strategyType: "shared_checkout",
      name: "rtr-project shared clone",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { companyId, agentId, environmentId, runId, projectId, executionWorkspaceId };
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    status: "queued" | "scheduled_retry" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" = "running",
  ): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return runId;
  }

  it("acquires and releases a lease for a run", async () => {
    const { companyId, environmentId, runId } = await seedEnvironment();

    const lease = await svc.acquireLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      metadata: { driver: "local" },
    });

    expect(lease.status).toBe("active");
    expect(lease.heartbeatRunId).toBe(runId);

    const released = await svc.releaseLease(lease.id);

    expect(released?.status).toBe("released");
    expect(released?.releasedAt).not.toBeNull();
  });

  it("releases all active leases for a run without touching unrelated rows", async () => {
    const { companyId, agentId, environmentId, runId } = await seedEnvironment();
    const otherRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const targetLease = await svc.acquireLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
    });
    const otherLease = await svc.acquireLease({
      companyId,
      environmentId,
      heartbeatRunId: otherRunId,
    });

    const released = await svc.releaseLeasesForRun(runId);

    expect(released.map((lease) => lease.id)).toEqual([targetLease.id]);

    const stillActive = await svc.listLeases(environmentId, { status: "active" });
    expect(stillActive.map((lease) => lease.id)).toEqual([otherLease.id]);
  });

  it("reuses the existing workspace lease when the same run re-acquires (re-entrant)", async () => {
    const { companyId, environmentId, runId, executionWorkspaceId } = await seedEnvironment();

    const first = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      issueId: null,
      heartbeatRunId: runId,
      leasePolicy: "ephemeral",
    });
    const second = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      issueId: null,
      heartbeatRunId: runId,
      leasePolicy: "ephemeral",
    });

    expect(second.id).toBe(first.id);
    const active = await svc.listLeases(environmentId, { status: "active" });
    expect(active).toHaveLength(1);
  });

  it("rejects a second run acquiring the same workspace through a different issue", async () => {
    const { companyId, agentId, environmentId, runId, executionWorkspaceId } = await seedEnvironment();
    const otherRunId = await seedRun(companyId, agentId, "running");

    // Distinct heartbeat runs model distinct issue checkouts targeting the same
    // shared workspace (issueId left null to avoid seeding the issues table; the
    // single-flight key is environment + execution workspace, not issue).
    const holder = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      issueId: null,
      heartbeatRunId: runId,
      leasePolicy: "ephemeral",
    });

    await expect(
      svc.acquireLease({
        companyId,
        environmentId,
        executionWorkspaceId,
        issueId: null,
        heartbeatRunId: otherRunId,
        leasePolicy: "ephemeral",
      }),
    ).rejects.toBeInstanceOf(EnvironmentLeaseConflictError);

    const active = await svc.listLeases(environmentId, { status: "active" });
    expect(active.map((lease) => lease.id)).toEqual([holder.id]);
  });

  it("enforces single-flight durably at the database level (partial unique index)", async () => {
    // Defense in depth: even if app-level logic is bypassed, the DB must reject a
    // second active ephemeral lease for the same (environment, execution workspace).
    const { companyId, environmentId, runId, executionWorkspaceId } = await seedEnvironment();

    await db.insert(environmentLeases).values({
      companyId,
      environmentId,
      executionWorkspaceId,
      heartbeatRunId: runId,
      status: "active",
      leasePolicy: "ephemeral",
      acquiredAt: new Date(),
      lastUsedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const error = await db
      .insert(environmentLeases)
      .values({
        companyId,
        environmentId,
        executionWorkspaceId,
        heartbeatRunId: runId,
        status: "active",
        leasePolicy: "ephemeral",
        acquiredAt: new Date(),
        lastUsedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeTruthy();
    // Drizzle wraps the driver error; the unique_violation (23505) is somewhere
    // in the cause chain.
    const codes: unknown[] = [];
    let cursor: unknown = error;
    for (let depth = 0; depth < 8 && cursor && typeof cursor === "object"; depth += 1) {
      codes.push((cursor as { code?: unknown }).code);
      cursor = (cursor as { cause?: unknown }).cause;
    }
    expect(codes).toContain("23505");
  });

  it("adopts a workspace lease whose holding run has terminated", async () => {
    const { companyId, agentId, environmentId, runId, executionWorkspaceId } = await seedEnvironment();

    const stale = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "ephemeral",
    });
    // The previous run died without releasing its lease.
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));

    const adopterRunId = await seedRun(companyId, agentId, "running");
    const adopted = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      heartbeatRunId: adopterRunId,
      leasePolicy: "ephemeral",
    });

    expect(adopted.id).not.toBe(stale.id);
    expect(adopted.heartbeatRunId).toBe(adopterRunId);

    const active = await svc.listLeases(environmentId, { status: "active" });
    expect(active.map((lease) => lease.id)).toEqual([adopted.id]);

    const previous = await svc.getLeaseById(stale.id);
    expect(previous?.status).toBe("expired");
  });

  it("adopts a workspace lease that has passed its expiry", async () => {
    const { companyId, agentId, environmentId, runId, executionWorkspaceId } = await seedEnvironment();

    const stale = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "ephemeral",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const adopterRunId = await seedRun(companyId, agentId, "running");
    const adopted = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      heartbeatRunId: adopterRunId,
      leasePolicy: "ephemeral",
    });

    expect(adopted.id).not.toBe(stale.id);
    const active = await svc.listLeases(environmentId, { status: "active" });
    expect(active.map((lease) => lease.id)).toEqual([adopted.id]);
  });

  it("does not single-flight non-ephemeral (reuse) leases on the same workspace", async () => {
    const { companyId, agentId, environmentId, runId, executionWorkspaceId } = await seedEnvironment();
    const otherRunId = await seedRun(companyId, agentId, "running");

    const first = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
    });
    const second = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      heartbeatRunId: otherRunId,
      leasePolicy: "reuse_by_environment",
    });

    expect(second.id).not.toBe(first.id);
    const active = await svc.listLeases(environmentId, { status: "active" });
    expect(active).toHaveLength(2);
  });

  it("does not treat a coexisting reuse lease as an ephemeral single-flight conflict", async () => {
    // A live `reuse_by_environment` lease shares the workspace with an incoming
    // ephemeral acquisition. The single-flight guard is scoped to ephemeral
    // leases (matching the partial unique index), so the ephemeral acquire must
    // succeed and both leases must remain active rather than colliding.
    const { companyId, agentId, environmentId, runId, executionWorkspaceId } = await seedEnvironment();
    const ephemeralRunId = await seedRun(companyId, agentId, "running");

    const reuse = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
    });
    const ephemeral = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      heartbeatRunId: ephemeralRunId,
      leasePolicy: "ephemeral",
    });

    expect(ephemeral.id).not.toBe(reuse.id);
    // The reuse lease was neither conflicted-on nor expired.
    expect((await svc.getLeaseById(reuse.id))?.status).toBe("active");
    const active = await svc.listLeases(environmentId, { status: "active" });
    expect(active.map((lease) => lease.id).sort()).toEqual([reuse.id, ephemeral.id].sort());
  });

  it("does not expire a coexisting reuse lease whose holding run has terminated", async () => {
    // The dangerous cross-policy mode: a `reuse_by_environment` lease persists
    // past its holding run by design, so a terminal run does not make it stale.
    // An ephemeral acquirer on the same workspace must not adopt/expire it as if
    // it were an abandoned single-flight holder.
    const { companyId, agentId, environmentId, runId, executionWorkspaceId } = await seedEnvironment();

    const reuse = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
    });
    // The reuse lease's originating run finishes; the sandbox lease lives on.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));

    const ephemeralRunId = await seedRun(companyId, agentId, "running");
    const ephemeral = await svc.acquireLease({
      companyId,
      environmentId,
      executionWorkspaceId,
      heartbeatRunId: ephemeralRunId,
      leasePolicy: "ephemeral",
    });

    expect(ephemeral.id).not.toBe(reuse.id);
    // Pre-fix, the unscoped lookup would have expired this reuse lease here.
    expect((await svc.getLeaseById(reuse.id))?.status).toBe("active");
    const active = await svc.listLeases(environmentId, { status: "active" });
    expect(active.map((lease) => lease.id).sort()).toEqual([reuse.id, ephemeral.id].sort());
  });

  it("does not single-flight leases without an execution workspace", async () => {
    const { companyId, agentId, environmentId, runId } = await seedEnvironment();
    const otherRunId = await seedRun(companyId, agentId, "running");

    const first = await svc.acquireLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      leasePolicy: "ephemeral",
    });
    const second = await svc.acquireLease({
      companyId,
      environmentId,
      heartbeatRunId: otherRunId,
      leasePolicy: "ephemeral",
    });

    expect(second.id).not.toBe(first.id);
    const active = await svc.listLeases(environmentId, { status: "active" });
    expect(active).toHaveLength(2);
  });

  it("creates and then reuses the default local environment for a company", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const created = await svc.ensureLocalEnvironment(companyId);
    const reused = await svc.ensureLocalEnvironment(companyId);

    expect(created.driver).toBe("local");
    expect(reused.id).toBe(created.id);

    const rows = await db.select().from(environments).where(eq(environments.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Local");
  });

  it("leaves an existing default local environment untouched", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const archivedAt = new Date("2025-01-01T00:00:00.000Z");
    const [existing] = await db
      .insert(environments)
      .values({
        companyId,
        name: "Archived Local",
        description: "Operator-managed local environment",
        driver: "local",
        status: "archived",
        config: { shell: "zsh" },
        metadata: { owner: "operator" },
        createdAt: archivedAt,
        updatedAt: archivedAt,
      })
      .returning();

    const ensured = await svc.ensureLocalEnvironment(companyId);

    expect(ensured.id).toBe(existing?.id);
    expect(ensured.name).toBe("Archived Local");
    expect(ensured.status).toBe("archived");
    expect(ensured.metadata).toEqual({ owner: "operator" });

    const rows = await db.select().from(environments).where(eq(environments.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedAt.toISOString()).toBe(archivedAt.toISOString());
  });

  it("deduplicates concurrent default local environment creation", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => svc.ensureLocalEnvironment(companyId)),
    );

    expect(new Set(results.map((environment) => environment.id)).size).toBe(1);

    const rows = await db.select().from(environments).where(eq(environments.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.driver).toBe("local");
    expect(rows[0]?.status).toBe("active");
  });

  it("allows multiple SSH environments for the same company", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const first = await svc.create(companyId, {
      name: "Production SSH",
      driver: "ssh",
      config: { host: "prod.example.com", username: "deploy" },
    });
    const second = await svc.create(companyId, {
      name: "Staging SSH",
      driver: "ssh",
      config: { host: "staging.example.com", username: "deploy" },
    });

    expect(first.id).not.toBe(second.id);

    const rows = await db.select().from(environments).where(eq(environments.companyId, companyId));
    expect(rows.filter((row) => row.driver === "ssh")).toHaveLength(2);
  });
});
