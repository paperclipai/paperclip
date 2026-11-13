import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, companySecrets, createDb, tailscaleConnections, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { tailscaleConnectionService } from "./tailscale-connections.js";
import type { PaperclipCloudConnector } from "./paperclip-cloud-connector.js";
import { secretService } from "./secrets.js";
import { createIsolatedTestHome } from "../__tests__/helpers/isolated-test-home.js";
import type { tailscaleNetworks } from "./tailscale-network.js";
import * as tailscaleDevices from "./tailscale-devices.js";

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
    const create = vault.create;
    const created = vi.spyOn(vault, "create");
    const removed = vi.spyOn(vault, "remove");
    const pause = async () => { entered.resolve(); await release.promise; };
    if (phase === "claim") claim.mockImplementationOnce(async () => { await pause(); return grant; });
    if (phase === "create") {
      created.mockImplementationOnce(async (...args) => { const secret = await create(...args); await pause(); return secret; });
    }
    if (phase === "reload") {
      const read = vault.resolveSecretValue;
      vi.spyOn(vault, "resolveSecretValue").mockImplementationOnce(async (...args) => { const value = await read(...args); await pause(); return value; });
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
    const created = vi.spyOn(vault, "create");
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
    expect(await vault.resolveSecretValue(companyId, row.secretId!, "latest")).toBe("fixture-enrolled-node-state");
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
    const create = vault.create;
    const created = vi.spyOn(vault, "create").mockImplementationOnce(async (...args) => {
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
    const read = vi.spyOn(vault, "resolveSecretValue").mockResolvedValueOnce("tskey-auth-member-chosen-tailnet");
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
    const read = vault.resolveSecretValue;
    const credential = vi.spyOn(vault, "resolveSecretValue");
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
    const created = vi.spyOn(vault, "create");
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
    const { state } = await start();
    await expect(service.complete({ state, userId: "fixture-owner", error: "authorization_denied", authorizeCompany })).rejects.toMatchObject({ status: 400 });
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
