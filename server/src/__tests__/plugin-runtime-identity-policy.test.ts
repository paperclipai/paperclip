import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companySecrets, companySecretVersions, createDb, pluginCompanySettings, plugins, resourceLifecycleEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInstanceSecretService } from "../services/agent-instance-secrets.js";
import { pluginAgentRuntimeIdentity, pluginAgentRuntimeState } from "../services/plugin-agent-runtime-state.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("plugin runtime policy snapshots", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "plugin-runtime-policy-home-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    temporary = await startEmbeddedPostgresTestDatabase("plugin-runtime-policy-");
    db = createDb(temporary.connectionString, { maxConnections: 4 });
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    await rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), pluginId = randomUUID();
    const operationId = randomUUID(), owner = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic policy fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "synthetic-policy", version: "1", status: "ready",
      manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["agents.lifecycle.manage"] } as never });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic runtime agent", status: "idle",
      lifecycleState: "preparing", lifecycleVersion: 1, lifecycleRequiredPluginIds: [pluginId],
      lifecycleOperation: { id: operationId, hostComplete: true, completedPluginIds: [], attempts: 0,
        leaseOwner: owner, leaseUntil: new Date(Date.now() + 120_000).toISOString() } });
    return { companyId, agentId, pluginId, operationId, owner };
  }

  it("keeps absent company settings enabled and full runtime attribution equal to compact identity", async () => {
    const f = await fixture();
    const full = await pluginAgentRuntimeState(db, f.pluginId, f.companyId, f.agentId);
    const compact = await pluginAgentRuntimeIdentity(db, f.pluginId, f.companyId, f.agentId);
    expect(compact).not.toBeNull();
    expect(full?.revision).toBe(compact!.revision);
    expect(full?.agent).toMatchObject(compact!.agent);
    expect(full?.instanceSecrets).toEqual(compact!.instanceSecrets);
    await db.insert(pluginCompanySettings).values({ pluginId: f.pluginId, companyId: f.companyId, enabled: false });
    await expect(pluginAgentRuntimeIdentity(db, f.pluginId, f.companyId, f.agentId)).rejects.toMatchObject({ status: 403 });
    await expect(pluginAgentRuntimeState(db, f.pluginId, f.companyId, f.agentId)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects missing plugins, foreign companies, and non-owning lifecycle plugins", async () => {
    const f = await fixture();
    expect(await pluginAgentRuntimeIdentity(db, f.pluginId, randomUUID(), f.agentId)).toBeNull();
    await expect(pluginAgentRuntimeIdentity(db, randomUUID(), f.companyId, f.agentId)).rejects.toMatchObject({ status: 403 });
    await db.update(agents).set({ lifecycleRequiredPluginIds: [] }).where(eq(agents.id, f.agentId));
    await expect(pluginAgentRuntimeIdentity(db, f.pluginId, f.companyId, f.agentId)).rejects.toMatchObject({ status: 403 });
  });

  it.each(["revision", "plugin-disabled", "company-disabled"] as const)(
    "reads %s after an in-flight lifecycle writer releases the agent lock", async change => {
      const f = await fixture();
      const before = await pluginAgentRuntimeIdentity(db, f.pluginId, f.companyId, f.agentId);
      let release!: () => void, ready!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const locked = new Promise<void>(resolve => { ready = resolve; });
      let writerPid = 0;
      const writing = db.transaction(async tx => {
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        writerPid = backend.pid;
        await tx.update(agents).set({ name: "Updated synthetic runtime" }).where(eq(agents.id, f.agentId));
        if (change === "plugin-disabled") await tx.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, f.pluginId));
        if (change === "company-disabled") await tx.insert(pluginCompanySettings).values({ pluginId: f.pluginId, companyId: f.companyId, enabled: false });
        ready();
        await held;
      });
      await locked;
      const reading = pluginAgentRuntimeIdentity(db, f.pluginId, f.companyId, f.agentId);
      void reading.catch(() => undefined);
      try {
        await vi.waitFor(async () => {
          const [state] = await db.execute<{ waiting: boolean }>(sql`select exists (
            select 1 from pg_stat_activity where ${writerPid} = any(pg_blocking_pids(pid))
          ) as waiting`);
          expect(state.waiting).toBe(true);
        });
      } finally { release(); await writing; }
      if (change !== "revision") await expect(reading).rejects.toMatchObject({ status: 403 });
      else {
        const current = await reading;
        const [latest] = await db.select().from(resourceLifecycleEvents).where(and(eq(resourceLifecycleEvents.companyId, f.companyId),
          eq(resourceLifecycleEvents.resourceType, "agent_runtime"), eq(resourceLifecycleEvents.resourceId, f.agentId))).orderBy(sql`${resourceLifecycleEvents.id} desc`).limit(1);
        expect(current!.revision).not.toBe(before!.revision);
        expect(current!.revision).toBe(String(latest.id));
      }
    },
  );

  it("still resolves rotations and excludes deleted or disabled secret versions", async () => {
    const f = await fixture();
    const service = agentInstanceSecretService(db);
    const request = { companyId: f.companyId, agentId: f.agentId, operationId: f.operationId, version: 1, phase: "preparing" as const };
    await service.apply(request, f.pluginId, { launcher: "synthetic first binding" }, f.owner);
    expect((await pluginAgentRuntimeIdentity(db, f.pluginId, f.companyId, f.agentId))!.instanceSecrets).toEqual({ launcher: "synthetic first binding" });
    await service.apply(request, f.pluginId, { launcher: "synthetic rotated binding" }, f.owner);
    expect((await pluginAgentRuntimeIdentity(db, f.pluginId, f.companyId, f.agentId))!.instanceSecrets).toEqual({ launcher: "synthetic rotated binding" });
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.ownerAgentId, f.agentId));
    await db.update(companySecretVersions).set({ status: "disabled" }).where(and(eq(companySecretVersions.secretId, secret.id), eq(companySecretVersions.version, secret.latestVersion)));
    await expect(pluginAgentRuntimeIdentity(db, f.pluginId, f.companyId, f.agentId)).rejects.toThrow("Agent instance secret unavailable");
    await db.update(companySecrets).set({ status: "deleted" }).where(eq(companySecrets.id, secret.id));
    expect((await pluginAgentRuntimeIdentity(db, f.pluginId, f.companyId, f.agentId))!.instanceSecrets).toEqual({});
  });
});
