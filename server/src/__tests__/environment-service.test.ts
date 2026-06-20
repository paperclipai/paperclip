import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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
      .where(eq(environments.companyId, companyId));
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
      .where(and(eq(environments.companyId, companyId), eq(environments.driver, "sandbox")));
    expect(rows).toHaveLength(1);
    expect((rows[0]?.metadata as Record<string, unknown>)?.managedKubernetesSandbox).toBe(true);
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
      companyId,
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
      companyId,
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
    expect(raisedConstraint).toBe("environments_company_managed_sandbox_idx");

    // Index does NOT cover tenant-created sandbox rows (no managedByPaperclip
    // marker) — operators must be able to keep multiple tenant sandbox envs.
    await db.insert(environments).values({
      companyId,
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
      .where(and(eq(environments.companyId, companyId), eq(environments.driver, "sandbox")));
    expect(rows).toHaveLength(2);
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

  it("findManagedSandboxEnvironment returns any active sandbox provider, unlike findKubernetesEnvironment", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // No sandbox configured yet → both lookups null.
    expect(await svc.findManagedSandboxEnvironment(companyId)).toBeNull();

    // A non-Kubernetes sandbox (e.g. Daytona/E2B stand-in): findKubernetes
    // ignores it, but the provider-agnostic lookup returns it so
    // executionMode="sandbox" can pin onto it.
    const fake = await svc.create(companyId, {
      name: "Fake Sandbox",
      driver: "sandbox",
      config: { provider: "fake", image: "busybox", reuseLease: false },
    });
    expect(await svc.findKubernetesEnvironment(companyId)).toBeNull();
    expect((await svc.findManagedSandboxEnvironment(companyId))?.id).toBe(fake.id);
  });

  it("ensureManagedSandboxEnvironment auto-provisions a generic sandbox and is idempotent", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const created = await svc.ensureManagedSandboxEnvironment(companyId, {
      provider: "daytona",
      config: { apiUrl: "https://daytona.example", target: "eu" },
    });
    expect(created.driver).toBe("sandbox");
    expect(created.config.provider).toBe("daytona");
    expect(created.config.apiUrl).toBe("https://daytona.example");
    expect(created.metadata?.managedByPaperclip).toBe(true);
    expect(created.metadata?.managedSandbox).toBe(true);

    // Idempotent: second call refreshes config in place, no new row.
    const refreshed = await svc.ensureManagedSandboxEnvironment(companyId, {
      provider: "daytona",
      config: { apiUrl: "https://daytona.example", target: "us" },
    });
    expect(refreshed.id).toBe(created.id);
    expect(refreshed.config.target).toBe("us");

    // It is the env the provider-agnostic lookup pins onto, and is NOT mistaken
    // for the managed Kubernetes env.
    expect((await svc.findManagedSandboxEnvironment(companyId))?.id).toBe(created.id);
    expect(await svc.findKubernetesEnvironment(companyId)).toBeNull();

    const rows = await db
      .select()
      .from(environments)
      .where(and(eq(environments.companyId, companyId), eq(environments.driver, "sandbox")));
    expect(rows).toHaveLength(1);
  });

  it("findManagedSandboxEnvironment ignores a provider-less sandbox env (treated as unconfigured)", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // A sandbox row without a provider key is a misconfiguration; the lookup
    // must return null so the heartbeat raises the actionable
    // "configure a sandbox provider" error instead of pinning onto it.
    await svc.create(companyId, {
      name: "Provider-less Sandbox",
      driver: "sandbox",
      config: { reuseLease: false },
    });

    expect(await svc.findManagedSandboxEnvironment(companyId)).toBeNull();
  });

  it("findManagedSandboxEnvironment prefers a Paperclip-managed sandbox when several exist", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await svc.create(companyId, {
      name: "Tenant Sandbox",
      driver: "sandbox",
      config: { provider: "fake", image: "busybox", reuseLease: false },
    });
    const managed = await svc.ensureKubernetesEnvironment(companyId, {
      backend: "job",
      inCluster: true,
    });

    expect((await svc.findManagedSandboxEnvironment(companyId))?.id).toBe(managed.id);
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

    const rows = await db.select().from(environments).where(eq(environments.companyId, companyId));
    expect(rows.filter((row) => row.driver === "ssh")).toHaveLength(2);
  });
});
