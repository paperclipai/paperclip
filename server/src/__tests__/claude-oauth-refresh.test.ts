import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, connectionGrants, createDb, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import { createHash } from "node:crypto";
import { quotaCredentialRecovery, quotaCredentialHash } from "../services/quota-credential-recovery.js";
import { parseStoredClaudeOauth } from "../services/claude-oauth-credential.js";
import * as secretsModule from "../services/secrets.js";
const { secretService } = secretsModule;

vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn().mockResolvedValue(undefined) }));

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 19, 8, 0, 0);
const companyId = randomUUID();
const agentId = randomUUID();
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let service: ReturnType<typeof aiConnectionService>;
let home: string;
let owners = 0;

const document = (n: number, expiresAt: number, scopes = ["user:inference"]) => JSON.stringify({ claudeAiOauth: {
  accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresAt, scopes: scopes, subscriptionType: "max",
} });

async function connect(value: string) {
  const owner = `claude-refresh-${owners++}`;
  await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
  await service.save(companyId, owner, { provider: "anthropic", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, value);
  const [row] = await service.subscriptionAccounts(companyId, owner);
  return row;
}
const stored = async (row: Awaited<ReturnType<typeof connect>>) => parseStoredClaudeOauth(await service.credentialRaw(row));

function providerSequence(responses: Array<() => Response | Promise<Response>>) {
  let call = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next();
  });
}
const granted = (n: number, expiresInSeconds = 28800) => () =>
  Response.json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: expiresInSeconds });

beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-refresh-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "claude-refresh-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-claude-refresh-");
  db = createDb(database.connectionString);
  service = aiConnectionService(db);
  await db.insert(companies).values({ id: companyId, name: "Claude refresh", issuePrefix: "CLR" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Nova", adapterType: "claude_local" });
}, 90000);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

