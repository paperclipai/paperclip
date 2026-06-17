import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentService } from "../services/environments.ts";

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
      name: "Lease Fixture",
      driver: "ssh",
      status: "active",
      config: {
        host: "fixture.example.test",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/srv/paperclip",
      },
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

    return { companyId, agentId, environmentId, runId };
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

    const rows = await db.select().from(environments).where(eq(environments.driver, "local"));
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

    const rows = await db.select().from(environments).where(eq(environments.driver, "local"));
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

    const rows = await db.select().from(environments).where(eq(environments.driver, "local"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.driver).toBe("local");
    expect(rows[0]?.status).toBe("active");
  });

  it("ensures, refreshes, and finds a managed Kubernetes sandbox environment", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // No managed k8s env yet.
    expect(await svc.findKubernetesEnvironment(companyId)).toBeNull();

    const created = await svc.ensureKubernetesEnvironment(companyId, {
      backend: "job",
      inCluster: true,
      runtimeClassName: "gvisor",
      egressMode: "cilium",
      egressAllowFqdns: ["api.anthropic.com"],
    });

    expect(created.driver).toBe("sandbox");
    expect(created.config.provider).toBe("kubernetes");
    expect(created.config.backend).toBe("job");
    expect(created.config.runtimeClassName).toBe("gvisor");
    expect(created.metadata?.managedKubernetesSandbox).toBe(true);

    // Idempotent: second call refreshes config in place, no new row.
    const refreshed = await svc.ensureKubernetesEnvironment(companyId, {
      backend: "job",
      inCluster: true,
      egressMode: "cilium",
      egressAllowFqdns: ["api.anthropic.com", "api.openai.com"],
    });
    expect(refreshed.id).toBe(created.id);
    expect(refreshed.config.egressAllowFqdns).toEqual([
      "api.anthropic.com",
      "api.openai.com",
    ]);

    const found = await svc.findKubernetesEnvironment(companyId);
    expect(found?.id).toBe(created.id);

    const rows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "sandbox"));
    expect(rows.filter((row) => row.driver === "sandbox")).toHaveLength(1);
  });

  it("deduplicates concurrent managed Kubernetes environment creation", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // No partial unique index covers sandbox drivers yet, so dedup is
    // post-insert convergence (prefer the oldest row, delete the loser).
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        svc.ensureKubernetesEnvironment(companyId, { inCluster: true, backend: "job" }),
      ),
    );

    expect(new Set(results.map((environment) => environment.id)).size).toBe(1);

    const rows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "sandbox"));
    expect(rows).toHaveLength(1);
    expect((rows[0]?.metadata as Record<string, unknown>)?.managedKubernetesSandbox).toBe(true);
  });

  it("returns a conflict when creating a second environment with the same name", async () => {
    await seedEnvironment();

    await svc.create({
      name: "Shared Fixture",
      driver: "ssh",
      status: "active",
      config: {
        host: "fixture.example.test",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/srv/paperclip",
      },
    });

    await expect(svc.create({
      name: "Shared Fixture",
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        reuseLease: false,
      },
    })).rejects.toMatchObject({
      status: 409,
      message: 'An environment named "Shared Fixture" already exists for this instance.',
    });
  });

  it("returns a conflict when renaming an environment to an existing name", async () => {
    const { environmentId } = await seedEnvironment();
    const otherEnvironmentId = randomUUID();
    const now = new Date();

    await db.insert(environments).values({
      id: otherEnvironmentId,
      name: "Other Fixture",
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        reuseLease: false,
      },
      createdAt: now,
      updatedAt: now,
    });

    await expect(svc.update(otherEnvironmentId, {
      name: "Lease Fixture",
    })).rejects.toMatchObject({
      status: 409,
      message: 'An environment named "Lease Fixture" already exists for this instance.',
    });

    const original = await svc.getById(environmentId);
    expect(original?.name).toBe("Lease Fixture");
  });

  it("rejects a second managed-sandbox row for the same company at the DB level", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const now = new Date();
    await db.insert(environments).values({
      name: "First",
      driver: "sandbox",
      status: "active",
      config: { provider: "kubernetes" },
      metadata: { managedByPaperclip: true, managedKubernetesSandbox: true },
      createdAt: now,
      updatedAt: now,
    });

    // Partial unique index environments_company_managed_sandbox_idx rejects a
    // second row matching driver='sandbox' AND managedByPaperclip=true for the
    // same company. This is the DB-level invariant that replaced the previous
    // application-side post-insert convergence loop.
    const secondInsert = db.insert(environments).values({
      name: "Second",
      driver: "sandbox",
      status: "active",
      config: { provider: "kubernetes" },
      metadata: { managedByPaperclip: true, managedKubernetesSandbox: true },
      createdAt: new Date(now.getTime() + 1),
      updatedAt: new Date(now.getTime() + 1),
    });
    let raisedConstraint: string | null = null;
    try {
      await secondInsert;
    } catch (error) {
      raisedConstraint =
        (error as { constraint_name?: string; cause?: { constraint_name?: string } })
          ?.constraint_name ??
        (error as { cause?: { constraint_name?: string } })?.cause?.constraint_name ??
        "unknown";
    }
    expect(raisedConstraint).toBe("environments_managed_sandbox_idx");

    // Index does NOT cover tenant-created sandbox rows (no managedByPaperclip
    // marker) — operators must be able to keep multiple tenant sandbox envs.
    await db.insert(environments).values({
      name: "Tenant Sandbox",
      driver: "sandbox",
      status: "active",
      config: { provider: "fake" },
      metadata: { tenant: true },
      createdAt: new Date(now.getTime() + 2),
      updatedAt: new Date(now.getTime() + 2),
    });

    const rows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "sandbox"));
    expect(rows).toHaveLength(2);
  });

  it("reconciles pre-existing duplicate managed Kubernetes environments deterministically", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const olderCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const newerCreatedAt = new Date("2026-01-02T00:00:00.000Z");
    const [older, newer] = await db
      .insert(environments)
      .values([
        {
          companyId,
          name: "Kubernetes Sandbox",
          description: "Oldest managed row",
          driver: "sandbox",
          status: "active",
          config: { provider: "kubernetes", backend: "job", inCluster: false },
          metadata: { managedByPaperclip: true, managedKubernetesSandbox: true },
          createdAt: olderCreatedAt,
          updatedAt: olderCreatedAt,
        },
        {
          companyId,
          name: "Kubernetes Sandbox Duplicate",
          description: "Legacy duplicate row missing managedByPaperclip",
          driver: "sandbox",
          status: "active",
          config: { provider: "kubernetes", backend: "job", inCluster: false },
          metadata: { managedKubernetesSandbox: true },
          createdAt: newerCreatedAt,
          updatedAt: newerCreatedAt,
        },
      ])
      .returning();

    const [lease] = await db
      .insert(environmentLeases)
      .values({
        companyId,
        environmentId: newer!.id,
        status: "active",
        leasePolicy: "ephemeral",
        acquiredAt: newerCreatedAt,
        lastUsedAt: newerCreatedAt,
        createdAt: newerCreatedAt,
        updatedAt: newerCreatedAt,
      })
      .returning();

    const ensured = await svc.ensureKubernetesEnvironment(companyId, {
      backend: "job",
      inCluster: true,
      runtimeClassName: "gvisor",
    });

    expect(ensured.id).toBe(older?.id);
    expect(ensured.config.inCluster).toBe(true);
    expect(ensured.config.runtimeClassName).toBe("gvisor");

    const rows = await db
      .select()
      .from(environments)
      .where(and(eq(environments.companyId, companyId), eq(environments.driver, "sandbox")))
      .orderBy(asc(environments.createdAt), asc(environments.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(older?.id);
    expect(rows[0]?.id).not.toBe(newer?.id);
    expect((rows[0]?.config as Record<string, unknown>)?.inCluster).toBe(true);
    expect((rows[0]?.metadata as Record<string, unknown>)?.managedKubernetesSandbox).toBe(true);

    const leaseRows = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, companyId));
    expect(leaseRows).toHaveLength(1);
    expect(leaseRows[0]?.id).toBe(lease?.id);
    expect(leaseRows[0]?.environmentId).toBe(older?.id);
  });

  it("does not treat a non-kubernetes sandbox environment as the managed k8s env", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await svc.create(companyId, {
      name: "Fake Sandbox",
      driver: "sandbox",
      config: { provider: "fake", image: "busybox", reuseLease: false },
    });

    expect(await svc.findKubernetesEnvironment(companyId)).toBeNull();
  });

  it("ignores a config.provider=kubernetes sandbox env without the managed marker", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // A tenant-created sandbox env with config.provider "kubernetes" but WITHOUT
    // the managed metadata marker must NOT be treated as the managed k8s env,
    // otherwise it would bypass the operator gVisor runtimeClass / Cilium egress.
    await svc.create(companyId, {
      name: "Tenant K8s Sandbox",
      driver: "sandbox",
      config: { provider: "kubernetes", reuseLease: false },
    });

    expect(await svc.findKubernetesEnvironment(companyId)).toBeNull();

    // The managed env (created via ensureKubernetesEnvironment) carries the
    // marker and is the only one found.
    const managed = await svc.ensureKubernetesEnvironment(companyId, {
      backend: "job",
      inCluster: true,
      runtimeClassName: "gvisor",
    });
    const found = await svc.findKubernetesEnvironment(companyId);
    expect(found?.id).toBe(managed.id);
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

    const rows = await db.select().from(environments);
    expect(rows.filter((row) => row.driver === "ssh")).toHaveLength(2);
  });
});
