import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { companies, agents, companyMemberships, companySecrets, connectionGrants, heartbeatRuns, issues, toolConnections, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { readAiConnectionConfigurationFailure } from "../services/ai-connection-configuration-failure.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime, withManagedAiProbe } from "../services/ai-connection-runtime.js";
import * as secretModule from "../services/secrets.js";
import { secretService } from "../services/secrets.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { readIdleLocalWork } from "../services/idle-local-work.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { recordReplacementRunnerCredential } from "../services/run-ai-credential-holder.js";
import { NativeEnvironmentProbeCleanupError } from "../vendor/paperclip-runner/index.js";

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

  it.each(["inference", "broad", "unknown"])("persists a sign-in repair state for an expired, refused refresh token (%s)", async scopes => {
    const login = JSON.parse(document(Date.now() - 60_000));
    if (scopes === "broad") login.claudeAiOauth.scopes.push("org:create_api_key");
    if (scopes === "unknown") delete login.claudeAiOauth.scopes;
    const { service, row, account } = await connect(JSON.stringify(login));
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
    const probes = async () => {
      let state: unknown;
      await readIdleLocalWork({ diagnostic: (name, value) => { if (name === "local.registered_probes") state = value; } });
      return state;
    };
    expect(await probes()).toBe("none");
    await expect(service.credential(row)).rejects.toThrow("vault is temporarily unavailable");
    // The unsaved pair holds the only working refresh token: an idle shutdown must wait for it.
    expect(await probes()).toBe("present");
    failingVault.mockRestore();
    if (reconnect) await secretService(db).rotate(secretId, { value: document(Date.now() + 28800_000, "reconnected", "reconnected-refresh") }, { userId: owner });
    // A new service instance represents the next request, after the outage.
    expect(await aiConnectionService(db).credential(row)).toBe(reconnect ? "reconnected" : "pending-access");
    expect(exchange).toHaveBeenCalledOnce();
    expect(JSON.parse(await service.credentialRaw(row)).claudeAiOauth.refreshToken).toBe(reconnect ? "reconnected-refresh" : "pending-refresh");
    expect(await probes()).toBe("none");
  });

  it.each(["revoked", "reconnected"] as const)("stops blocking an idle shutdown for an unsaved pair once its grant is %s", async ending => {
    const { service, row, account, secretId, owner } = await connect(document(Date.now() - 60_000));
    const realService = secretModule.secretService;
    const failingVault = vi.spyOn(secretModule, "secretService").mockImplementation((...args) => ({
      ...realService(...args), rotate: async () => { throw new Error("vault is temporarily unavailable"); },
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ access_token: "pending-access", refresh_token: "pending-refresh", expires_in: 28800 })));
    const probes = async () => {
      let state: unknown;
      await readIdleLocalWork({ diagnostic: (name, value) => { if (name === "local.registered_probes") state = value; } });
      return state;
    };
    await expect(service.credential(row)).rejects.toThrow("vault is temporarily unavailable");
    failingVault.mockRestore();
    expect(await probes()).toBe("present");
    // The grant ends, or gets a new sign-in, by a path that knows nothing about the pair.
    if (ending === "revoked") await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, account.grantId));
    else await secretService(db).rotate(secretId, { value: document(Date.now() + 28800_000, "reconnected", "reconnected-refresh") }, { userId: owner });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      await vi.waitFor(async () => expect(await probes()).toBe("none"), { timeout: 10_000 });
    } finally { vi.useRealTimers(); }
  });

  it.each(["40P01", "40001", "55P03"])("reports database contention that outlasts its retries as a temporary wait (%s)", async code => {
    const { service, row } = await connect(document(Date.now() - 60_000));
    vi.spyOn(db, "transaction").mockRejectedValue(Object.assign(new Error("contention"), { code }));
    await expect(service.credential(row)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
  });

  it("keeps an exchanged pair when a run that holds the replaced token then reports a rejected token", async () => {
    const { service, row, owner, account } = await connect(document(Date.now() + 30 * 60_000));
    const realService = secretModule.secretService;
    const failingVault = vi.spyOn(secretModule, "secretService").mockImplementation((...args) => ({
      ...realService(...args), rotate: async () => { throw new Error("vault is temporarily unavailable"); },
    }));
    const exchange = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "pending-access", refresh_token: "pending-refresh", expires_in: 28800 })))
      .mockResolvedValue(new Response("{}", { status: 400 }));
    await expect(service.credential(row)).rejects.toThrow("vault is temporarily unavailable");
    failingVault.mockRestore();
    await service.markAuthenticationFailed({ companyId, runStartedAt: new Date(), attribution: {
      connectionId: account.connectionId, grantId: account.grantId, provider: "anthropic", method: "subscription", mode: "delegated", responsibleUserId: owner,
      identity: `${account.grantId}:${owner}:${createHash("sha256").update("old-access").digest("hex").slice(0, 16)}`,
    } });
    expect(await aiConnectionService(db).credential(row)).toBe("pending-access");
    expect(exchange).toHaveBeenCalledOnce();
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId)))[0]!.status).toBe("active");
    expect(JSON.parse(await service.credentialRaw(row)).claudeAiOauth.refreshToken).toBe("pending-refresh");
  });

  it.each([false, true])("renews an expired retained pair after recovery before starting a run (already saved=%s)", async alreadySaved => {
    const { service, row, secretId, owner, account } = await connect(document(Date.now() - 60_000));
    const realService = secretModule.secretService;
    let retained = "";
    const failingVault = vi.spyOn(secretModule, "secretService").mockImplementation((...args) => ({
      ...realService(...args), rotate: async (_id, input) => {
        if (typeof input.value !== "string") throw new Error("Expected a credential value");
        retained = input.value;
        throw new Error("vault is temporarily unavailable");
      },
    }));
    const exchange = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "retained-access", refresh_token: "retained-refresh", expires_in: 28800 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "current-access", refresh_token: "current-refresh", expires_in: 28800 })));
    await expect(service.credential(row)).rejects.toThrow("vault is temporarily unavailable");
    failingVault.mockRestore();
    if (alreadySaved) await secretService(db).rotate(secretId, { value: retained, preserveAiSessionEpoch: true }, { userId: owner });
    const nextDay = Date.now() + 9 * 3600_000;
    vi.spyOn(Date, "now").mockReturnValue(nextDay);
    const run = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "claude_local",
      binding: { provider: "anthropic", method: "subscription", mode: "delegated", ...account }, config: { env: {} } });
    try {
      expect(run.config.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("current-access");
      expect(exchange).toHaveBeenCalledTimes(2);
      expect(JSON.parse(exchange.mock.calls[1]![1]!.body as string).refresh_token).toBe("retained-refresh");
      const saved = JSON.parse(await service.credentialRaw(row)).claudeAiOauth;
      expect(saved.refreshToken).toBe("current-refresh");
      expect(saved.expiresAt).toBeGreaterThan(nextDay);
    } finally { await run.cleanup(); }
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

describe("Claude subscription idle renewal", () => {
  const binding = (account: { connectionId: string; grantId: string }) => ({ provider: "anthropic" as const, method: "subscription" as const, mode: "delegated" as const, ...account });
  const holdingRun = async (grantId: string, status = "running") => {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, invocationSource: "assignment", status, contextSnapshot: { aiConnection: { grantId } } });
    return id;
  };

  it("renews instead of requesting sign-in when a run's access token is rejected, and requests sign-in when the renewed token is rejected too", async () => {
    // Not yet due for renewal, so nothing reaches the provider before the rejection.
    const { account, owner, row, service } = await connect(document(Date.now() + 6 * 3600_000));
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 })));
    const run = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} } });
    const failed = { companyId, runStartedAt: new Date(Date.now() + 1000), attribution: { ...run.attribution, identity: run.identity } };
    await run.cleanup();
    await service.markAuthenticationFailed(failed);
    const status = async () => (await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId)))[0]!.status;
    expect(await status()).toBe("active");
    expect(JSON.parse(await service.credentialRaw(row)).claudeAiOauth.expiresAt).toBe(0);
    expect(exchange).not.toHaveBeenCalled();
    expect(await service.credential(row)).toBe("renewed");
    expect(exchange).toHaveBeenCalledOnce();
    // The provider refuses the token it has just issued: one more renewal would not help.
    await service.markAuthenticationFailed({ ...failed, renewable: "only", attribution: { ...failed.attribution, identity: failed.attribution.identity.replace(/[^:]+$/, createHash("sha256").update("renewed").digest("hex").slice(0, 16)) } });
    expect(await status()).toBe("needs_reauthorization");
    expect(exchange).toHaveBeenCalledOnce();
  });

  it("renews again when the token issued after a rejection is rejected only after its end", async () => {
    const { account, owner, row, service } = await connect(document(Date.now() + 6 * 3600_000));
    let renewals = 0;
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: `renewed-${++renewals}`, refresh_token: `rotated-${renewals}`, expires_in: 28800 })));
    const run = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} } });
    const failed = { companyId, runStartedAt: new Date(Date.now() + 1000), attribution: { ...run.attribution, identity: run.identity } };
    await run.cleanup();
    await service.markAuthenticationFailed(failed);
    expect(await service.credential(row)).toBe("renewed-1");
    const later = Date.now() + 9 * 3600_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // A long run held the renewed token past its end.
      vi.setSystemTime(later);
      await service.markAuthenticationFailed({ ...failed, runStartedAt: new Date(later + 1000), attribution: { ...failed.attribution, identity: failed.attribution.identity.replace(/[^:]+$/, createHash("sha256").update("renewed-1").digest("hex").slice(0, 16)) } });
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId)))[0]!.status).toBe("active");
      expect(await service.credential(row)).toBe("renewed-2");
    } finally { vi.useRealTimers(); }
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  const providerRejection = { errorCode: "native_session_interrupted", resultJson: { providerFailure: { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "turn",
    category: "authentication", message: "Invalid bearer token", retryability: "requires_action" } } };

  it("marks a rejected token spent for a failed run that has no task, so the next run does not receive it", async () => {
    const { account, owner, row, service } = await connect(document(Date.now() + 6 * 3600_000));
    const timerAgent = randomUUID();
    await db.insert(agents).values({ id: timerAgent, companyId, name: "Timer", adapterType: "claude_local", runtimeConfig: { aiConnection: binding(account) } });
    const run = await prepareManagedAiRuntime(db, { companyId, agentId: timerAgent, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} } });
    await run.cleanup();
    const failedRun = randomUUID();
    await db.insert(heartbeatRuns).values({ id: failedRun, companyId, agentId: timerAgent, invocationSource: "timer", status: "failed", ...providerRejection,
      startedAt: new Date(Date.now() + 1000), contextSnapshot: { aiConnection: { ...run.attribution, identity: run.identity } } });
    // No task and no responsible user: no repair card can be made.
    expect(await connectionIntentService(db).requestForRunAuthFailure(failedRun)).toBeNull();
    expect(JSON.parse(await service.credentialRaw(row)).claudeAiOauth.expiresAt).toBe(0);
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 })));
    expect(await service.credential(row)).toBe("renewed");
    expect(exchange).toHaveBeenCalledOnce();
  });

  it.each([
    ["failed before it reached the provider", { errorCode: "configuration_incomplete", resultJson: { configurationIncomplete: { reason: "ai_connection_unavailable" } } }, document(Date.now() + 8 * 3600_000)],
    ["failed with an authentication code and no report from the provider", { errorCode: "claude_auth_required" }, document(Date.now() + 8 * 3600_000)],
    ["was rejected with a login that cannot be renewed", providerRejection, "legacy-access-token"],
  ] as const)("leaves the credential alone when a run with no repair card %s", async (_case, failure, credential) => {
    const { account, owner, row, service } = await connect(credential);
    const supersededAgent = randomUUID();
    await db.insert(agents).values({ id: supersededAgent, companyId, name: "Superseded", adapterType: "claude_local", runtimeConfig: { aiConnection: binding(account) } });
    const run = await prepareManagedAiRuntime(db, { companyId, agentId: supersededAgent, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} } });
    await run.cleanup();
    const failedRun = randomUUID();
    await db.insert(heartbeatRuns).values({ id: failedRun, companyId, agentId: supersededAgent, invocationSource: "timer", status: "failed", ...failure,
      startedAt: new Date(Date.now() + 1000), contextSnapshot: { aiConnection: { ...run.attribution, identity: run.identity } } });
    const exchange = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    expect(await connectionIntentService(db).requestForRunAuthFailure(failedRun)).toBeNull();
    expect(await service.credentialRaw(row)).toBe(credential);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId)))[0]!.status).toBe("active");
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each([
    ["an authentication code that a local error produced", { errorCode: "claude_auth_required" }, false],
    ["a credential store that was busy", { errorCode: "configuration_incomplete", resultJson: { configurationIncomplete: { reason: "ai_connection_unavailable" } } }, false],
    ["a token that the provider refused", providerRejection, true],
  ] as const)("passes every check for the latest run of a task that failed on %s, and marks the token spent only for a refusal", async (_case, failure, spent) => {
    const credential = document(Date.now() + 8 * 3600_000);
    const { account, owner, row, service } = await connect(credential);
    const taskAgent = randomUUID(), issueId = randomUUID(), failedRun = randomUUID();
    await db.insert(agents).values({ id: taskAgent, companyId, name: "Task", adapterType: "claude_local", runtimeConfig: { aiConnection: binding(account) } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Open task", status: "in_progress", assigneeAgentId: taskAgent });
    const run = await prepareManagedAiRuntime(db, { companyId, agentId: taskAgent, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} } });
    await run.cleanup();
    await db.insert(heartbeatRuns).values({ id: failedRun, companyId, agentId: taskAgent, invocationSource: "assignment", status: "failed", ...failure, responsibleUserId: owner,
      startedAt: new Date(Date.now() + 1000), contextSnapshot: { issueId, aiConnection: { ...run.attribution, identity: run.identity } } });
    expect(await connectionIntentService(db).requestForRunAuthFailure(failedRun)).toMatchObject({ state: "ready" });
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId)))[0]!.status).toBe("active");
    if (spent) expect(JSON.parse(await service.credentialRaw(row)).claudeAiOauth.expiresAt).toBe(0);
    else expect(await service.credentialRaw(row)).toBe(credential);
  });

  it("marks a rejected token spent although the agent has changed its connection since the run", async () => {
    const { account, owner, row, service } = await connect(document(Date.now() + 6 * 3600_000));
    const movedAgent = randomUUID();
    await db.insert(agents).values({ id: movedAgent, companyId, name: "Moved", adapterType: "claude_local", runtimeConfig: { aiConnection: binding(account) } });
    const run = await prepareManagedAiRuntime(db, { companyId, agentId: movedAgent, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} } });
    await run.cleanup();
    await db.update(agents).set({ runtimeConfig: { aiConnection: { provider: "openai", method: "api_key", mode: "responsible_user" } } }).where(eq(agents.id, movedAgent));
    const failedRun = randomUUID();
    await db.insert(heartbeatRuns).values({ id: failedRun, companyId, agentId: movedAgent, invocationSource: "timer", status: "failed", ...providerRejection,
      startedAt: new Date(Date.now() + 1000), contextSnapshot: { aiConnection: { ...run.attribution, identity: run.identity } } });
    expect(await connectionIntentService(db).requestForRunAuthFailure(failedRun)).toBeNull();
    expect(JSON.parse(await service.credentialRaw(row)).claudeAiOauth.expiresAt).toBe(0);
  });

  it("refuses to hand a token to a run that has no row, because it could not be recorded as a holder", async () => {
    const { service, row } = await connect(document(Date.now() + 8 * 3600_000));
    await expect(service.credential(row, 0, undefined, { currentRunId: randomUUID() })).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
  });

  it("records the prepared token identity when a replacement runner is launched, and nothing otherwise", async () => {
    const replaced = randomUUID(), kept = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: replaced, companyId, agentId, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: "kept", aiConnection: { grantId: "g", identity: "g:shared:delivered", preparedIdentity: "g:shared:renewed" } } },
      { id: kept, companyId, agentId, invocationSource: "assignment", status: "running", contextSnapshot: { aiConnection: { grantId: "g", identity: "g:shared:delivered" } } },
    ]);
    await recordReplacementRunnerCredential(db, { companyId, runId: replaced });
    await recordReplacementRunnerCredential(db, { companyId, runId: kept });
    const snapshot = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!.contextSnapshot;
    expect(await snapshot(replaced)).toEqual({ issueId: "kept", aiConnection: { grantId: "g", identity: "g:shared:renewed" } });
    expect(await snapshot(kept)).toEqual({ aiConnection: { grantId: "g", identity: "g:shared:delivered" } });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(inArray(heartbeatRuns.id, [replaced, kept]));
  });

  it("defers an early renewal while another run holds the token", async () => {
    const { service, row, state, account } = await connect(document(Date.now() + 3600_000));
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 })));
    const other = await holdingRun(account.grantId);
    await holdingRun(account.grantId, "queued");
    expect(await service.credential(row)).toBe("old-access");
    expect(exchange).not.toHaveBeenCalled();
    expect((await state()).latestVersion).toBe(1);
    // The run that holds the token does not defer its own renewal, and a finished run defers nothing.
    expect(await service.credential(row, 0, undefined, { currentRunId: other })).toBe("renewed");
    expect(exchange).toHaveBeenCalledOnce();
  });

  it("renews without waiting once the token is about to expire, and when the holder has finished", async () => {
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 })));
    const closing = await connect(document(Date.now() + 120_000));
    await holdingRun(closing.account.grantId);
    expect(await closing.service.credential(closing.row)).toBe("renewed");
    const finished = await connect(document(Date.now() + 3600_000));
    const run = await holdingRun(finished.account.grantId);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run));
    expect(await finished.service.credential(finished.row)).toBe("renewed");
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it("keeps the renewal after a run ends tracked as active work until it is saved", async () => {
    const { account, owner, state } = await connect(document(Date.now() + 3600_000));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await gate;
      return new Response(JSON.stringify({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 }));
    });
    const other = await holdingRun(account.grantId);
    const current = await holdingRun(account.grantId);
    const run = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} }, currentRunId: current });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(inArray(heartbeatRuns.id, [other, current]));
    const idle = idleWorkSnapshot().active;
    await run.cleanup();
    expect(idleWorkSnapshot().active).toBe(idle + 1);
    release();
    await vi.waitFor(async () => expect((await state()).latestVersion).toBe(2), { timeout: 10_000 });
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(idle), { timeout: 10_000 });
  });

  it("renews a nearly expired token when its last run ends", async () => {
    const { account, owner, state } = await connect(document(Date.now() + 3600_000));
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 })));
    const other = await holdingRun(account.grantId);
    const current = await holdingRun(account.grantId);
    const run = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} }, currentRunId: current });
    expect(run.config.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("old-access");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(inArray(heartbeatRuns.id, [other, current]));
    await run.cleanup();
    await vi.waitFor(async () => expect((await state()).latestVersion).toBe(2), { timeout: 10_000 });
    expect(exchange).toHaveBeenCalledOnce();
  });

  it("counts a run as a holder from the moment it receives the token, before its preparation is saved", async () => {
    const { account, owner, service, row, state } = await connect(document(Date.now() + 3600_000));
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 })));
    const other = await holdingRun(account.grantId);
    // A run that starts: it has a row, but no saved connection yet.
    const starting = randomUUID();
    await db.insert(heartbeatRuns).values({ id: starting, companyId, agentId, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: "kept" } });
    const run = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} }, currentRunId: starting });
    expect(run.config.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("old-access");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, starting)))[0]!.contextSnapshot).toEqual({ issueId: "kept", aiCredentialHolder: account.grantId });
    // The other holder ends. Its cleanup renewal must not revoke the token the starting run was given.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, other));
    expect(await service.credential(row)).toBe("old-access");
    expect(exchange).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, starting));
    await run.cleanup();
    await vi.waitFor(async () => expect((await state()).latestVersion).toBe(2), { timeout: 10_000 });
    expect(exchange).toHaveBeenCalledOnce();
  });

  it("counts an account test in flight as a holder, and renews once it has ended", async () => {
    const { account, owner, service, row, state } = await connect(document(Date.now() + 3600_000));
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 })));
    // A run holds the token while the test starts, so the test receives the same token.
    const other = await holdingRun(account.grantId);
    let finish!: () => void;
    const testing = new Promise<void>(resolve => { finish = resolve; });
    let started!: () => void;
    const reached = new Promise<void>(resolve => { started = resolve; });
    const probe = withManagedAiProbe(db, { companyId, agentId, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} } }, async runtime => {
      expect(runtime.config.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("old-access");
      started();
      await testing;
    });
    await reached;
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, other));
    // No run holds the token now, but the test does: a read by another caller must not renew under it.
    expect(await service.credential(row)).toBe("old-access");
    expect(exchange).not.toHaveBeenCalled();
    finish();
    await probe;
    await vi.waitFor(async () => expect((await state()).latestVersion).toBe(2), { timeout: 10_000 });
    expect(exchange).toHaveBeenCalledOnce();
  });

  it("keeps an account test counted as a holder until its native process has retired", async () => {
    const { account, owner, service, row, state } = await connect(document(Date.now() + 3600_000));
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 })));
    const other = await holdingRun(account.grantId);
    let retire!: () => void;
    const retired = new Promise<void>(resolve => { retire = resolve; });
    await expect(withManagedAiProbe(db, { companyId, agentId, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} } }, async () => {
      throw new NativeEnvironmentProbeCleanupError(retired, undefined, []);
    })).rejects.toMatchObject({ details: { code: "native_probe_cleanup_pending" } });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, other));
    // The test has returned, but its native process still runs with the token.
    expect(await service.credential(row)).toBe("old-access");
    expect(exchange).not.toHaveBeenCalled();
    retire();
    await vi.waitFor(async () => expect((await state()).latestVersion).toBe(2), { timeout: 10_000 });
    expect(exchange).toHaveBeenCalledOnce();
  });

  it("stops counting an account test whose native process never retires once its token has expired", async () => {
    const { account, owner, service, row } = await connect(document(Date.now() + 3600_000));
    let renewals = 0;
    const other = await holdingRun(account.grantId);
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: `renewed-${++renewals}`, refresh_token: `rotated-${renewals}`, expires_in: 3600 })));
    await expect(withManagedAiProbe(db, { companyId, agentId, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} } }, async () => {
      throw new NativeEnvironmentProbeCleanupError(new Promise<void>(() => undefined), undefined, []);
    })).rejects.toMatchObject({ details: { code: "native_probe_cleanup_pending" } });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, other));
    expect(await service.credential(row)).toBe("old-access");
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // With less than five minutes left the token is renewed whoever holds it.
      vi.setSystemTime(start + 3600_000 - 60_000);
      expect(await service.credential(row)).toBe("renewed-1");
      // The first token still lives, so the hold still counts for its successor.
      expect(await service.credential(row)).toBe("renewed-1");
      vi.setSystemTime(start + 3600_000 + 60_000);
      expect(await service.credential(row)).toBe("renewed-2");
    } finally { vi.useRealTimers(); }
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it("does not renew at cleanup while the run is still running, as when its controller detaches for a restart", async () => {
    const { account, owner, state } = await connect(document(Date.now() + 3600_000));
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 })));
    const other = await holdingRun(account.grantId);
    const current = await holdingRun(account.grantId);
    const run = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "claude_local", binding: binding(account), config: { env: {} }, currentRunId: current });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, other));
    const idle = idleWorkSnapshot().active;
    await run.cleanup();
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(idle), { timeout: 10_000 });
    expect(exchange).not.toHaveBeenCalled();
    expect((await state()).latestVersion).toBe(1);
  });
});
