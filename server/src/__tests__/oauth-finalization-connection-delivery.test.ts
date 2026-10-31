import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, authUsers, companyMemberships, companySecrets, connectionGrants, connectionIntentDeliveries, createDb, databaseWorkPending, issueThreadInteractions, toolConnectionInstalls, toolConnections, toolProfiles, userSecretDefinitions } from "@paperclipai/db";
import type { FinishConnectionSetup } from "../services/tool-access/catalog/contracts.js";
import { toConnection } from "../services/tool-access/connections/projection.js";
import { toProfile } from "../services/tool-access/profiles/projection.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { createOAuthAccessFinalization } from "../services/tool-access/oauth/access-finalization.js";
import { secretService } from "../services/secrets.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("OAuth finalization wakes connection delivery from its own writes", () => {
  const modes = ["personal", "organization insert", "organization update", "install"] as const;
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-finalization-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  async function arrange(mode = "personal") {
    const f = await seedPendingAccessRequest(db, "owner");
    await db.update(toolProfiles).set({ defaultAction: "allow" });
    await db.update(toolConnections).set({ authKind: "oauth", status: "draft", enabled: false });
    const ref = { secretId: randomUUID(), configPath: "oauth.access_token", versionSelector: "latest" as const };
    await db.update(connectionGrants).set({ credentialSecretRefs: [ref] });
    if (mode.startsWith("organization")) {
      await db.update(connectionGrants).set({ subjectUserId: "promoter" });
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "promoter", status: "active", membershipRole: "member" });
      const [definition] = await db.insert(userSecretDefinitions).values({ companyId: f.companyId, key: "oauth", name: "OAuth" }).returning();
      await db.insert(companySecrets).values({ id: ref.secretId, companyId: f.companyId, key: "oauth", name: "OAuth", scope: "user", ownerUserId: "promoter", userSecretDefinitionId: definition.id });
      if (mode === "organization update") await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.connection.id, kind: "organization", isDefault: true, status: "revoked" });
    }
    if (mode === "install") {
      await db.update(toolConnections).set({ status: "active", enabled: true, credentialPolicy: "shared", credentialSecretRefs: [ref] });
      await db.delete(toolConnectionInstalls);
      await db.update(issueThreadInteractions).set({ payload: { ...f.intent.payload, accessRequest: undefined } });
    }
    return f;
  }
  const stopSetup: FinishConnectionSetup = async () => { throw new Error("stop before later setup writes"); };
  const finishSetup: FinishConnectionSetup = async () => ({ connection: toConnection((await db.select().from(toolConnections))[0]),
    profile: toProfile((await db.select().from(toolProfiles))[0]), profileEntries: [], profileBindings: [], policies: [] });
  function producer(client = db, finish = stopSetup) {
    return createOAuthAccessFinalization(client, {
      getConnectionRow: id => client.select().from(toolConnections).where(eq(toolConnections.id, id)).then(rows => rows[0]!),
      secrets: { ...secretService(client), remove: vi.fn(), resolveUserSecretValue: async () => ({ value: "fixture-token", manifestEntry: {
        configPath: "oauth.access_token", envKey: null, secretId: randomUUID(), secretKey: "oauth", version: 1, provider: "local_encrypted", outcome: "success",
      } }) },
      store: { createOrRotateOAuthSecret: async input => ({ secretId: randomUUID(), configPath: input.configPath, versionSelector: "latest" }), syncCredentialBindings: vi.fn().mockResolvedValue(undefined) },
      assertAgentsInCompany: vi.fn().mockResolvedValue(undefined),
      finishGalleryAppConnection: finish,
    });
  }
  async function produce(f: Awaited<ReturnType<typeof arrange>>, mode = "personal", client = db) {
    const result = producer(client, mode === "install" ? finishSetup : stopSetup)(f.companyId, f.connection.id,
      { grantKind: mode === "personal" ? "user" : "organization" }, { actorType: "user", actorId: mode.startsWith("organization") ? "promoter" : "owner" });
    if (mode === "install") await result;
    else await expect(result).rejects.toThrow("stop before later setup writes");
  }
  async function effects(retired: boolean) {
    expect((await db.select().from(issueThreadInteractions))[0].status).toBe(retired ? "expired" : "pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(retired ? 1 : 0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(retired ? 1 : 0);
    expect(delivery!.wakeup).toHaveBeenCalledTimes(retired ? 1 : 0);
  }

  it.each(modes)("retires from its own %s transaction", async mode => {
    const f = await arrange(mode);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await produce(f, mode);
    await delivery.settle(baseline + 1);
    await effects(true);
    expect((await db.select().from(issueThreadInteractions))[0].result).toMatchObject({ connectionId: f.connection.id });
  });

  it.each(["personal", "organization insert", "organization update", "late install"])("registers before the blocked %s write", async mode => {
    const late = mode === "late install";
    const f = await arrange(late ? "personal" : mode);
    if (late) {
      await db.delete(toolConnectionInstalls);
      await db.update(issueThreadInteractions).set({ payload: { ...f.intent.payload, accessRequest: undefined } });
    }
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const lock = await db.$client.reserve();
    await lock`begin`;
    const table = late ? "tool_connection_installs" : mode === "personal" ? "tool_connections" : "connection_grants";
    await lock.unsafe(`lock table ${table} in ${late ? "exclusive" : "share"} mode`);
    const completion = late ? producer(db, async (...args) => {
      await delivery!.settle(baseline + 1);
      await effects(false);
      return finishSetup(...args);
    })(f.companyId, f.connection.id, { grantKind: "user" }, { actorType: "user", actorId: "owner" }) : produce(f, mode);
    void completion.catch(() => undefined);
    try {
      await vi.waitFor(async () => expect(await db.execute(sql`select 1 from pg_locks where relation = ${table}::regclass and not granted`)).toHaveLength(1));
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      await effects(false);
    } finally {
      await lock`rollback`;
      lock.release();
      await completion;
    }
    await delivery.settle(baseline + (late ? 2 : 1));
    await effects(true);
  });

  it.each(modes.flatMap(mode => [[mode, false], [mode, true]] as const))(
    "%s waits for its outer transaction (rollback=%s)", async (mode, rollback) => {
      const f = await arrange(mode);
      delivery = await startConnectionDelivery(db);
      const baseline = delivery.sweeps;
      const transaction = db.transaction(async tx => {
        await produce(f, mode, tx as unknown as typeof db);
        expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
        await effects(false);
        expect(delivery!.sweeps).toBe(baseline);
        if (rollback) throw new Error("rollback");
      });
      if (rollback) await expect(transaction).rejects.toThrow("rollback");
      else await transaction;
      await delivery.settle(baseline + 1);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(false);
      await effects(!rollback);
      expect((await db.select().from(toolConnections))[0].status).toBe(rollback && mode !== "install" ? "draft" : "active");
    });

  it.each(modes)("raw %s writes do not wake the idle worker", async mode => {
    const f = await arrange(mode);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    if (mode === "install") await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: f.connection.id, targetType: "agent", targetId: f.agentId });
    else await db.update(toolConnections).set({ status: "active", enabled: true, credentialPolicy: mode === "personal" ? "per_user" : "shared" });
    if (mode === "organization insert") await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.connection.id, kind: "organization", status: "active" });
    if (mode === "organization update") await db.update(connectionGrants).set({ status: "active" });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(delivery.sweeps).toBe(baseline);
    await effects(false);
    delivery.wake();
    await delivery.settle(baseline + 1);
    await effects(true);
  });

  it.each(modes.flatMap(mode => [[mode, false], [mode, true]] as const))("reconciles %s during a sweep (revoke=%s)", async (mode, revoke) => {
    const f = await arrange(mode);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let hold = false;
    delivery = await startConnectionDelivery(db, { beforeSweep: async () => {
      if (hold) { hold = false; entered.resolve(); await release.promise; }
    } });
    const baseline = delivery.sweeps;
    hold = true;
    delivery.wake();
    try {
      await entered.promise;
      await produce(f, mode);
      if (revoke) await db.update(connectionGrants).set({ status: "revoked" });
    } finally { release.resolve(); }
    await delivery.settle(baseline + 2);
    await effects(!revoke);
  });

  it.each(modes)("retains %s during drain and coalesces duplicate finalizations", async mode => {
    const f = await arrange(mode);
    let canRun = true;
    delivery = await startConnectionDelivery(db, { canRun: () => canRun });
    const baseline = delivery.sweeps;
    canRun = false;
    await Promise.all([produce(f, mode), produce(f, mode)]);
    await delivery.settle();
    expect(delivery.sweeps).toBe(baseline);
    await effects(false);
    canRun = true;
    delivery.wake();
    await delivery.settle(baseline + 1);
    await effects(true);
  });

  it.each([...modes.flatMap(mode => ["blocked", "changed tool"].map(gap => [mode, gap] as const)), ["organization insert", "ambiguous identity"] as const])("%s does not retire %s access", async (mode, gap) => {
    const f = await arrange(mode);
    if (gap === "blocked") await db.update(toolProfiles).set({ defaultAction: "deny" });
    if (gap === "changed tool") await db.update(issueThreadInteractions).set({ payload: { ...f.intent.payload,
      accessRequest: { connectionId: f.connection.id, tools: [{ catalogEntryId: f.tool.id, toolName: "different-tool", versionHash: "v1", permission: "allowed" }] } } });
    if (gap === "ambiguous identity") await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.connection.id, kind: "organization", status: "active" });
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await produce(f, mode);
    await delivery.settle(baseline + 1);
    await effects(false);
  });
});
