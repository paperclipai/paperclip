import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, companySecrets, companySecretVersions, activityLog, plugins, toolApplications, toolConnections, createDb, type Db } from "@paperclipai/db";
import type { AgentLifecycleRequest } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pluginAgentRuntimeIdentity } from "../services/plugin-agent-runtime-state.js";
import { agentInstanceSecretService } from "../services/agent-instance-secrets.js";
import { secretService } from "../services/secrets.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { logger } from "../middleware/logger.js";
import { resolveCodexAuthCacheDir } from "@paperclipai/adapter-codex-local/server";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { awsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent instance secrets use the tenant secret system", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let pluginId: string;
  const runtime = JSON.stringify({ url: "https://runtime.example.test", token: "e".repeat(64) });
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-instance-secrets-");
    db = createDb(database.connectionString);
    companyId = randomUUID(); pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Secret fixture", issuePrefix: "SCR" });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "fixture-lifecycle", version: "1.0.0", status: "ready",
      manifestJson: { agentLifecycle: true, resourceLifecycle: ["agent_runtime"], capabilities: ["agents.lifecycle.manage"] } as never });
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); });
  async function fixture(ownerPluginId = pluginId, agentId = randomUUID()) {
    const operationId = randomUUID();
    const owner = randomUUID();
    const now = new Date();
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Secret owner", lifecycleState: "preparing", lifecycleVersion: 1,
      lifecycleRequiredPluginIds: [ownerPluginId], lifecycleOperation: { id: operationId, hostComplete: true, completedPluginIds: [], attempts: 0,
        leaseOwner: owner, leaseUntil: new Date(now.getTime() + 120_000).toISOString() } }).returning();
    const request: AgentLifecycleRequest = { companyId, agentId: agent.id, operationId, version: 1, phase: "preparing" };
    const scope = { companyId, agentId: agent.id, pluginId: ownerPluginId };
    const native = agentInstanceSecretService(db);
    const service = { read: native.read, apply: (input: AgentLifecycleRequest, id: string, changes: unknown, attemptOwner = owner) => native.apply(input, id, changes, attemptOwner) };
    return { agent, request, scope, service, owner };
  }

  it("persists and rotates native secret versions, survives restart, and isolates agent, company and plugin", async () => {
    const f = await fixture();
    await f.service.apply(f.request, pluginId, { runtime });
    const [stored] = await db.select().from(companySecrets).where(eq(companySecrets.ownerAgentId, f.agent.id));
    expect(stored).toMatchObject({ scope: "instance", ownerPluginId: pluginId, provider: "local_encrypted", latestVersion: 1 });
    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, stored.id));
    expect(versions).toHaveLength(1);
    expect(JSON.stringify(versions)).not.toContain("e".repeat(64));
    expect(JSON.stringify(versions)).not.toContain("runtime.example.test");
    expect(await agentInstanceSecretService(createDb(database.connectionString)).read(f.scope)).toEqual({ runtime });
    expect((await pluginAgentRuntimeIdentity(db, pluginId, companyId, f.agent.id))!.instanceSecrets).toEqual({ runtime });
    for (const scope of [{ ...f.scope, companyId: randomUUID() }, { ...f.scope, agentId: randomUUID() }, { ...f.scope, pluginId: randomUUID() }]) {
      expect(await f.service.read(scope)).toEqual({});
    }
    const replacement = runtime.replace("e".repeat(64), "f".repeat(64));
    await f.service.apply(f.request, pluginId, { runtime: replacement });
    expect((await pluginAgentRuntimeIdentity(db, pluginId, companyId, f.agent.id))!.instanceSecrets).toEqual({ runtime: replacement });
    expect(await f.service.read(f.scope)).toEqual({ runtime: replacement });
    expect((await secretService(db).getById(stored.id))!.latestVersion).toBe(2);
    expect(JSON.stringify(await db.select().from(activityLog).where(eq(activityLog.entityId, f.agent.id)))).not.toContain(replacement);
  });

  it("removes a plugin instance secret while a company connection save waits for its owner", async () => {
    const [lower, higher] = [randomUUID(), randomUUID()].sort();
    await db.insert(agents).values({ id: lower, companyId, name: "Unrelated lower agent" });
    const f = await fixture(pluginId, higher);
    await f.service.apply(f.request, pluginId, { runtime });
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Instance removal fixture", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "Instance removal fixture", uid: randomUUID(), transport: "mcp_remote", authKind: "none", status: "active" }).returning();
    let paused!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { paused = resolve; });
    const mayRemove = new Promise<void>(resolve => { resume = resolve; });
    const settingsStarted = new Promise<number>(resolve => { started = resolve; });
    const removeProvider = localEncryptedProvider.deleteOrArchive.bind(localEncryptedProvider);
    const providerSpy = vi.spyOn(localEncryptedProvider, "deleteOrArchive").mockImplementation(async input => {
      paused(); await mayRemove;
      return removeProvider(input);
    });
    const removal = f.service.apply(f.request, pluginId, { runtime: null });
    await held;
    const settings = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      await tx.update(toolConnections).set({ name: "Saved during instance removal" }).where(eq(toolConnections.id, connection.id));
    });
    const completed = Promise.allSettled([removal, settings]);
    try {
      const pid = await settingsStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); await completed; providerSpy.mockRestore(); }
    const results = await completed;
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(await f.service.read(f.scope)).toEqual({});
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id)))[0].name).toBe("Saved during instance removal");
  }, 15000);

  it("excludes instance secrets from company catalogs, ordinary resolution, bindings and agent access", async () => {
    const f = await fixture(); await f.service.apply(f.request, pluginId, { runtime });
    const [stored] = await db.select().from(companySecrets).where(eq(companySecrets.ownerAgentId, f.agent.id));
    const secrets = secretService(db);
    expect((await secrets.list(companyId)).some(secret => secret.id === stored.id)).toBe(false);
    expect(await secrets.getByName(companyId, "runtime")).toBeNull();
    expect(await secrets.getByKey(companyId, "runtime")).toBeNull();
    await expect(secrets.resolveSecretValue(companyId, stored.id, "latest")).rejects.toThrow("secret declarations");
    await expect(secrets.createBinding({ companyId, secretId: stored.id, targetType: "agent", targetId: f.agent.id, configPath: "env.RUNTIME" })).rejects.toThrow("company-scoped");
  });

  it("fences stale writes and removals, and cascades credentials when the owning agent is deleted", async () => {
    const f = await fixture(); await f.service.apply(f.request, pluginId, { runtime });
    for (const patch of [{ version: 2 }, { operationId: randomUUID() }, { phase: "cleaning_up" }, { companyId: randomUUID() }, { agentId: randomUUID() }]) {
      await expect(f.service.apply({ ...f.request, ...patch } as AgentLifecycleRequest, pluginId, { runtime: null })).rejects.toThrow("stale or outside scope");
    }
    await expect(f.service.apply(f.request, randomUUID(), { runtime })).rejects.toThrow("stale or outside scope");
    await db.update(agents).set({ lifecycleState: "cleaning_up", lifecycleVersion: 2 }).where(eq(agents.id, f.agent.id));
    await expect(f.service.apply(f.request, pluginId, { runtime })).rejects.toThrow("stale or outside scope");
    const cleanup = { ...f.request, version: 2, phase: "cleaning_up" as const };
    await expect(f.service.apply(cleanup, pluginId, { runtime })).rejects.toThrow("preparation or resume");
    await f.service.apply(cleanup, pluginId, { runtime: null });
    expect(await f.service.read(f.scope)).toEqual({});
    await db.delete(agents).where(eq(agents.id, f.agent.id));
    expect(await db.select().from(companySecrets).where(eq(companySecrets.ownerAgentId, f.agent.id))).toEqual([]);
  });

  it("fails without acknowledging storage errors and validates changes before writes", async () => {
    const f = await fixture();
    const spy = vi.spyOn(localEncryptedProvider, "createSecret").mockRejectedValueOnce(new Error(runtime));
    const warnings = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await expect(f.service.apply(f.request, pluginId, { runtime })).rejects.toThrow("storage unavailable");
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("e".repeat(64));
    warnings.mockRestore();
    spy.mockRestore();
    expect(await f.service.read(f.scope)).toEqual({});
    for (const changes of [null, [], { invalid: 1 }, { runtime: "" }, { "bad/key": runtime }, { runtime: "x".repeat(65_537) }]) {
      await expect(f.service.apply(f.request, pluginId, changes)).rejects.toThrow("Invalid agent instance secret changes");
    }
  });

  it("saves the existing local lifecycle reply before completion and supplies secrets on the next invocation", async () => {
    const f = await fixture();
    const call = vi.fn(async (_id, _method, input) => ({ operationId: input.operationId, version: input.version, status: "complete", instanceSecrets: { runtime } }));
    const driver = createLifecycleDriver(db, { call } as never);
    const store = createLifecycleStore(db, {} as never);
    const snapshot = (await store.get(f.agent.id))!;
    expect(await driver.runPlugin(snapshot, pluginId)).toBe("complete");
    expect(await f.service.read(f.scope)).toEqual({ runtime });
    expect(call.mock.calls[0][2].instanceSecrets).toEqual({});
    await driver.runPlugin(snapshot, pluginId);
    expect(call.mock.calls[1][2].instanceSecrets).toEqual({ runtime });
    call.mockImplementationOnce(async (_id, _method, input) => {
      await db.update(agents).set({ lifecycleVersion: 2, lifecycleState: "terminating" }).where(eq(agents.id, f.agent.id));
      return { operationId: input.operationId, version: input.version, status: "complete", instanceSecrets: { runtime: "stale credentials" } };
    });
    await expect(driver.runPlugin(snapshot, pluginId)).rejects.toThrow("stale or outside scope");
    expect(await f.service.read(f.scope)).toEqual({ runtime });
  });

  it("preserves the native guard against missing account-home directories", async () => {
    const f = await fixture();
    const missing = path.join(resolveCodexAuthCacheDir(undefined, companyId), "missing-instance-secret-fixture");
    await expect(f.service.apply(f.request, pluginId, { runtime: missing })).rejects.toThrow("storage unavailable");
    expect(await f.service.read(f.scope)).toEqual({});
  });

  it("rejects a previous attempt after lease takeover and rejects an expired owner's writes", async () => {
    const f = await fixture(); await f.service.apply(f.request, pluginId, { runtime });
    const snapshot = (await createLifecycleStore(db, {} as never).get(f.agent.id))!;
    const successor = randomUUID();
    await db.update(agents).set({ lifecycleOperation: { ...f.agent.lifecycleOperation!, leaseOwner: successor } }).where(eq(agents.id, f.agent.id));
    await f.service.apply(f.request, pluginId, { runtime: "successor credentials" }, successor);
    await expect(f.service.apply(f.request, pluginId, { runtime })).rejects.toThrow("stale or outside scope");
    await expect(f.service.apply(f.request, pluginId, { runtime: null })).rejects.toThrow("stale or outside scope");
    const call = vi.fn(async (_id, _method, input) => ({ operationId: input.operationId, version: input.version, status: "complete", instanceSecrets: { runtime } }));
    await expect(createLifecycleDriver(db, { call } as never).runPlugin(snapshot, pluginId)).rejects.toThrow("stale or outside scope");
    expect(await f.service.read(f.scope)).toEqual({ runtime: "successor credentials" });
    await db.update(agents).set({ lifecycleOperation: { ...f.agent.lifecycleOperation!, leaseOwner: successor, leaseUntil: new Date(0).toISOString() } }).where(eq(agents.id, f.agent.id));
    await expect(f.service.apply(f.request, pluginId, { runtime }, successor)).rejects.toThrow("stale or outside scope");
    expect(await f.service.read(f.scope)).toEqual({ runtime: "successor credentials" });
  });

  it("deletes live secret metadata and versions with the owning agent or plugin", async () => {
    for (const deleting of ["agent", "plugin"] as const) {
      const ownerPluginId = randomUUID();
      await db.insert(plugins).values({ id: ownerPluginId, pluginKey: ownerPluginId, packageName: "fixture-cascade", version: "1.0.0", status: "ready",
        manifestJson: { agentLifecycle: true, capabilities: ["agents.lifecycle.manage"] } as never });
      const f = await fixture(ownerPluginId);
      await f.service.apply(f.request, ownerPluginId, { runtime });
      const [stored] = await db.select().from(companySecrets).where(eq(companySecrets.ownerAgentId, f.agent.id));
      expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, stored.id))).toHaveLength(1);
      if (deleting === "agent") await db.delete(agents).where(eq(agents.id, f.agent.id));
      else await db.delete(plugins).where(eq(plugins.id, ownerPluginId));
      expect(await secretService(db).getById(stored.id)).toBeNull();
      expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, stored.id))).toEqual([]);
    }
  });

  it("can clean up after a lost master key without decrypting credentials", async () => {
    const f = await fixture(); await f.service.apply(f.request, pluginId, { runtime });
    const masterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY!;
    try {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
      await expect(f.service.read(f.scope)).rejects.toThrow("Agent instance secret unavailable");
      await db.update(agents).set({ lifecycleState: "cleaning_up", lifecycleVersion: 2 }).where(eq(agents.id, f.agent.id));
      const call = vi.fn(async (_id, _method, input) => ({ operationId: input.operationId, version: input.version, status: "complete", instanceSecrets: { runtime: null } }));
      const driver = createLifecycleDriver(db, { call } as never);
      const snapshot = (await createLifecycleStore(db, {} as never).get(f.agent.id))!;
      expect(await driver.runPlugin(snapshot, pluginId)).toBe("complete");
      expect(call.mock.calls[0][2].instanceSecrets).toEqual({});
      expect(await f.service.read(f.scope)).toEqual({});
    } finally { vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", masterKey); }
  });

  it("allows company vault imports with the same name and key as an instance secret", async () => {
    const f = await fixture();
    await f.service.apply(f.request, pluginId, { runtime });
    const secrets = secretService(db);
    const vault = await secrets.createProviderConfig(companyId, {
      provider: "aws_secrets_manager", displayName: "Import fixture", config: { region: "us-east-1" },
    });
    const externalRef = "arn:aws:secretsmanager:us-east-1:123456789012:secret:runtime";
    const list = vi.spyOn(awsSecretsManagerProvider, "listRemoteSecrets").mockResolvedValue({
      secrets: [{ externalRef, name: "runtime", providerVersionRef: null, metadata: {} }],
    });
    try {
      const preview = await secrets.previewRemoteImport(companyId, { providerConfigId: vault.id });
      expect(preview.candidates[0]).toMatchObject({ status: "ready", importable: true, conflicts: [] });
      const result = await secrets.importRemoteSecrets(companyId, {
        providerConfigId: vault.id, secrets: [{ externalRef, name: "runtime", key: "runtime" }],
      });
      expect(result).toMatchObject({ importedCount: 1, skippedCount: 0, errorCount: 0 });
      expect(await f.service.read(f.scope)).toEqual({ runtime });
      const imported = await secrets.getByName(companyId, "runtime");
      expect(imported).toMatchObject({ scope: "company", externalRef });
      await secrets.remove(imported!.id);
    } finally { list.mockRestore(); }
  });

  it("protects instance-owned account homes without exposing their values in the company catalog", async () => {
    const f = await fixture();
    const accountHome = path.join(resolveCodexAuthCacheDir(undefined, companyId), randomUUID());
    await mkdir(accountHome, { recursive: true });
    const secrets = secretService(db);
    try {
      await f.service.apply(f.request, pluginId, { account_home: accountHome });
      expect(await secrets.hasInstanceAccountHomeClaim(companyId, accountHome)).toBe(true);
      expect(await secrets.hasInstanceAccountHomeClaim(randomUUID(), accountHome)).toBe(false);
      expect(await secrets.hasInstanceAccountHomeClaim(companyId, accountHome + "-other")).toBe(false);
      expect((await secrets.list(companyId)).some(secret => secret.ownerAgentId === f.agent.id)).toBe(false);
      const resolve = vi.spyOn(localEncryptedProvider, "resolveVersion").mockRejectedValueOnce(new Error("unavailable"));
      try { expect(await secrets.hasInstanceAccountHomeClaim(companyId, accountHome)).toBe(true); }
      finally { resolve.mockRestore(); }
      await f.service.apply(f.request, pluginId, { account_home: null });
      expect(await secrets.hasInstanceAccountHomeClaim(companyId, accountHome)).toBe(false);
    } finally { await rm(accountHome, { recursive: true, force: true }); }
  });

  it("keeps same-named company and other-agent secrets independent", async () => {
    const f = await fixture(); const other = await fixture();
    const companySecret = await secretService(db).create(companyId, { name: "runtime", provider: "local_encrypted", value: "ordinary company secret" });
    await f.service.apply(f.request, pluginId, { runtime });
    await other.service.apply(other.request, pluginId, { runtime: "other agent connection" });
    expect(await f.service.read(f.scope)).toEqual({ runtime });
    expect(await other.service.read(other.scope)).toEqual({ runtime: "other agent connection" });
    expect(await secretService(db).resolveSecretValue(companyId, companySecret.id, "latest")).toBe("ordinary company secret");
    await f.service.apply(f.request, pluginId, { runtime: null });
    expect(await other.service.read(other.scope)).toEqual({ runtime: "other agent connection" });
    expect(await secretService(db).getByName(companyId, "runtime")).toMatchObject({ id: companySecret.id });
  });
});
