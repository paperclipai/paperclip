import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, tailscaleConnections, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createIsolatedTestHome } from "../../../__tests__/helpers/isolated-test-home.js";
import { secretService } from "../../secrets.js";
import { tailscaleDeviceLoginService } from "./device-login.js";
import { tailscaleConnectionService } from "./connections.js";
import { tailscaleNetworks } from "./network.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("durable device sign-in", () => {
  let db: Db;
  let cleanup: () => Promise<void>;
  let home: ReturnType<typeof createIsolatedTestHome>;
  let companyId: string;
  let now: Date;
  let vault: ReturnType<typeof secretService>;
  let service: ReturnType<typeof tailscaleDeviceLoginService>;
  const connect = vi.fn<typeof tailscaleNetworks.connect>();
  const disconnect = vi.fn<typeof tailscaleNetworks.disconnect>();
  const loginStatus = vi.fn<typeof tailscaleNetworks.loginStatus>();
  const state = (machine: string) => "paperclip-tailscale-state-v1:" + Buffer.from(JSON.stringify({ MachineKey: machine })).toString("base64");
  beforeAll(async () => {
    home = createIsolatedTestHome();
    vi.stubEnv("PAPERCLIP_HOME", home.home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "tailscale-device-login-fixture");
    vi.stubEnv("PAPERCLIP_SECRETS_PROVIDER", "local_encrypted");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "b".repeat(64));
    const started = await startEmbeddedPostgresTestDatabase("tailscale-device-login");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
  });
  afterAll(async () => { await cleanup?.(); vi.unstubAllEnvs(); home?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Device login fixture", issuePrefix: randomUUID().slice(0, 8).toUpperCase() });
    vault = secretService(db);
    connect.mockReset().mockImplementation(async input => { await input.reload?.(); await input.persist(state(input.identity)); return "/private/tailscale-fixture/socket"; });
    disconnect.mockReset().mockResolvedValue(undefined);
    loginStatus.mockReset().mockResolvedValue({ status: "authorizing", authorizationUrl: "https://login.tailscale.com/a/fixture" });
    service = tailscaleDeviceLoginService(db, { secrets: vault, networks: { connect, disconnect, loginStatus }, now: () => now });
  });
  const start = () => service.start({ companyId, userId: "fixture-user", name: "Home" });
  async function row(id: string) { return (await db.select().from(tailscaleConnections).where(eq(tailscaleConnections.id, id)))[0]!; }

  it("stores device state without an OAuth app and completes only after the daemon confirms consent", async () => {
    const result = await start();
    expect(result).toMatchObject({ connection: { companyId, status: "authorizing" }, authorizationUrl: "https://login.tailscale.com/a/fixture" });
    expect(JSON.stringify(result)).not.toContain("MachineKey");
    const saved = await row(result.connection.id);
    const input = connect.mock.calls[0]![0];
    expect(await vault.resolveSystemSecretValue(companyId, saved.secretId!, saved.credentialVersion!, "tailscale_network", "fixture")).toBe(state(input.identity));
    await input.login!.onAuthorized();
    expect(await service.resume(companyId, saved.id, "fixture-user")).toMatchObject({ connection: { status: "connected" }, expiresAt: null });
    expect(await row(saved.id)).toMatchObject({ secretId: saved.secretId, oauthExpiresAt: null, status: "connected" });
  });

  it("resumes an interrupted sign-in with the same encrypted state and deadline", async () => {
    const first = await start();
    const saved = await row(first.connection.id);
    const resumedService = tailscaleDeviceLoginService(db, { secrets: vault, networks: { connect, disconnect, loginStatus }, now: () => now });
    const resumed = await resumedService.resume(companyId, saved.id, "fixture-user");
    expect(resumed.expiresAt).toBe(first.expiresAt);
    expect(connect.mock.calls[1]![0].credential).toBe(state(connect.mock.calls[0]![0].identity));
    expect((await row(saved.id)).secretId).toBe(saved.secretId);
  });

  it("keeps independent companies and sign-in initiators isolated", async () => {
    const first = await start();
    await expect(service.resume(randomUUID(), first.connection.id, "fixture-user")).rejects.toMatchObject({ status: 404 });
    await expect(service.resume(companyId, first.connection.id, "other-user")).rejects.toMatchObject({ status: 403 });
    const secondCompany = randomUUID();
    await db.insert(companies).values({ id: secondCompany, name: "Separate tailnet", issuePrefix: randomUUID().slice(0, 8).toUpperCase() });
    const second = await service.start({ companyId: secondCompany, userId: "other-user", name: "Work" });
    expect(connect.mock.calls[0]![0].identity).not.toBe(connect.mock.calls[1]![0].identity);
    expect((await row(first.connection.id)).secretId).not.toBe((await row(second.connection.id)).secretId);
  });

  it("does not revive a disconnected or replaced sign-in when an old daemon finishes", async () => {
    const first = await start();
    const old = connect.mock.calls[0]![0];
    const connections = tailscaleConnectionService(db, { secrets: vault, networks: { connect, disconnect } });
    await connections.disconnect(companyId, first.connection.id);
    await expect(old.login!.onAuthorized()).rejects.toMatchObject({ status: 422 });
    const before = await row(first.connection.id);
    await old.persist(state("stale"));
    expect((await row(first.connection.id)).credentialVersion).toBe(before.credentialVersion);
    const replacement = await service.start({ companyId, userId: "fixture-user", name: "Home", connectionId: first.connection.id });
    const latest = connect.mock.calls.at(-1)![0];
    await latest.login!.onAuthorized();
    await old.login!.onFailure();
    expect((await row(replacement.connection.id)).status).toBe("connected");
    expect(latest.identity).not.toBe(old.identity);
  });

  it("expires pending consent and stops its network without extending the deadline", async () => {
    const first = await start();
    const input = connect.mock.calls[0]![0];
    now = new Date(Date.parse(first.expiresAt!) + 1);
    expect(await service.resume(companyId, first.connection.id, "fixture-user")).toMatchObject({ connection: { status: "expired" }, expiresAt: null });
    expect(disconnect).toHaveBeenCalledWith(input.identity);
    await expect(input.login!.onAuthorized()).rejects.toMatchObject({ status: 422 });
    expect(connect).toHaveBeenCalledOnce();
  });

  it("does not stop an approved connection when an older progress request fails", async () => {
    const first = await start();
    const input = connect.mock.calls[0]![0];
    let entered!: () => void, reject!: (error: Error) => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    connect.mockImplementationOnce(() => { entered(); return new Promise((_resolve, fail) => { reject = fail; }); });
    const older = service.resume(companyId, first.connection.id, "fixture-user");
    const failed = expect(older).rejects.toMatchObject({ status: 422 });
    await waiting;
    await input.login!.onAuthorized();
    reject(new Error("Old request failed"));
    await failed;
    expect((await row(first.connection.id)).status).toBe("connected");
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("removes the new secret if disconnect wins while sign-in is being prepared", async () => {
    const first = await start();
    const connections = tailscaleConnectionService(db, { secrets: vault, networks: { connect, disconnect } });
    await connections.disconnect(companyId, first.connection.id);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const create = vault.createSystemSecret.bind(vault);
    let createdId = "";
    vi.spyOn(vault, "createSystemSecret").mockImplementationOnce(async (...args) => {
      const created = await create(...args); createdId = created.id; entered(); await blocked; return created;
    });
    const removed = vi.spyOn(vault, "remove");
    const replacement = service.start({ companyId, userId: "fixture-user", name: "Home", connectionId: first.connection.id });
    const failed = expect(replacement).rejects.toMatchObject({ status: 422 });
    await waiting;
    await connections.disconnect(companyId, first.connection.id);
    release();
    await failed;
    expect(removed).toHaveBeenCalledWith(createdId);
    expect((await row(first.connection.id)).status).toBe("disconnected");
  });

  it("rejects a rotated credential instead of joining another tailnet", async () => {
    const first = await start();
    const saved = await row(first.connection.id);
    await vault.rotate(saved.secretId!, { value: "tskey-auth-untrusted" });
    await service.resume(companyId, saved.id, "fixture-user");
    expect(connect.mock.calls.at(-1)![0].credential).toBe(state(connect.mock.calls[0]![0].identity));
    await db.update(tailscaleConnections).set({ credentialHash: "0".repeat(64) }).where(eq(tailscaleConnections.id, saved.id));
    await expect(service.resume(companyId, saved.id, "fixture-user")).rejects.toMatchObject({ status: 422 });
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
