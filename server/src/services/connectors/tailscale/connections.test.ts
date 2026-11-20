import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, companySecrets, createDb, tailscaleConnections, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { tailscaleConnectionService } from "./connections.js";
import type { PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";
import { secretService } from "../../secrets.js";
import { createIsolatedTestHome } from "../../../__tests__/helpers/isolated-test-home.js";
import { tailscaleNetworks } from "./network.js";
import { deleteCompany } from "../../company-deletion.js";
import * as tailscaleDevices from "./devices.js";
import { collectEnvironmentSecretRefs } from "../../environment-config.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("durable Tailscale consent state", () => {
  let db: Db;
  let cleanup: () => Promise<void>;
  let companyId: string;
  let clock: Date;
  let isolatedHome: ReturnType<typeof createIsolatedTestHome>;
  let vault: ReturnType<typeof secretService>;
  const running = new Set<string>();
  const connectNetwork = vi.fn<typeof tailscaleNetworks.connect>();
  const disconnectNetwork = vi.fn<typeof tailscaleNetworks.disconnect>();
  const startAuthorization = vi.fn();
  const claim = vi.fn();
  let service: ReturnType<typeof tailscaleConnectionService>;

  beforeAll(async () => {
    isolatedHome = createIsolatedTestHome();
    vi.stubEnv("PAPERCLIP_HOME", isolatedHome.home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "tailscale-consent-fixture");
    vi.stubEnv("PAPERCLIP_SECRETS_PROVIDER", "local_encrypted");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    const started = await startEmbeddedPostgresTestDatabase("tailscale-connections");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
  });
  afterAll(async () => { await cleanup?.(); vi.unstubAllEnvs(); isolatedHome?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    clock = new Date("2020-01-01T00:00:00Z");
    await db.insert(companies).values({ id: companyId, name: "Tailscale fixture", issuePrefix: randomUUID().slice(0, 8).toUpperCase() });
    startAuthorization.mockReset().mockImplementation(async () => ({ authorizationUrl: "https://login.tailscale.com/a/oauth_authorize", expiresAt: new Date(clock.getTime() + 600_000).toISOString() }));
    claim.mockReset().mockRejectedValue(new Error("simulated broker failure"));
    vault = secretService(db);
    running.clear();
    connectNetwork.mockReset().mockImplementation(async input => {
      await input.reload?.();
      running.add(input.identity);
      await input.persist("fixture-enrolled-node-state");
      return "/private/tailscale-fixture/socket";
    });
    disconnectNetwork.mockReset().mockImplementation(async identity => { running.delete(identity); });
    service = tailscaleConnectionService(db, { connector: () => ({ startAuthorization, claim }) as unknown as PaperclipCloudConnector, now: () => clock,
      secrets: vault, networks: { connect: connectNetwork, disconnect: disconnectNetwork } });
  });
  async function start(connectionId?: string) {
    const result = await service.start({ companyId, userId: "fixture-owner", name: "Home tailnet", connectionId, returnUri: "http://localhost:3100/api/tools/oauth/tailscale/callback" });
    const state = startAuthorization.mock.calls.at(-1)![0].returnState as string;
    return { result, state };
  }
  const authorizeCompany = (_: string) => undefined;

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  it.each(["claim", "create", "reload", "connect"] as const)("does not undo disconnect while %s is pending", async phase => {
    const { result, state } = await start();
    const entered = deferred(), release = deferred();
    const grant = { accessToken: "fixture-enrollment-token", accessTokenExpiresAt: new Date(clock.getTime() + 60_000).toISOString() };
    claim.mockResolvedValue(grant);
    const create = vault.createSystemSecret;
    const created = vi.spyOn(vault, "createSystemSecret");
    const removed = vi.spyOn(vault, "remove");
    const pause = async () => { entered.resolve(); await release.promise; };
    if (phase === "claim") claim.mockImplementationOnce(async () => { await pause(); return grant; });
    if (phase === "create") {
      created.mockImplementationOnce(async (...args) => { const secret = await create(...args); await pause(); return secret; });
    }
    if (phase === "reload") {
      const read = vault.resolveSystemSecretValue;
      vi.spyOn(vault, "resolveSystemSecretValue").mockImplementationOnce(async (...args) => { const value = await read(...args); await pause(); return value; });
    }
    if (phase === "connect") {
      const connect = connectNetwork.getMockImplementation()!;
      connectNetwork.mockImplementationOnce(async input => { const socket = await connect(input); await pause(); return socket; });
    }
    const completing = service.complete({ state, userId: "fixture-owner", claimId: "fixture-claim", authorizeCompany });
    const resultAfterCompletion = completing.then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await Promise.race([entered.promise, completing.then(() => { throw new Error("Completion finished before the test pause"); })]);
      await service.disconnect(companyId, result.connection.id);
      expect(running.size).toBe(0);
    } finally { release.resolve(); }
    const completed = await resultAfterCompletion;
    expect(completed.error).toMatchObject({ status: 422, details: { code: "tailscale_authorization_cancelled" } });
    expect((await service.get(companyId, result.connection.id)).status).toBe("disconnected");
    expect(running.size).toBe(0);
    if (phase === "claim") expect(created).not.toHaveBeenCalled();
    for (const call of created.mock.results) {
      if (call.type !== "return") continue;
      const secret = await call.value;
      expect(removed).toHaveBeenCalledWith(secret.id);
      const [stored] = await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id));
      expect(!stored || stored.status === "deleted").toBe(true);
    }
  });

  it.each(["claim", "connect"] as const)("preserves a newer authorization while an older %s finishes", async phase => {
    const { result, state } = await start();
    const entered = deferred(), release = deferred();
    const grant = { accessToken: "fixture-enrollment-token", accessTokenExpiresAt: new Date(clock.getTime() + 60_000).toISOString() };
    claim.mockResolvedValue(grant);
    const created = vi.spyOn(vault, "createSystemSecret");
    const pause = async () => { entered.resolve(); await release.promise; };
    if (phase === "claim") claim.mockImplementationOnce(async () => { await pause(); return grant; });
    if (phase === "connect") {
      const connect = connectNetwork.getMockImplementation()!;
      connectNetwork.mockImplementationOnce(async input => { const socket = await connect(input); await pause(); return socket; });
    }
    const completing = service.complete({ state, userId: "fixture-owner", claimId: "first-claim", authorizeCompany });
    const completed = completing.catch(error => error);
    let newerSecretId: string | null = null;
    try {
      await Promise.race([entered.promise, completing.then(() => { throw new Error("Completion finished before the test pause"); })]);
      const newer = await start(result.connection.id);
      expect(await service.complete({ state: newer.state, userId: "fixture-owner", claimId: "newer-claim", authorizeCompany })).toMatchObject({ status: "connected" });
      newerSecretId = (await service.get(companyId, result.connection.id)).secretId;
      expect([...running]).toEqual([`${companyId}:${newerSecretId}`]);
    } finally { release.resolve(); }
    expect(await completed).toMatchObject({ status: 422, details: { code: "tailscale_authorization_cancelled" } });
    expect(await service.get(companyId, result.connection.id)).toMatchObject({ status: "connected", secretId: newerSecretId });
    expect([...running]).toEqual([`${companyId}:${newerSecretId}`]);
    for (const call of created.mock.results) {
      const secret = await call.value;
      const [stored] = await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id));
      expect(Boolean(stored && stored.status !== "deleted")).toBe(secret.id === newerSecretId);
    }
  });

  it("enrolls once, saves node state, and blocks access after disconnect", async () => {
    const { result, state } = await start();
    claim.mockResolvedValue({ accessToken: "fixture-enrollment-token", accessTokenExpiresAt: new Date(clock.getTime() + 60_000).toISOString() });
    const connected = await service.complete({ state, userId: "fixture-owner", claimId: "fixture-claim", authorizeCompany });
    expect(connected).toEqual({ id: result.connection.id, name: "Home tailnet", companyId, status: "connected" });
    const row = await service.get(companyId, result.connection.id);
    expect(await vault.resolveSystemSecretValue(companyId, row.secretId!, "latest", "tailscale_network", "fixture-network")).toBe("fixture-enrolled-node-state");
    expect(row.oauthExpiresAt).toBeNull();
    await expect(service.complete({ state, userId: "fixture-owner", claimId: "fixture-claim", authorizeCompany })).rejects.toMatchObject({ status: 400 });
    expect(claim).toHaveBeenCalledOnce();
    await service.disconnect(companyId, row.id);
    await expect(service.environmentBinding(companyId, row.id, "fixture-device")).rejects.toMatchObject({ status: 422, details: { code: "tailscale_reauthorization_required" } });
    expect(running.size).toBe(0);
    expect(connectNetwork).toHaveBeenCalledOnce();
  });

  async function enroll() {
    const { result, state } = await start();
    claim.mockResolvedValue({ accessToken: "fixture-enrollment-token", accessTokenExpiresAt: new Date(clock.getTime() + 60_000).toISOString() });
    await service.complete({ state, userId: "fixture-owner", claimId: "fixture-claim", authorizeCompany });
    return service.get(companyId, result.connection.id);
  }

  it("keeps enrolled network state out of generic secret catalogs, bindings, and reads", async () => {
    const row = await enroll();
    expect((await vault.list(companyId)).map(secret => secret.id)).not.toContain(row.secretId);
    await expect(vault.normalizeAdapterConfigForPersistence(companyId, {
      env: { ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretId: row.secretId!, version: "latest" } },
    })).rejects.toMatchObject({ status: 403 });
    await expect(vault.resolveSecretValue(companyId, row.secretId!, "latest")).rejects.toMatchObject({ status: 403 });
  });

  it("binds an SSH environment's private key without projecting its connector credential", async () => {
    const row = await enroll();
    const sshKey = await vault.create(companyId, { name: "SSH private key", provider: "local_encrypted", value: "fixture-ssh-key" });
    const environment = { id: randomUUID(), driver: "ssh" as const, config: {
      host: "100.64.0.2", username: "fixture-user", remoteWorkspacePath: "/workspace", network: "tailscale",
      tailscaleConnectionId: row.id, tailscaleDeviceId: "fixture-device",
      tailscaleAuthKeySecretRef: { type: "secret_ref", secretId: row.secretId!, version: "latest" },
      privateKeySecretRef: { type: "secret_ref", secretId: sshKey.id, version: "latest" },
    } };
    const refs = await collectEnvironmentSecretRefs({ db, environment });
    expect(refs).toEqual([{ secretId: sshKey.id, configPath: "privateKeySecretRef", versionSelector: "latest" }]);
    await expect(vault.syncSecretRefsForTarget(companyId, { targetType: "environment", targetId: environment.id }, refs)).resolves.toHaveLength(1);
  });

  it.each(["disconnected", "replaced"] as const)("keeps %s network credentials server-only", async state => {
    const row = await enroll();
    if (state === "disconnected") await service.disconnect(companyId, row.id);
    else {
      const newer = await start(row.id);
      await service.complete({ state: newer.state, userId: "fixture-owner", claimId: "newer-claim", authorizeCompany });
    }
    expect((await vault.getById(row.secretId!))?.systemPurpose).toBe("tailscale_network");
    expect((await vault.list(companyId)).map(secret => secret.id)).not.toContain(row.secretId);
    await expect(vault.resolveSecretValue(companyId, row.secretId!, "latest")).rejects.toMatchObject({ status: 403 });
  });

  it("backfills existing connector credentials without classifying ordinary company secrets", async () => {
    const row = await enroll();
    await db.update(companySecrets).set({ systemPurpose: null }).where(eq(companySecrets.id, row.secretId!));
    const ordinary = await vault.create(companyId, { name: "Tailscale connection ordinary fixture", provider: "local_encrypted", value: "fixture-ordinary-secret" });
    const migration = await readFile(new URL("../../../../../packages/db/src/migrations/0482_aberrant_rumiko_fujikawa.sql", import.meta.url), "utf8");
    await db.execute(sql.raw(migration.split("--> statement-breakpoint")[1]!));
    expect((await vault.getById(row.secretId!))?.systemPurpose).toBe("tailscale_network");
    expect((await vault.getById(ordinary.id))?.systemPurpose).toBeNull();
    await expect(vault.resolveSecretValue(companyId, row.secretId!, "latest")).rejects.toMatchObject({ status: 403 });
    expect(await vault.resolveSecretValue(companyId, ordinary.id, "latest")).toBe("fixture-ordinary-secret");
  });

  it.each(["starting", "ready"] as const)("does not stop a %s retry when an older network request fails", async phase => {
    const row = await enroll();
    const identity = `${companyId}:${row.secretId}`;
    const failedClosed = deferred(), rejectFailed = deferred(), retryStarted = deferred(), finishRetry = deferred();
    const devices = vi.spyOn(tailscaleDevices, "readTailscaleDevices").mockResolvedValue([
      { id: "fixture-device", name: "Workstation", hostname: "workstation.example.test", os: "linux", address: "100.64.0.2", online: true },
    ]);
    disconnectNetwork.mockClear();
    connectNetwork.mockImplementationOnce(async input => {
      running.delete(input.identity);
      failedClosed.resolve();
      await rejectFailed.promise;
      throw new Error("fixture failed network client");
    }).mockImplementationOnce(async input => {
      await input.reload!();
      running.add(input.identity);
      retryStarted.resolve();
      if (phase === "starting") await finishRetry.promise;
      return "/private/tailscale-retry/socket";
    });
    const failed = service.environmentBinding(companyId, row.id, "fixture-device", row.secretId!);
    const failure = failed.catch(error => error);
    let retry: ReturnType<typeof service.environmentBinding> | undefined;
    try {
      await Promise.race([failedClosed.promise, failed]);
      retry = service.environmentBinding(companyId, row.id, "fixture-device", row.secretId!);
      await Promise.race([retryStarted.promise, retry]);
      if (phase === "ready") await retry;
      rejectFailed.resolve();
      expect(await failure).toMatchObject({ message: "fixture failed network client" });
      expect([...running]).toEqual([identity]);
      expect(disconnectNetwork).not.toHaveBeenCalled();
      finishRetry.resolve();
      expect(await retry).toMatchObject({ socket: "/private/tailscale-retry/socket", secretId: row.secretId });
    } finally {
      rejectFailed.resolve(); finishRetry.resolve();
      await Promise.allSettled([failure, retry]);
      devices.mockRestore();
    }
  });

  async function otherConnection() {
    const otherId = randomUUID();
    await db.insert(companies).values({ id: otherId, name: "Other tenant", issuePrefix: randomUUID().slice(0, 8).toUpperCase() });
    const secret = await vault.create(otherId, { name: "Other network", provider: "local_encrypted", value: "fixture-other-node" });
    const [connection] = await db.insert(tailscaleConnections).values({ companyId: otherId, name: "Other network", status: "connected", secretId: secret.id, createdByUserId: "fixture-owner" }).returning();
    running.add(`${otherId}:${secret.id}`);
    return { companyId: otherId, secret, connection: connection! };
  }

  it.each(["connected", "disconnected"] as const)("deletes a company with a %s Tailscale connector and stops only its daemon", async status => {
    const row = await enroll();
    const persist = connectNetwork.mock.calls.at(-1)![0].persist;
    if (status === "disconnected") await service.disconnect(companyId, row.id);
    const other = await otherConnection();
    const stop = vi.spyOn(tailscaleNetworks, "disconnect").mockImplementation(async identity => {
      expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
      await persist("fixture-late-node-state");
      running.delete(identity);
    });
    try {
      expect(await deleteCompany(db, companyId)).toMatchObject({ id: companyId });
      expect(stop).toHaveBeenCalledWith(`${companyId}:${row.secretId}`, { discardState: true });
      expect(await db.select().from(tailscaleConnections).where(eq(tailscaleConnections.companyId, companyId))).toHaveLength(0);
      expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toHaveLength(0);
      expect(await db.select().from(tailscaleConnections).where(eq(tailscaleConnections.id, other.connection.id))).toEqual([other.connection]);
      expect([...running]).toEqual([`${other.companyId}:${other.secret.id}`]);
    } finally { stop.mockRestore(); }
  });

  it.each(["connected", "disconnected"] as const)("deletes a %s connector secret after stopping and detaching its network", async status => {
    const row = await enroll();
    const persist = connectNetwork.mock.calls.at(-1)![0].persist;
    if (status === "disconnected") await service.disconnect(companyId, row.id);
    const other = await otherConnection();
    const stop = vi.spyOn(tailscaleNetworks, "disconnect").mockImplementation(async identity => {
      expect((await service.get(companyId, row.id)).status).toBe("disconnected");
      await persist("fixture-late-node-state");
      running.delete(identity);
    });
    try {
      expect(await vault.remove(row.secretId!)).toMatchObject({ id: row.secretId });
      expect(stop).toHaveBeenCalledWith(`${companyId}:${row.secretId}`, { discardState: true });
      expect(await service.get(companyId, row.id)).toMatchObject({ status: "disconnected", secretId: null,
        credentialVersion: null, credentialHash: null, oauthStateHash: null, oauthExpiresAt: null });
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, row.secretId!))).toHaveLength(0);
      expect(await db.select().from(tailscaleConnections).where(eq(tailscaleConnections.id, other.connection.id))).toEqual([other.connection]);
      expect([...running]).toEqual([`${other.companyId}:${other.secret.id}`]);
    } finally { stop.mockRestore(); }
  });

  it("keeps the connector reference retryable when daemon shutdown fails during secret deletion", async () => {
    const row = await enroll();
    const stop = vi.spyOn(tailscaleNetworks, "disconnect").mockRejectedValueOnce(new Error("fixture shutdown failed"))
      .mockImplementation(async identity => { running.delete(identity); });
    try {
      await expect(vault.remove(row.secretId!)).rejects.toThrow("fixture shutdown failed");
      expect(await service.get(companyId, row.id)).toMatchObject({ status: "disconnected", secretId: row.secretId });
      expect(await vault.remove(row.secretId!)).toMatchObject({ id: row.secretId });
      expect(stop).toHaveBeenCalledTimes(2);
      expect((await service.get(companyId, row.id)).secretId).toBeNull();
      expect(running.size).toBe(0);
    } finally { stop.mockRestore(); }
  });

  it("does not stop a company's daemon when its deletion transaction rolls back", async () => {
    const row = await enroll();
    const transaction = db.transaction.bind(db);
    const rollback = vi.spyOn(db, "transaction").mockImplementation(callback => transaction(async tx => {
      await callback(tx);
      throw new Error("fixture deletion rollback");
    }));
    const stop = vi.spyOn(tailscaleNetworks, "disconnect");
    try {
      await expect(deleteCompany(db, companyId)).rejects.toThrow("fixture deletion rollback");
      expect(stop).not.toHaveBeenCalled();
      expect(await service.get(companyId, row.id)).toEqual(row);
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, row.secretId!))).toHaveLength(1);
      expect([...running]).toEqual([`${companyId}:${row.secretId}`]);
    } finally { rollback.mockRestore(); stop.mockRestore(); }
  });

  it("can remove a connector secret through a transactional secret client", async () => {
    const row = await enroll();
    const stop = vi.spyOn(tailscaleNetworks, "disconnect").mockImplementation(async (identity, options) => {
      expect(options).toEqual({ discardState: true });
      running.delete(identity);
    });
    try {
      expect(await db.transaction(tx => secretService(tx).remove(row.secretId!))).toMatchObject({ id: row.secretId });
      expect((await service.get(companyId, row.id)).secretId).toBeNull();
      expect(running.size).toBe(0);
    } finally { stop.mockRestore(); }
  });

  it.each(["company", "secret"] as const)("cancels an in-flight authorization when its %s is deleted", async target => {
    const row = await enroll();
    const pending = await start(row.id);
    const entered = deferred(), release = deferred();
    claim.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
      return { accessToken: "fixture-delayed-token", accessTokenExpiresAt: new Date(clock.getTime() + 60_000).toISOString() };
    });
    const completing = service.complete({ state: pending.state, userId: "fixture-owner", claimId: "delayed-claim", authorizeCompany });
    const outcome = completing.catch(error => error);
    const stop = vi.spyOn(tailscaleNetworks, "disconnect").mockImplementation(async identity => { running.delete(identity); });
    try {
      await Promise.race([entered.promise, completing.then(() => { throw new Error("Claim completed before test pause"); })]);
      if (target === "company") await deleteCompany(db, companyId);
      else await vault.remove(row.secretId!);
      release.resolve();
      expect(await outcome).toMatchObject({ status: 422, details: { code: "tailscale_authorization_cancelled" } });
      expect(running.size).toBe(0);
      expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toHaveLength(0);
    } finally { release.resolve(); await outcome; stop.mockRestore(); }
  });

  it("does not adopt an ordinary member's rotation of a connector secret", async () => {
    const row = await enroll();
    await vault.rotate(row.secretId!, { value: "tskey-auth-member-chosen-tailnet" }, { userId: "fixture-member" });
    const devices = vi.spyOn(tailscaleDevices, "readTailscaleDevices").mockResolvedValue([{ id: "fixture-device", name: "Workstation", hostname: "workstation.example.test", os: "linux", address: "100.64.0.2", online: true }]);
    connectNetwork.mockImplementationOnce(async input => {
      expect(input.credential).toBe("fixture-enrolled-node-state");
      expect(await input.reload!()).toBe("fixture-enrolled-node-state");
      return "/private/tailscale-fixture/socket";
    });
    try { await expect(service.environmentBinding(companyId, row.id, "fixture-device")).resolves.toMatchObject({ host: "100.64.0.2" }); }
    finally { devices.mockRestore(); }
  });

  it("pins the enrollment credential even if a member rotates it before installation", async () => {
    const create = vault.createSystemSecret;
    const created = vi.spyOn(vault, "createSystemSecret").mockImplementationOnce(async (...args) => {
      const secret = await create(...args);
      await vault.rotate(secret.id, { value: "tskey-auth-member-chosen-tailnet" }, { userId: "fixture-member" });
      return secret;
    });
    connectNetwork.mockImplementationOnce(async input => {
      expect(input.credential).toBe("fixture-enrollment-token");
      expect(await input.reload!()).toBe("fixture-enrollment-token");
      await input.persist("fixture-enrolled-node-state");
      return "/private/tailscale-fixture/socket";
    });
    try {
      const row = await enroll();
      expect(row.credentialVersion).toBe(3);
      expect(row.credentialHash).toMatch(/^[a-f0-9]{64}$/);
    } finally { created.mockRestore(); }
  });

  it("rejects unpinned or tampered connector credentials before starting a daemon", async () => {
    const row = await enroll();
    const devices = vi.spyOn(tailscaleDevices, "readTailscaleDevices").mockResolvedValue([]);
    const calls = connectNetwork.mock.calls.length;
    const read = vi.spyOn(vault, "resolveSystemSecretValue").mockResolvedValueOnce("tskey-auth-member-chosen-tailnet");
    try {
      await expect(service.environmentBinding(companyId, row.id, "fixture-device")).rejects.toMatchObject({ status: 422, details: { code: "tailscale_credential_untrusted" } });
      expect(connectNetwork).toHaveBeenCalledTimes(calls);
      read.mockRestore();
      await db.update(tailscaleConnections).set({ credentialVersion: null, credentialHash: null }).where(eq(tailscaleConnections.id, row.id));
      await expect(service.environmentBinding(companyId, row.id, "fixture-device")).rejects.toMatchObject({ status: 422, details: { code: "tailscale_credential_untrusted" } });
      expect(connectNetwork).toHaveBeenCalledTimes(calls);
      expect(devices).not.toHaveBeenCalled();
    } finally { read.mockRestore(); devices.mockRestore(); }
  });

  it("keeps the last trusted state readable while a new trusted version is being saved", async () => {
    const row = await enroll();
    const input = connectNetwork.mock.calls[0]![0];
    const entered = deferred(), release = deferred();
    const rotate = vault.rotate;
    const rotating = vi.spyOn(vault, "rotate").mockImplementationOnce(async (...args) => {
      const value = await rotate(...args); entered.resolve(); await release.promise; return value;
    });
    const saving = input.persist("fixture-next-node-state");
    const settled = saving.catch(() => undefined);
    try {
      await entered.promise;
      expect(await input.reload!()).toBe("fixture-enrolled-node-state");
      await input.persist("fixture-newer-node-state");
      expect(await input.reload!()).toBe("fixture-newer-node-state");
      release.resolve();
      await saving;
      expect(await input.reload!()).toBe("fixture-newer-node-state");
    } finally { release.resolve(); await settled; rotating.mockRestore(); }
  });

  it("closes the old network client when replacing a connected authorization", async () => {
    const { result, state } = await start();
    claim.mockResolvedValue({ accessToken: "fixture-enrollment-token", accessTokenExpiresAt: new Date(clock.getTime() + 60_000).toISOString() });
    await service.complete({ state, userId: "fixture-owner", claimId: "first-claim", authorizeCompany });
    const previous = await service.get(companyId, result.connection.id);
    const next = await start(previous.id);
    expect(next.result.connection.status).toBe("connected");
    expect([...running]).toEqual([`${companyId}:${previous.secretId}`]);
    await service.complete({ state: next.state, userId: "fixture-owner", claimId: "next-claim", authorizeCompany });
    const current = await service.get(companyId, previous.id);
    expect(current.secretId).not.toBe(previous.secretId);
    expect(disconnectNetwork).toHaveBeenCalledWith(`${companyId}:${previous.secretId}`);
    expect([...running]).toEqual([`${companyId}:${current.secretId}`]);
    await service.disconnect(companyId, current.id);
    expect(running.size).toBe(0);
  });

  it.each([
    ["disconnected", "credential read"], ["replaced", "credential read"],
    ["disconnected", "device discovery"], ["replaced", "device discovery"],
  ] as const)("rejects runtime access %s during %s", async (state, phase) => {
    const { result, state: consentState } = await start();
    claim.mockResolvedValue({ accessToken: "fixture-enrollment-token", accessTokenExpiresAt: new Date(clock.getTime() + 60_000).toISOString() });
    await service.complete({ state: consentState, userId: "fixture-owner", claimId: "first-claim", authorizeCompany });
    const original = await service.get(companyId, result.connection.id);
    const entered = deferred(), release = deferred();
    const inventory = [{ id: "fixture-device", name: "Fixture", hostname: "fixture.example.test", address: "100.64.0.2", os: "linux", online: true }];
    const devices = vi.spyOn(tailscaleDevices, "readTailscaleDevices").mockResolvedValue(inventory);
    expect(await service.environmentBinding(companyId, original.id, "fixture-device", original.secretId!)).toEqual({
      host: "100.64.0.2", secretId: original.secretId, socket: "/private/tailscale-fixture/socket",
    });
    const read = vault.resolveSystemSecretValue;
    const credential = vi.spyOn(vault, "resolveSystemSecretValue");
    if (phase === "credential read") credential.mockImplementationOnce(async (...args) => {
      const value = await read(...args); entered.resolve(); await release.promise; return value;
    });
    else devices.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return inventory; });
    const resolving = service.environmentBinding(companyId, original.id, "fixture-device", original.secretId!);
    const outcome = resolving.then(value => ({ value, error: null }), error => ({ value: null, error }));
    let activeSecretId: string | null = null;
    try {
      await Promise.race([entered.promise, resolving.then(() => { throw new Error("Runtime resolved before device discovery"); })]);
      if (state === "disconnected") await service.disconnect(companyId, original.id);
      else {
        const newer = await start(original.id);
        await service.complete({ state: newer.state, userId: "fixture-owner", claimId: "newer-claim", authorizeCompany });
        activeSecretId = (await service.get(companyId, original.id)).secretId;
      }
    } finally { release.resolve(); }
    try {
      expect((await outcome).error).toMatchObject({ status: 422, details: { code: "tailscale_reauthorization_required" } });
      expect([...running]).toEqual(activeSecretId ? [`${companyId}:${activeSecretId}`] : []);
      const calls = connectNetwork.mock.calls.length;
      await expect(service.environmentBinding(companyId, original.id, "fixture-device", original.secretId!)).rejects.toMatchObject({ status: 422 });
      expect(connectNetwork).toHaveBeenCalledTimes(calls);
    } finally { devices.mockRestore(); credential.mockRestore(); }
  });

  it("removes failed enrollment credentials even when daemon cleanup reports an error", async () => {
    const { result, state } = await start();
    claim.mockResolvedValue({ accessToken: "fixture-enrollment-token", accessTokenExpiresAt: new Date(clock.getTime() + 60_000).toISOString() });
    const created = vi.spyOn(vault, "createSystemSecret");
    connectNetwork.mockRejectedValueOnce(new Error("startup failed"));
    disconnectNetwork.mockRejectedValueOnce(new Error("shutdown state save failed"));
    await expect(service.complete({ state, userId: "fixture-owner", claimId: "fixture-claim", authorizeCompany })).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "startup failed" }), expect.objectContaining({ message: "shutdown state save failed" })],
    });
    expect(await service.get(companyId, result.connection.id)).toMatchObject({ status: "disconnected", secretId: null });
    const secret = await created.mock.results[0]!.value;
    const [stored] = await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id));
    expect(!stored || stored.status === "deleted").toBe(true);
    expect(running.size).toBe(0);
    await expect(service.complete({ state, userId: "fixture-owner", claimId: "fixture-claim", authorizeCompany })).rejects.toMatchObject({ status: 400 });
  });

  it("binds OAuth to a company and user and stores only a digest of browser state", async () => {
    const { result, state } = await start();
    expect(startAuthorization).toHaveBeenCalledWith(expect.objectContaining({ subject: "fixture-owner", companyId, profile: "tailscale.tailnet", returnState: state }));
    const [stored] = await db.select().from(tailscaleConnections).where(eq(tailscaleConnections.id, result.connection.id));
    expect(stored!.oauthStateHash).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain(state);
    expect(await service.list(companyId)).toEqual([expect.objectContaining({ id: result.connection.id, name: "Home tailnet", status: "pending" })]);
    expect(JSON.stringify(await service.list(companyId))).not.toContain("oauthStateHash");
    await expect(service.get(randomUUID(), result.connection.id)).rejects.toMatchObject({ status: 404 });
  });
  it("rejects another user without consuming the owner's state", async () => {
    const { result, state } = await start();
    await expect(service.complete({ state, userId: "another-user", claimId: "fixture-claim", authorizeCompany })).rejects.toMatchObject({ status: 400 });
    expect((await service.get(companyId, result.connection.id)).oauthStateHash).toBeTruthy();
    expect(claim).not.toHaveBeenCalled();
  });
  it("rejects expired consent before contacting the broker", async () => {
    const { state } = await start();
    clock = new Date(clock.getTime() + 11 * 60_000);
    await expect(service.complete({ state, userId: "fixture-owner", claimId: "fixture-claim", authorizeCompany })).rejects.toMatchObject({ status: 400 });
    expect(claim).not.toHaveBeenCalled();
  });
  it("consumes a denial once and never exchanges credentials", async () => {
    const { result, state } = await start();
    const authorize = vi.fn(authorizeCompany);
    await expect(service.complete({ state, userId: "fixture-owner", error: "authorization_denied", authorizeCompany: authorize })).rejects.toMatchObject({ status: 400 });
    expect(authorize).toHaveBeenCalledExactlyOnceWith(companyId, result.connection.id);
    await expect(service.complete({ state, userId: "fixture-owner", claimId: "fixture-claim", authorizeCompany })).rejects.toMatchObject({ status: 400 });
    expect(claim).not.toHaveBeenCalled();
  });
  it("rechecks current company authorization before exchanging credentials", async () => {
    const { state } = await start();
    await expect(service.complete({ state, userId: "fixture-owner", claimId: "fixture-claim", authorizeCompany: () => { throw new Error("membership revoked"); } })).rejects.toThrow("membership revoked");
    expect(claim).not.toHaveBeenCalled();
  });
  it("disconnect invalidates a pending callback", async () => {
    const { result, state } = await start();
    expect(await service.disconnect(companyId, result.connection.id)).toMatchObject({ status: "disconnected" });
    await expect(service.complete({ state, userId: "fixture-owner", claimId: "fixture-claim", authorizeCompany })).rejects.toMatchObject({ status: 400 });
    expect(claim).not.toHaveBeenCalled();
  });
  it("allows only one competing callback to attempt redemption", async () => {
    const { state } = await start();
    await Promise.allSettled([1, 2].map(() => service.complete({ state, userId: "fixture-owner", claimId: "fixture-claim", authorizeCompany })));
    expect(claim).toHaveBeenCalledOnce();
  });
});
