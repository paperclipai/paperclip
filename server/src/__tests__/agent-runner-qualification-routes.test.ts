import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, environments, principalPermissionGrants, activityLog, instanceSettings, builtInManagedResources, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { grantsForHumanRole } from "../services/company-member-roles.js";
import { agentRoutes } from "../routes/agents.js";
import { environmentRoutes } from "../routes/environments.js";
import { errorHandler } from "../middleware/error-handler.js";
import { environmentService } from "../services/environments.js";
import { resolveEnvironmentDriverConfigForRuntime } from "../services/environment-config.js";
import { fingerprintEnvironmentSandboxProviderConfig, SANDBOX_PLATFORM_PROBE_METADATA_KEY } from "../services/environment-custom-image-runtime.js";

const probe = vi.hoisted(() => vi.fn());
vi.mock("../services/environment-probe.js", async original => ({
  ...await original<object>(), probeEnvironment: probe,
}));

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("agent-scoped runner qualification", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let environmentId: string;
  let userId: string;
  let app: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("runner-qualification-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await tempDb?.cleanup(); });
  beforeEach(async () => {
    await db.delete(instanceSettings);
    await db.delete(environments);
    probe.mockReset().mockResolvedValue({ ok: true, driver: "sandbox", summary: "Connected",
      details: { platformQualificationRecorded: true, leaseId: "probe-lease", metadata: { private: "provider-secret" }, providerLeaseId: "private-id" } });
    companyId = randomUUID(); agentId = randomUUID(); environmentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Qualification", issuePrefix: `Q${companyId.slice(0, 7)}` });
    await db.insert(authUsers).values({ id: userId, name: "Company owner", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await db.insert(principalPermissionGrants).values(grantsForHumanRole("owner").map(grant => ({ ...grant, companyId, principalType: "user" as const, principalId: userId })));
    await db.insert(environments).values({ id: environmentId, name: `Paperclip Computer ${environmentId}`, driver: "sandbox", status: "active", config: { provider: "daytona", snapshot: "managed-snapshot" } });
    await db.insert(agents).values({ id: agentId, companyId, name: "Amy fixture", adapterType: "claude_local", defaultEnvironmentId: environmentId,
      adapterConfig: { model: "claude-opus-5-5", effort: "high", maxTurnsPerRun: 1000, dangerouslySkipPermissions: true } });
    app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId, companyIds: [companyId], source: "cloud_tenant", isInstanceAdmin: false,
        memberships: [{ companyId, membershipRole: "owner", status: "active" }] };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use("/api", environmentRoutes(db));
    app.use(errorHandler);
  });
  const qualify = () => request(app).post(`/api/agents/${agentId}/qualify-runner`).send({ expectedEnvironmentId: environmentId });

  it.each(["claude_local", "grok_local"])("allows the company owner to qualify %s without instance admin and keeps the generic probe restricted", async adapterType => {
    await db.update(agents).set({ adapterType }).where(eq(agents.id, agentId));
    const before = await db.select().from(agents).where(eq(agents.id, agentId));
    const res = await qualify();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, details: { platformQualificationRecorded: true, leaseId: "probe-lease" } });
    expect(JSON.stringify(res.body)).not.toMatch(/provider-secret|private-id/);
    expect(probe).toHaveBeenCalledWith(db, expect.objectContaining({ id: environmentId }), expect.objectContaining({ companyId, assertCompanyBinding: true, acquireSandboxRuntimeLease: true, applyCustomImageTemplate: true }));
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toEqual(before);
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, agentId));
    expect(audit).toEqual([expect.objectContaining({ companyId, actorId: userId, action: "agent.runner_qualification_tested" })]);
    const generic = await request(app).post(`/api/environments/${environmentId}/probe?companyId=${companyId}`).send({});
    expect(generic.status).toBe(403);
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it("lets the owner requalify an existing native runner's saved computer without changing its configuration", async () => {
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: "example/model" } })
      .where(eq(agents.id, agentId));
    const before = await db.select().from(agents).where(eq(agents.id, agentId));
    const response = await qualify();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, details: { platformQualificationRecorded: true } });
    expect(probe).toHaveBeenCalledWith(db, expect.objectContaining({ id: environmentId }),
      expect.objectContaining({ companyId, assertCompanyBinding: true, acquireSandboxRuntimeLease: true }));
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toEqual(before);
    expect(JSON.stringify(response.body)).not.toMatch(/provider-secret|private-id/);
    expect((await request(app).post(`/api/environments/${environmentId}/probe?companyId=${companyId}`).send({})).status).toBe(403);
  });

  it("reuses a current native snapshot proof without invalidating it or allocating another probe", async () => {
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "opencode" } }).where(eq(agents.id, agentId));
    const config = { provider: "daytona", snapshot: "managed-snapshot" };
    const fingerprint = fingerprintEnvironmentSandboxProviderConfig(config);
    const saved = (await environmentService(db).getById(environmentId))!;
    const runtime = await resolveEnvironmentDriverConfigForRuntime(db, companyId, saved, { applyCustomImageTemplate: true, readOnlyCustomImageTemplate: true });
    const runtimeFingerprint = fingerprintEnvironmentSandboxProviderConfig(runtime.config as typeof config);
    const metadata = { [SANDBOX_PLATFORM_PROBE_METADATA_KEY]: { [companyId]: {
      v: 2, companyId, baseConfigFingerprint: fingerprint, runtimeConfigFingerprint: runtimeFingerprint,
      snapshot: config.snapshot, template: null,
      snapshotIdentity: { provider: "daytona", requestedRef: config.snapshot, id: randomUUID(), name: config.snapshot,
        organizationId: "fixture-organization", createdAt: new Date().toISOString() },
      facts: { platform: "linux", architecture: "x64", libc: "glibc", glibcVersion: "2.36" },
    } } };
    await db.update(environments).set({ metadata }).where(eq(environments.id, environmentId));
    expect((await qualify()).body).toMatchObject({ ok: true, details: { platformQualificationRecorded: true } });
    expect(probe).not.toHaveBeenCalled();
    expect((await db.select().from(environments).where(eq(environments.id, environmentId)))[0]?.metadata).toEqual(metadata);
  });

  it.each(["revoked", "changed-computer", "foreign-computer"])("keeps native saved-computer qualification closed for %s authority", async state => {
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "opencode" } }).where(eq(agents.id, agentId));
    if (state === "revoked") await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId));
    if (state === "changed-computer") await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, agentId));
    if (state === "foreign-computer") {
      const other = randomUUID();
      await db.insert(companies).values({ id: other, name: "Other", issuePrefix: `F${other.slice(0, 7)}` });
      await db.insert(builtInManagedResources).values({ companyId: other, bundleKey: "test", resourceKind: "environment", resourceKey: "computer", resourceId: environmentId, stockVersion: "test", stockHash: "test" });
    }
    expect((await qualify()).status).toBe(state === "changed-computer" ? 409 : 403);
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects an owner whose configure grant is absent before any provider work", async () => {
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId));
    expect((await qualify()).status).toBe(403);
    expect(probe).not.toHaveBeenCalled();
  });
  it("hides a foreign agent before any provider work", async () => {
    const other = randomUUID();
    await db.insert(companies).values({ id: other, name: "Other", issuePrefix: `F${other.slice(0, 7)}` });
    await db.update(agents).set({ companyId: other }).where(eq(agents.id, agentId));
    expect((await qualify()).status).toBe(404);
    expect(probe).not.toHaveBeenCalled();
  });
  it("treats the submitted environment as a stale-state check, not a target override", async () => {
    const res = await request(app).post(`/api/agents/${agentId}/qualify-runner`).send({ expectedEnvironmentId: randomUUID() });
    expect(res.status).toBe(409);
    expect(probe).not.toHaveBeenCalled();
  });
  it("rejects a managed computer bound to a different company", async () => {
    const other = randomUUID();
    await db.insert(companies).values({ id: other, name: "Other", issuePrefix: `F${other.slice(0, 7)}` });
    await db.insert(builtInManagedResources).values({ companyId: other, bundleKey: "test", resourceKind: "environment", resourceKey: "computer", resourceId: environmentId, stockVersion: "test", stockHash: "test" });
    expect((await qualify()).status).toBe(403);
    expect(probe).not.toHaveBeenCalled();
  });
  it.each(["instance", "managed", "kubernetes"])("resolves the %s computer with the same policy as runner saving", async mode => {
    await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, agentId));
    await db.update(environments).set({ metadata: { managedByPaperclip: true, managedKubernetesSandbox: mode === "kubernetes" },
      ...(mode === "kubernetes" ? { config: { provider: "kubernetes" } } : {}) }).where(eq(environments.id, environmentId));
    await db.insert(instanceSettings).values({ defaultEnvironmentId: mode === "instance" ? environmentId : null,
      experimental: { enableManagedSandboxOnly: mode === "managed" }, general: { executionMode: mode === "kubernetes" ? "kubernetes" : "local" } });
    expect((await qualify()).status).toBe(200);
    expect(probe).toHaveBeenCalledWith(db, expect.objectContaining({ id: environmentId }), expect.anything());
  });
  it("does not accept arbitrary provider config or a target override", async () => {
    const res = await request(app).post(`/api/agents/${agentId}/qualify-runner`).send({ expectedEnvironmentId: environmentId, config: { image: "untrusted" } });
    expect(res.status).toBe(400);
    expect(probe).not.toHaveBeenCalled();
  });
  it.each(["archived", "local"])("rejects an ineligible %s environment", async state => {
    await db.update(environments).set(state === "archived" ? { status: "archived" } : { driver: "local", config: {} }).where(eq(environments.id, environmentId));
    expect((await qualify()).status).toBe(422);
    expect(probe).not.toHaveBeenCalled();
  });
  it("returns a failed qualification without exposing provider diagnostics or changing the agent", async () => {
    probe.mockResolvedValue({ ok: false, driver: "sandbox", summary: "provider-secret", details: { error: "provider-secret" } });
    const res = await qualify();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("provider-secret");
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]?.adapterType).toBe("claude_local");
  });
});