describe("Claude subscription token renewal", () => {
  it("passes a legacy plain token through without contacting the provider", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected"));
    const row = await connect("sk-ant-oat01-legacy");
    expect(await service.credential(row)).toBe("sk-ant-oat01-legacy");
    expect(await service.runtimeCredential(row)).toBe("sk-ant-oat01-legacy");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a token alive across the eight-hour access lifetime (t=0, +7h, +8.5h)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const request = providerSequence([granted(1), granted(2)]);
    const row = await connect(document(0, T0 + 8 * HOUR));

    expect(await service.runtimeCredential(row)).toBe("access-0");
    expect(request).not.toHaveBeenCalled();

    vi.setSystemTime(T0 + 7 * HOUR);
    expect(await service.runtimeCredential(row)).toBe("access-1");
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-0" });
    expect(await stored(row)).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: T0 + 15 * HOUR });

    vi.setSystemTime(T0 + 8.5 * HOUR);
    expect(await service.runtimeCredential(row)).toBe("access-1");
    expect(request).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 13.5 * HOUR);
    expect(await service.runtimeCredential(row)).toBe("access-2");
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toMatchObject({ refresh_token: "refresh-1" });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    expect(grant.status).toBe("active");
  });

  it("exchanges the refresh token once when runs ask at the same time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const request = providerSequence([granted(1)]);
    const row = await connect(document(0, T0 + 1 * HOUR));
    const tokens = await Promise.all([1, 2, 3, 4].map(() => service.credential(row)));
    expect(tokens).toEqual(Array(4).fill("access-1"));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not hold the company secret lock while the provider is slow", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const request = providerSequence([async () => { await gate; return granted(1)(); }]);
    const row = await connect(document(0, T0 + 1 * HOUR));
    const renewal = service.credential(row);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const unrelated = await Promise.race([
      connect("sk-ant-oat01-unrelated").then(() => "saved"),
      new Promise<string>(resolve => setTimeout(() => resolve("waited"), 5000)),
    ]);
    expect(unrelated).toBe("saved");
    release();
    expect(await renewal).toBe("access-1");
    expect(await stored(row)).toMatchObject({ refreshToken: "refresh-1" });
  });

  it("saves a journaled replacement instead of spending the old refresh token again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const request = providerSequence([granted(9)]);
    const base = document(0, T0 + 1 * HOUR);
    const row = await connect(base);
    const [ref] = row.grant.credentialSecretRefs;
    const recovery = quotaCredentialRecovery(companyId, row.grant.id);
    await recovery.write({ companyId, grantId: row.grant.id, connectionId: row.connection.id, secretId: ref.secretId,
      baseHash: quotaCredentialHash(base), value: document(1, T0 + 8 * HOUR) });
    expect(await service.credential(row)).toBe("access-1");
    expect(request).not.toHaveBeenCalled();
    expect(await recovery.read()).toBeNull();
    expect(await stored(row)).toMatchObject({ refreshToken: "refresh-1" });
  });

  it("keeps the journal and defers the run when the replacement cannot be saved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const request = providerSequence([granted(1)]);
    const row = await connect(document(0, T0 + 1 * HOUR));
    const realSecretService = secretService;
    const failing = vi.spyOn(secretsModule, "secretService").mockImplementation(((...args: Parameters<typeof realSecretService>) => {
      const real = realSecretService(...args);
      return { ...real, rotate: async () => { throw new Error("injected write failure"); } };
    }) as typeof realSecretService);
    await expect(service.credential(row)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
    failing.mockRestore();
    expect((await quotaCredentialRecovery(companyId, row.grant.id).read())?.value).toContain("refresh-1");
    expect(request).toHaveBeenCalledTimes(1);
    request.mockClear().mockRejectedValue(new Error("must not exchange again"));
    expect(await service.credential(row)).toBe("access-1");
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the current access token when renewal is unavailable but it has not expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    providerSequence([() => new Response("down", { status: 503 })]);
    const row = await connect(document(0, T0 + 1 * HOUR));
    expect(await service.credential(row)).toBe("access-0");
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    expect(grant.status).toBe("active");
  });

  it("asks to retry when renewal is unavailable and the token has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    providerSequence([() => new Response("down", { status: 503 })]);
    const row = await connect(document(0, T0 - HOUR));
    await expect(service.credential(row)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    expect(grant.status).toBe("active");
  });

  it("asks for a new sign-in when the provider refuses an expired token's refresh token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    providerSequence([() => new Response("{}", { status: 400 })]);
    const row = await connect(document(0, T0 - HOUR));
    await expect(service.credential(row)).rejects.toMatchObject({ details: { code: "ai_connection_credential_missing" } });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, row.connection.id));
    expect(grant.status).toBe("needs_reauthorization");
    expect(connection.healthStatus).toBe("error");
  });

  it("does not disable a connection while the refused token's access token still works", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    providerSequence([() => new Response("{}", { status: 400 })]);
    const row = await connect(document(0, T0 + 1 * HOUR));
    expect(await service.credential(row)).toBe("access-0");
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    expect(grant.status).toBe("active");
  });

  it("renews a broad login token for inference only before any run receives it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const request = providerSequence([() => Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 28800, scope: "user:inference" })]);
    const row = await connect(document(0, T0 + 8 * HOUR, ["user:inference", "user:profile", "org:create_api_key", "user:sessions:claude_code"]));
    expect(await service.runtimeCredential(row)).toBe("access-1");
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({ refresh_token: "refresh-0", scope: "user:inference" });
    expect(await stored(row)).toMatchObject({ accessToken: "access-1", scopes: ["user:inference"] });
    expect(await service.runtimeCredential(row)).toBe("access-1");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("falls back to the login scopes once when the provider refuses an inference-only renewal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const broad = ["user:inference", "org:create_api_key"];
    const request = providerSequence([
      () => Response.json({ error: "invalid_scope" }, { status: 400 }),
      () => Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 28800, scope: broad.join(" ") }),
    ]);
    const row = await connect(document(0, T0 + 8 * HOUR, broad));
    expect(await service.credential(row)).toBe("access-1");
    expect(request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).scope)).toEqual(["user:inference", broad.join(" ")]);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    expect(grant.status).toBe("active");
    expect(await stored(row)).toMatchObject({ scopeNarrowingRefused: true, scopes: broad });
    expect(await service.credential(row)).toBe("access-1");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("exchanges the refresh token once across server processes that share the database", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const request = providerSequence([async () => { await gate; return granted(1)(); }]);
    const row = await connect(document(0, T0 + 1 * HOUR));
    // A second module instance has its own in-process state, like a second server task.
    vi.resetModules();
    const other = (await import("../services/ai-connections.js")).aiConnectionService(db);
    const first = service.credential(row);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const second = other.credential(row);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(request).toHaveBeenCalledTimes(1);
    release();
    expect(await Promise.all([first, second])).toEqual(["access-1", "access-1"]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not let an older run's failure disable a grant while its renewal is in flight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const request = providerSequence([async () => { await gate; return granted(1)(); }]);
    const row = await connect(document(0, T0 + 1 * HOUR));
    const renewal = service.credential(row);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const generation = createHash("sha256").update("access-0").digest("hex").slice(0, 16);
    const failure = service.markAuthenticationFailed({
      companyId, agentId, runStartedAt: new Date(T0 + 365 * 24 * HOUR),
      attribution: { connectionId: row.connection.id, grantId: row.grant.id, provider: "anthropic", method: "subscription",
        mode: "responsible_user", responsibleUserId: row.grant.subjectUserId, identity: `${row.grant.id}:${row.grant.subjectUserId ?? "shared"}:${generation}` },
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    release();
    expect(await renewal).toBe("access-1");
    await failure;
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    expect(grant.status).toBe("active");
    expect(await stored(row)).toMatchObject({ refreshToken: "refresh-1" });
    expect(await service.credential(row)).toBe("access-1");
  });
});

