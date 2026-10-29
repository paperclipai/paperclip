import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const account = vi.hoisted(() => ({
  credential: "", epoch: 4, version: 8, status: "active",
  refs: [{ configPath: "ai.credential", secretId: "22222222-2222-4222-8222-222222222222", versionSelector: "latest" }],
  rotation: vi.fn(), locks: [] as string[],
  journal: undefined as undefined | Record<string, unknown>, journalWrite: vi.fn(),
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { promises } = await import("node:fs");
  return { ...actual, rm: (...args: Parameters<typeof actual.rm>) => promises.rm(...args) };
});
const selection = () => ({
  grant: { id: "11111111-1111-4111-8111-111111111111", subjectUserId: "alice", credentialSecretRefs: account.refs, providerTenant: { name: "alice@example.test" } },
  connection: { id: "33333333-3333-4333-8333-333333333333", name: "Google account fixture", config: { ai: { provider: "google", method: "subscription" } } },
  attribution: { connectionId: "33333333-3333-4333-8333-333333333333", grantId: "11111111-1111-4111-8111-111111111111",
    provider: "google", method: "subscription", mode: "responsible_user", responsibleUserId: "alice" },
});
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({
  select: async () => selection(), runtimeCredential: async () => account.credential, credential: async () => account.credential,
}) }));
vi.mock("../services/subscriptions.js", () => ({ subscriptionService: () => ({ register: async () => "subscription-fixture" }) }));
vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({ rotate: account.rotation }) }));
vi.mock("../services/quota-credential-recovery.js", () => ({
  quotaCredentialHash: (value: string) => value,
  quotaCredentialRecovery: () => ({ read: async () => account.journal,
    write: account.journalWrite, clear: async () => { account.journal = undefined; } }),
  RetiredCredentialRecoveryError: class extends Error {
    constructor(cause: unknown) { super("The selected account credential is awaiting durable recovery. Retry shortly.", { cause }); }
  },
}));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({
  decideCodexAuthMerge: vi.fn(), withAccountHomeSecretMutationLock: async (_environment: unknown, _companyId: unknown, work: () => Promise<void>) => work(),
}));
import { prepareManagedAiRuntime, withManagedAiProbe } from "../services/ai-connection-runtime.js";
import { NativeEnvironmentProbeCleanupError } from "../vendor/paperclip-runner/index.js";

