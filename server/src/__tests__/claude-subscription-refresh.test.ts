import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { companies, agents, companyMemberships, companySecrets, connectionGrants, toolConnections, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { readAiConnectionConfigurationFailure } from "../services/ai-connection-configuration-failure.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import * as secretModule from "../services/secrets.js";
import { secretService } from "../services/secrets.js";

vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn() }));
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const agentId = randomUUID();
const document = (expiresAt: number, accessToken = "old-access", refreshToken = "old-refresh") => JSON.stringify({
  claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes: ["user:inference"], subscriptionType: "max" },
});
beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "claude-refresh-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "claude-refresh-test");
  database = await startEmbeddedPostgresTestDatabase("claude-refresh-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Refresh test", issuePrefix: "CRT" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Claude", adapterType: "claude_local" });
}, 90000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
async function connect(value: string) {
  const owner = randomUUID();
  const service = aiConnectionService(db);
  await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
  const account = await service.save(companyId, owner, { provider: "anthropic", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", allAgents: true, agentIds: [] }, value);
  const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
  const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
  const secretId = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!.secretId;
  const state = async () => (await db.select().from(companySecrets).where(eq(companySecrets.id, secretId)))[0]!;
  return { owner, account, row: { connection: connection!, grant: grant! }, secretId, state, service };
}

describe("Claude subscription renewal through the managed runtime", () => {
  it("renews an expired sign-in once for concurrent legacy and native preparations, then uses the saved pair", async () => {
    const { owner, account, row, state, service } = await connect(document(Date.now() - 3600_000));
    const before = await state();
    const realFetch = globalThis.fetch;
    let requests = 0;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests++;
      expect(JSON.parse(raw)).toMatchObject({ grant_type: "refresh_token", refresh_token: "old-refresh" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 28800 }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      expect(url).toBe("https://platform.claude.com/v1/oauth/token");
      return realFetch(`http://127.0.0.1:${port}/token`, init);
    });
    try {
      const runs = await Promise.all(["claude_local", "paperclip_runner"].map(adapterType => prepareManagedAiRuntime(db, {
        companyId, agentId, responsibleUserId: owner, adapterType,
        binding: { provider: "anthropic", method: "subscription", mode: "delegated", ...account },
        config: { provider: "acpx", acpxAgent: "claude", env: {} },
      })));
      try {
        expect(requests).toBe(1);
        for (const run of runs) {
          expect(run.config.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("new-access");
          expect(JSON.stringify(run.config)).not.toContain("new-refresh");
        }
        expect(runs[0].sessionIdentity).toBe(runs[1].sessionIdentity);
        const saved = await state();
        expect(saved.latestVersion).toBe(before.latestVersion + 1);
        expect(saved.aiSessionEpoch).toBe(before.aiSessionEpoch);
        expect(JSON.parse(await service.credentialRaw(row)).claudeAiOauth).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
        expect(await service.credential(row)).toBe("new-access");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        // A late 401 from the old access token must not revoke the refreshed grant.
        await service.markAuthenticationFailed({ companyId, runStartedAt: new Date(), attribution: {
          connectionId: account.connectionId, grantId: account.grantId, provider: "anthropic", method: "subscription", mode: "delegated", responsibleUserId: owner,
          identity: `${account.grantId}:${owner}:${createHash("sha256").update("old-access").digest("hex").slice(0, 16)}`,
        } });
        expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId)))[0]!.status).toBe("active");
      } finally { await Promise.all(runs.map(run => run.cleanup())); }
    } finally { fetchSpy.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it.each(["legacy", "fresh"])("passes through a %s token without network access", async kind => {
    const value = kind === "legacy" ? "legacy-token" : document(Date.now() + 28800_000);
    const { service, row, state } = await connect(value);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    expect(await service.credential(row)).toBe(kind === "legacy" ? value : "old-access");
    expect((await state()).latestVersion).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps a valid token on a temporary outage (expired=%s)", async expired => {
    const { service, row, state, account } = await connect(document(Date.now() + (expired ? -1 : 1) * 60_000));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private-provider-error", { status: 503 }));
    if (expired) await expect(service.credential(row)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
    else expect(await service.credential(row)).toBe("old-access");
    expect((await state()).latestVersion).toBe(1);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId)))[0]!.status).toBe("active");
  });

  it("persists a sign-in repair state for an expired, refused refresh token", async () => {
    const { service, row, account } = await connect(document(Date.now() - 60_000));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private-error", { status: 400 }));
    const error = await service.credential(row).catch(error => error);
    expect(error).toMatchObject({ details: { code: "ai_connection_unavailable", connectionId: account.connectionId } });
    expect(readAiConnectionConfigurationFailure(error)).toBe("ai_connection_unavailable");
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId)))[0]!.status).toBe("needs_reauthorization");
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId)))[0]!.healthMessage).not.toContain("private-error");
  });

  it("retries a failed vault save with the returned pair without a second exchange", async () => {
    const { service, row } = await connect(document(Date.now() - 60_000));
    const realService = secretModule.secretService;
    let attempts = 0;
    vi.spyOn(secretModule, "secretService").mockImplementation((...args) => {
      const vault = realService(...args);
      return { ...vault, rotate: async (...input) => {
        if (++attempts === 1) throw new Error("temporary vault failure");
        return vault.rotate(...input);
      } };
    });
    const exchange = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ access_token: "saved-access", refresh_token: "saved-refresh", expires_in: 28800 })));
    expect(await service.credential(row)).toBe("saved-access");
    expect(attempts).toBe(2);
    expect(exchange).toHaveBeenCalledOnce();
    expect(JSON.parse(await service.credentialRaw(row)).claudeAiOauth.refreshToken).toBe("saved-refresh");
  });

  it.each([false, true])("keeps an exchanged pair after all save retries and respects a later reconnect (%s)", async reconnect => {
    const { service, row, secretId, owner } = await connect(document(Date.now() - 60_000));
    const realService = secretModule.secretService;
    const failingVault = vi.spyOn(secretModule, "secretService").mockImplementation((...args) => ({
      ...realService(...args), rotate: async () => { throw new Error("vault is temporarily unavailable"); },
    }));
    const exchange = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ access_token: "pending-access", refresh_token: "pending-refresh", expires_in: 28800 })));
    await expect(service.credential(row)).rejects.toThrow("vault is temporarily unavailable");
    failingVault.mockRestore();
    if (reconnect) await secretService(db).rotate(secretId, { value: document(Date.now() + 28800_000, "reconnected", "reconnected-refresh") }, { userId: owner });
    // A new service instance represents the next request, after the outage.
    expect(await aiConnectionService(db).credential(row)).toBe(reconnect ? "reconnected" : "pending-access");
    expect(exchange).toHaveBeenCalledOnce();
    expect(JSON.parse(await service.credentialRaw(row)).claudeAiOauth.refreshToken).toBe(reconnect ? "reconnected-refresh" : "pending-refresh");
  });

  it("narrows a fresh broad login token before delivering it to execution", async () => {
    const broad = JSON.parse(document(Date.now() + 28800_000));
    broad.claudeAiOauth.scopes = ["org:create_api_key", "user:profile", "user:inference"];
    const { service, row, account, owner } = await connect(JSON.stringify(broad));
    const exchange = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ access_token: "inference-access", refresh_token: "rotated-refresh", expires_in: 28800, scope: "user:inference" })));
    const run = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "claude_local",
      binding: { provider: "anthropic", method: "subscription", mode: "delegated", ...account }, config: { env: {} } });
    try {
      expect(run.config.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("inference-access");
      expect(JSON.parse(exchange.mock.calls[0]![1]!.body as string).scope).toBe("user:inference");
      expect(JSON.parse(await service.credentialRaw(row)).claudeAiOauth.scopes).toEqual(["user:inference"]);
    } finally { await run.cleanup(); }
  });

  it.each(["refused", "broader response"])("never delivers a broad token if narrowing is %s", async kind => {
    const broad = JSON.parse(document(Date.now() + 28800_000));
    broad.claudeAiOauth.scopes = ["org:create_api_key", "user:inference"];
    const { service, row } = await connect(JSON.stringify(broad));
    const exchange = vi.spyOn(globalThis, "fetch").mockResolvedValue(kind === "refused"
      ? new Response("private-scope-refusal", { status: 400 })
      : new Response(JSON.stringify({ access_token: "still-broad", refresh_token: "rotated-broad-refresh", expires_in: 28800, scope: "org:create_api_key user:inference" })));
    await expect(service.credential(row)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
    expect(exchange).toHaveBeenCalledOnce();
    if (kind !== "refused") expect(JSON.parse(await service.credentialRaw(row)).claudeAiOauth.refreshToken).toBe("rotated-broad-refresh");
  });

  it("keeps the session epoch for renewal and changes it for an explicit reconnect", async () => {
    const { service, row, secretId, state, owner } = await connect(document(Date.now() - 60_000));
    const before = await state();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 })));
    expect(await service.credential(row)).toBe("renewed");
    expect((await state()).aiSessionEpoch).toBe(before.aiSessionEpoch);
    await secretService(db).rotate(secretId, { value: document(Date.now() + 28800_000, "reconnected", "reconnected-refresh") }, { userId: owner });
    expect(await service.credential(row)).toBe("reconnected");
    expect((await state()).aiSessionEpoch).toBeGreaterThan(before.aiSessionEpoch);
  });
});