describe("Claude background token renewal", () => {
  // Earlier cases leave connections behind that would answer the same fake provider.
  beforeEach(async () => { await db.update(connectionGrants).set({ status: "needs_reauthorization" }); });

  it("renews an idle login before its token is close to ending, without any run asking", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const request = providerSequence([granted(1)]);
    const row = await connect(document(0, T0 + 2.5 * HOUR));
    expect(await service.renewDueClaudeCredentials()).toMatchObject({ attempted: 1, failed: 0 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await stored(row)).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: T0 + 8 * HOUR });
    request.mockClear();
    expect(await service.renewDueClaudeCredentials()).toMatchObject({ attempted: 0 });
    expect(request).not.toHaveBeenCalled();
  });

  it("leaves a login with a fresh token alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const request = providerSequence([granted(1)]);
    const row = await connect(document(0, T0 + 6 * HOUR));
    expect(await service.renewDueClaudeCredentials()).toMatchObject({ checked: 1, attempted: 0 });
    expect(request).not.toHaveBeenCalled();
    expect(await stored(row)).toMatchObject({ accessToken: "access-0" });
  });

  it("shows the reconnect request while the old token still works when the provider refuses the renewal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    providerSequence([() => new Response("{}", { status: 400 })]);
    const row = await connect(document(0, T0 + 20 * 60 * 1000));
    await service.renewDueClaudeCredentials();
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, row.connection.id));
    expect(grant.status).toBe("needs_reauthorization");
    expect(connection.healthStatus).toBe("error");
  });

  it("keeps the login usable when a refused renewal still has time to be retried", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    providerSequence([() => new Response("{}", { status: 400 })]);
    const row = await connect(document(0, T0 + 2.5 * HOUR));
    await service.renewDueClaudeCredentials();
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    expect(grant.status).toBe("active");
    expect(await service.credential(row)).toBe("access-0");
  });

  it("tells a failed run whether the login was renewed after it started", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    providerSequence([granted(1)]);
    const row = await connect(document(0, T0 + 2.5 * HOUR));
    const generation = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);
    const attribution = (token: string) => ({ connectionId: row.connection.id, grantId: row.grant.id, provider: "anthropic" as const,
      method: "subscription" as const, mode: "responsible_user" as const, responsibleUserId: row.grant.subjectUserId,
      identity: `${row.grant.id}:${row.grant.subjectUserId ?? "shared"}:${generation(token)}` });
    const startedAt = new Date(T0 + 365 * 24 * HOUR);
    expect(await service.authenticationFailureState({ companyId, runStartedAt: startedAt, attribution: attribution("access-0") })).toBe("current");
    await service.renewDueClaudeCredentials();
    expect(await service.authenticationFailureState({ companyId, runStartedAt: startedAt, attribution: attribution("access-0") })).toBe("renewed");
    expect(await service.authenticationFailureState({ companyId, runStartedAt: startedAt, attribution: attribution("access-1") })).toBe("current");
    await db.update(connectionGrants).set({ status: "needs_reauthorization" }).where(eq(connectionGrants.id, row.grant.id));
    expect(await service.authenticationFailureState({ companyId, runStartedAt: startedAt, attribution: attribution("access-1") })).toBe("needs_reauthorization");
  });
});