const credential = (project?: string, token = "fixture-selected-refresh") => JSON.stringify({
  client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", client_secret: "fixture-client-secret",
  refresh_token: token, token_uri: "https://oauth2.googleapis.com/token", scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"],
  ...(project ? { project_id: project } : {}),
});
const homes: string[] = [];
const runtimes: Awaited<ReturnType<typeof prepareManagedAiRuntime>>[] = [];
function database(): Db {
  const db = {
    select: (fields?: Record<string, unknown>) => ({ from: () => ({ where: () => {
      const rows = !fields ? [{ ...selection().grant, status: account.status }]
        : "refs" in fields ? [{ refs: account.refs, status: account.status }]
        : [{ id: account.refs[0].secretId, epoch: account.epoch, version: account.version }];
      return Object.assign(Promise.resolve(rows), {
        limit: async () => rows,
        for: async (lock: string) => { account.locks.push(`${fields ? "secret" : "grant"}:${lock}`); return rows; },
      });
    } }) }),
    transaction: async (work: (transaction: Db) => Promise<void>) => work(db as unknown as Db),
  };
  return db as unknown as Db;
}
async function prepare() {
  const runtime = await prepareManagedAiRuntime(database(), {
    companyId: "44444444-4444-4444-8444-444444444444", agentId: "55555555-5555-4555-8555-555555555555", responsibleUserId: "alice",
    adapterType: "paperclip_runner", binding: { provider: "google", method: "subscription", mode: "responsible_user" },
    config: { provider: "acpx", acpxAgent: "antigravity", model: "caller-model", env: { GEMINI_API_KEY: "ambient", GEMINI_HOME: "/ambient" } },
  });
  homes.push(runtime.home!);
  runtimes.push(runtime);
  return runtime;
}
beforeEach(() => {
  account.credential = credential(); account.epoch = 4; account.version = 8; account.status = "active"; account.locks = [];
  account.refs = [{ configPath: "ai.credential", secretId: "22222222-2222-4222-8222-222222222222", versionSelector: "latest" }];
  account.rotation.mockReset().mockResolvedValue(undefined);
  account.journal = undefined;
  account.journalWrite.mockReset().mockImplementation(async value => { account.journal = value; });
});
afterEach(async () => {
  account.journalWrite.mockImplementation(async value => { account.journal = value; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("userinfo")
    ? { email_verified: true, email: "alice@example.test" } : { access_token: "fixture-access", token_type: "Bearer" })));
  for (const runtime of runtimes.splice(0)) await runtime.cleanup().catch(() => undefined);
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("managed Antigravity subscription projection and writeback", () => {
  it("returns a bounded cleanup diagnostic and retains the selected home until native retirement and refresh handoff", async () => {
    let confirmRetirement!: () => void;
    const retired = new Promise<void>(resolve => { confirmRetirement = resolve; });
    let home = "", token = "";
    const result = await withManagedAiProbe(database(), {
      companyId: "44444444-4444-4444-8444-444444444444", agentId: "55555555-5555-4555-8555-555555555555", responsibleUserId: "alice",
      adapterType: "paperclip_runner", binding: { provider: "google", method: "subscription", mode: "responsible_user" },
      config: { provider: "acpx", acpxAgent: "antigravity", model: "caller-model" },
    }, async runtime => {
      home = runtime.home!; homes.push(home);
      token = join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json");
      throw new NativeEnvironmentProbeCleanupError(retired, new Error("private fixture operation"), [new Error("fixture retirement is pending")]);
    }).catch(error => error);
    expect(result).toMatchObject({ status: 422, details: { code: "native_probe_cleanup_pending" } });
    expect(result.message).not.toContain("private fixture operation");
    expect(account.rotation).not.toHaveBeenCalled();
    expect(await readFile(token, "utf8")).toBe(credential());
    // The native owner completes its one refresh handoff before publishing exit.
    await writeFile(token, credential("retired-project"));
    confirmRetirement();
    await expect.poll(async () => access(home).then(() => false, () => true)).toBe(true);
    expect(account.rotation).toHaveBeenCalledExactlyOnceWith(account.refs[0].secretId,
      { value: credential("retired-project"), preserveAiSessionEpoch: true }, { userId: "alice" });
  });
  it("writes a private native token with explicit OAuth settings and saves same-token project resolution under both row locks", async () => {
    const runtime = await prepare(), provider = String(runtime.config.env.GEMINI_HOME), token = join(provider, "antigravity-acp", "acp_token.json");
    expect(runtime.config.env).toMatchObject({ GEMINI_API_KEY: "", GOOGLE_API_KEY: "", PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: "" });
    expect(await readFile(token, "utf8")).toBe(credential());
    expect((await stat(token)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(provider, "antigravity-acp", "settings.json"), "utf8"))).toEqual({ auth: { type: "oauth-personal" } });
    await expect(access(join(provider, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(token, credential("resolved-project"));
    await runtime.cleanup();
    expect(account.locks).toEqual(["grant:update", "secret:update"]);
    expect(account.rotation).toHaveBeenCalledWith(account.refs[0].secretId,
      { value: credential("resolved-project"), preserveAiSessionEpoch: true }, { userId: "alice" });
    await expect(access(runtime.home!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["revoked", "remapped", "epoch", "version", "concurrent-refresh"] as const)("discards stale refreshes when the selected credential is %s", async change => {
    const runtime = await prepare(), token = join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json");
    await writeFile(token, credential("stale-project"));
    if (change === "revoked") account.status = "revoked";
    if (change === "remapped") account.refs = [{ ...account.refs[0], secretId: "66666666-6666-4666-8666-666666666666" }];
    if (change === "epoch") account.epoch += 1;
    if (change === "version") account.version += 1;
    if (change === "concurrent-refresh") account.credential = credential("saved-newer-project");
    await runtime.cleanup();
    expect(account.rotation).not.toHaveBeenCalled();
    await expect(access(runtime.home!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("transfers a retired refresh to the durable journal when the database write fails", async () => {
    const runtime = await prepare(), token = join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json");
    await writeFile(token, credential("resolved-project"));
    account.rotation.mockRejectedValueOnce(new Error("fixture database write failure"));
    await expect(runtime.cleanup()).rejects.toMatchObject({ cause: { message: "fixture database write failure" } });
    expect(account.journal).toMatchObject({ provider: "google", value: credential("resolved-project"),
      google: { sessionEpoch: 4, baseVersion: 8, verified: true, accountEmail: "alice@example.test" } });
    expect(account.rotation).toHaveBeenCalledTimes(1);
    await expect(access(runtime.home!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retains the private refresh home when encrypted journal storage fails", async () => {
    const runtime = await prepare(), token = join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json");
    await writeFile(token, credential("resolved-project"));
    account.journalWrite.mockRejectedValueOnce(new Error("fixture journal unavailable"));
    await expect(runtime.cleanup()).rejects.toThrow("fixture journal unavailable");
    expect(await readFile(token, "utf8")).toBe(credential("resolved-project"));
    expect(account.rotation).not.toHaveBeenCalled();
  });
  it("finishes partial removal after durable handoff without rereading a removed token", async () => {
    const runtime = await prepare(), token = join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json");
    await writeFile(token, credential("resolved-project"));
    account.rotation.mockRejectedValueOnce(new Error("fixture database unavailable"));
    const realRm = fs.rm.bind(fs);
    let unavailable = true;
    const remove = vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
      if (unavailable && args[0] === runtime.home) {
        await realRm(token, { force: true });
        throw new Error("fixture partial removal");
      }
      return realRm(...args);
    });
    try {
      await expect(runtime.cleanup()).rejects.toThrow("fixture partial removal");
      expect(account.journal).toMatchObject({ value: credential("resolved-project"), google: { verified: true } });
      unavailable = false;
      await runtime.cleanup();
      await expect(access(runtime.home!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(account.rotation).toHaveBeenCalledOnce();
    } finally { unavailable = false; remove.mockRestore(); }
  });
  it("retains the latest verified rotation when replacing its earlier journal fails", async () => {
    const runtime = await prepare(), token = join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json");
    await writeFile(token, credential("resolved-project", "fixture-first-rotation"));
    const request = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "fixture-access", token_type: "Bearer", refresh_token: "fixture-latest-rotation" }))
      .mockResolvedValueOnce(Response.json({ email_verified: true, email: "alice@example.test" }));
    vi.stubGlobal("fetch", request);
    account.journalWrite.mockImplementationOnce(async value => { account.journal = value; })
      .mockRejectedValueOnce(new Error("fixture latest journal unavailable"));
    await expect(runtime.cleanup()).rejects.toThrow();
    expect(await readFile(token, "utf8")).toBe(credential("resolved-project", "fixture-latest-rotation"));
    expect(account.journal).toMatchObject({ value: credential("resolved-project", "fixture-first-rotation"), google: { verified: false } });
    expect(account.rotation).not.toHaveBeenCalled();
    account.rotation.mockImplementationOnce(async (_secretId, input) => { account.credential = input.value; account.version += 1; });
    request.mockResolvedValueOnce(Response.json({ access_token: "fixture-access", refresh_token: "fixture-retry-rotation" }))
      .mockResolvedValueOnce(Response.json({ email_verified: true, email: "alice@example.test" }));
    const next = await prepare();
    expect(new URLSearchParams(request.mock.calls[2][1].body).get("refresh_token")).toBe("fixture-latest-rotation");
    expect(await readFile(join(String(next.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json"), "utf8"))
      .toBe(credential("resolved-project", "fixture-retry-rotation"));
    await expect(access(runtime.home!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["alice@example.test", "other@example.test"])("verifies %s before a changed refresh token can reach the database", async email => {
    const runtime = await prepare(), token = join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json");
    await writeFile(token, credential("resolved-project", "fixture-rotated-refresh"));
    const request = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "fixture-access", token_type: "Bearer" }))
      .mockResolvedValueOnce(Response.json({ email_verified: true, email }));
    vi.stubGlobal("fetch", request);
    if (email === "alice@example.test") {
      await runtime.cleanup();
      expect(account.rotation).toHaveBeenCalledWith(account.refs[0].secretId,
        { value: credential("resolved-project", "fixture-rotated-refresh"), preserveAiSessionEpoch: true }, { userId: "alice" });
      await expect(access(runtime.home!)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(runtime.cleanup()).rejects.toThrow("The refreshed Google account does not match the selected connection.");
      expect(account.rotation).not.toHaveBeenCalled();
      expect(account.locks).toEqual([]);
      expect(account.journal).toMatchObject({ provider: "google", google: { verified: false }, value: credential("resolved-project", "fixture-rotated-refresh") });
      expect(await readFile(token, "utf8")).toBe(credential("resolved-project", "fixture-rotated-refresh"));
    }
  });
});
