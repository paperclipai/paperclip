import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, tailscaleConnections, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { tailscaleConnectionService } from "./tailscale-connections.js";
import type { PaperclipCloudConnector } from "./paperclip-cloud-connector.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("durable Tailscale consent state", () => {
  let db: Db;
  let cleanup: () => Promise<void>;
  let companyId: string;
  let clock: Date;
  const startAuthorization = vi.fn();
  const claim = vi.fn();
  let service: ReturnType<typeof tailscaleConnectionService>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("tailscale-connections");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
  });
  afterAll(async () => { await cleanup?.(); });
  beforeEach(async () => {
    companyId = randomUUID();
    clock = new Date("2020-01-01T00:00:00Z");
    await db.insert(companies).values({ id: companyId, name: "Tailscale fixture", issuePrefix: randomUUID().slice(0, 8).toUpperCase() });
    startAuthorization.mockReset().mockImplementation(async () => ({ authorizationUrl: "https://login.tailscale.com/a/oauth_authorize", expiresAt: new Date(clock.getTime() + 600_000).toISOString() }));
    claim.mockReset().mockRejectedValue(new Error("simulated broker failure"));
    service = tailscaleConnectionService(db, { connector: () => ({ startAuthorization, claim }) as unknown as PaperclipCloudConnector, now: () => clock });
  });
  async function start() {
    const result = await service.start({ companyId, userId: "fixture-owner", name: "Home tailnet", returnUri: "http://localhost:3100/api/tools/oauth/tailscale/callback" });
    const state = startAuthorization.mock.calls[0]![0].returnState as string;
    return { result, state };
  }
  const authorizeCompany = (_: string) => undefined;

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
