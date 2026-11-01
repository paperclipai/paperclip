import { randomUUID } from "node:crypto";
import { access, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, closeRegisteredClients, companies, companyMemberships, companySecrets, companySecretVersions,
  connectionGrants, createDb, userSecretDefinitions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { managedAiSessionFingerprintConfig, prepareManagedAiRuntime, withManagedAiProbe } from "../services/ai-connection-runtime.js";
import { secretService } from "../services/secrets.js";
import { quotaCredentialHash, quotaCredentialRecovery, quotaCredentialRecoveryPath } from "../services/quota-credential-recovery.js";
import * as codexAdapter from "@paperclipai/adapter-codex-local/server";
import * as workspaceLocks from "@paperclipai/adapter-utils/workspace-restore-merge";
import { reconcileRetainedGoogleCleanup, retainGoogleCredentialCleanup } from "../services/retained-google-credential-cleanup.js";

// External runs require an already migrated dedicated database ending in _test.
// The shared helper rejects ordinary application database names and overrides.
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_GOOGLE_AI_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping Google AI PostgreSQL integration on this host: ${support.reason ?? "embedded PostgreSQL unavailable"}`);
const describeDatabase = support.supported ? describe : describe.skip;

const googleCredential = (project?: string, token = "fixture-google-refresh") => JSON.stringify({
  client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", client_secret: "fixture-client-secret",
  refresh_token: token, token_uri: "https://oauth2.googleapis.com/token", scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"],
  ...(project ? { project_id: project } : {}),
});

describeDatabase("Google AI connection authority with real PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let embedded: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let isolatedHome: ReturnType<typeof createIsolatedTestHome>;
  let request: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

  beforeAll(async () => {
    isolatedHome = createIsolatedTestHome();
    vi.stubEnv("PAPERCLIP_HOME", isolatedHome.home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "google-ai-real-db");
    if (!external) embedded = await startEmbeddedPostgresTestDatabase("paperclip-google-ai-db-");
    db = createDb(external ?? embedded!.connectionString);
    request = vi.spyOn(globalThis, "fetch");
  }, 90_000);
  beforeEach(() => { request.mockReset().mockRejectedValue(new Error("Provider network is forbidden in database authority tests")); });
  afterAll(async () => {
    request?.mockRestore();
    if (external) await closeRegisteredClients(external);
    await db?.$client.end();
    await embedded?.cleanup();
    vi.unstubAllEnvs();
    isolatedHome?.cleanup();
  });

  async function fixture(method: "api_key" | "subscription", allAgents = true) {
    const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID(), peerAgentId = randomUUID(), foreignAgentId = randomUUID();
    const owner = `google-owner-${randomUUID()}`, otherUser = `google-other-${randomUUID()}`;
    await db.insert(companies).values([
      { id: companyId, name: "Google AI authority fixture", issuePrefix: `GAF${companyId.slice(0, 8)}` },
      { id: otherCompanyId, name: "Foreign Google AI fixture", issuePrefix: `GAX${otherCompanyId.slice(0, 8)}` },
    ]);
    await db.insert(authUsers).values([owner, otherUser].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() })));
    await db.insert(companyMemberships).values([
      ...[owner, otherUser].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })),
      { companyId: otherCompanyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Selected Google agent", adapterType: "paperclip_runner" },
      { id: peerAgentId, companyId, name: "Uninstalled peer", adapterType: "paperclip_runner" },
      { id: foreignAgentId, companyId: otherCompanyId, name: "Foreign agent", adapterType: "paperclip_runner" },
    ]);
    const service = aiConnectionService(db);
    const credential = method === "api_key" ? "fixture-selected-google-api-key" : googleCredential();
    const intent = { provider: "google" as const, method, ownership: "personal" as const, name: "Fixture Google account", allAgents,
      agentIds: allAgents ? [] : [agentId], ...(method === "api_key" ? { apiKey: credential } : { loginSessionId: "verified-fixture" }) };
    const saved = await service.save(companyId, owner, intent, credential, undefined, new Date(), undefined,
      method === "subscription" ? "verified-owner@example.test" : undefined);
    await service.setDefault(companyId, owner, saved.grantId);
    const binding = { provider: "google", method, mode: "responsible_user" } as const;
    const config = { provider: "acpx", acpxAgent: "antigravity", model: "caller-selected-model", env: {
      GEMINI_API_KEY: "fixture-ambient-key", GOOGLE_API_KEY: "fixture-other-key", GEMINI_HOME: "/ambient/home",
      GOOGLE_APPLICATION_CREDENTIALS: "/ambient/google.json", PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: "fixture-forged-inline",
    } };
    const select = { companyId, userId: owner, agentId, adapterType: "paperclip_runner", runnerProvider: "acpx", acpxAgent: "antigravity", model: config.model, binding };
    const runtime = { companyId, responsibleUserId: owner, agentId, adapterType: "paperclip_runner", config, binding };
    const selection = await service.select(select);
    const secretId = selection.grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!.secretId;
    return { companyId, otherCompanyId, agentId, peerAgentId, foreignAgentId, owner, otherUser, saved, service, select, runtime, selection, secretId, credential, intent };
  }

  it.each(["api_key", "subscription"] as const)("prepares the selected %s from a personal encrypted secret and preserves provider identity across private homes", async method => {
    const f = await fixture(method);
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, f.secretId));
    const [definition] = await db.select().from(userSecretDefinitions).where(eq(userSecretDefinitions.id, secret.userSecretDefinitionId!));
    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id));
    expect(secret).toMatchObject({ companyId: f.companyId, scope: "user", ownerUserId: f.owner, provider: "local_encrypted", latestVersion: 1 });
    expect(definition).toMatchObject({ companyId: f.companyId, key: `ai_${f.saved.grantId.replaceAll("-", "_")}` });
    expect(versions[0].material).toMatchObject({ scheme: "local_encrypted_v1" });
    expect(JSON.stringify(versions[0].material)).not.toContain(method === "api_key" ? f.credential : "fixture-google-refresh");
    expect(await f.service.credential(f.selection)).toBe(f.credential);
    expect(await secretService(db).listCurrentUserSecretValues(f.companyId, f.otherUser)).toMatchObject([{ definition: { id: definition.id }, secret: null }]);
    const first = await prepareManagedAiRuntime(db, f.runtime), second = await prepareManagedAiRuntime(db, f.runtime);
    try {
      expect(first.attribution).toMatchObject({ provider: "google", method, connectionId: f.saved.connectionId, grantId: f.saved.grantId });
      expect(first.home).not.toBe(second.home);
      expect(await realpath(first.home!)).toBe(first.home);
      expect(await realpath(String(first.config.env.GEMINI_HOME))).toBe(first.config.env.GEMINI_HOME);
      expect(first.config.env).toMatchObject({ GOOGLE_API_KEY: "", GOOGLE_APPLICATION_CREDENTIALS: "", PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: "",
        GEMINI_API_KEY: method === "api_key" ? f.credential : "" });
      const directory = join(String(first.config.env.GEMINI_HOME), "antigravity-acp");
      expect(JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))).toEqual({ auth: { type: method === "api_key" ? "gemini-api-key" : "oauth-personal" } });
      if (method === "subscription") expect(await readFile(join(directory, "acp_token.json"), "utf8")).toBe(f.credential);
      else await expect(access(join(directory, "acp_token.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(managedAiSessionFingerprintConfig(first.config, first.home)).toEqual(managedAiSessionFingerprintConfig(second.config, second.home));
      expect(request).not.toHaveBeenCalled();
    } finally { await Promise.all([first.cleanup(), second.cleanup()]); }
    await expect(access(first.home!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(second.home!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["api_key", "subscription"] as const)("enforces the %s owner's membership, personal audience, company, and agent installation", async method => {
    const f = await fixture(method, false);
    const explicit = { provider: "google", method, mode: "delegated", ...f.saved } as const;
    expect((await f.service.select({ ...f.select, binding: explicit })).grant.id).toBe(f.saved.grantId);
    await expect(f.service.select({ ...f.select, binding: { ...explicit, mode: "shared" } })).rejects.toThrow("company-shared account");
    await expect(f.service.select({ ...f.select, userId: f.otherUser, binding: explicit })).rejects.toThrow("not shared");
    await expect(f.service.select({ ...f.select, companyId: f.otherCompanyId, agentId: f.foreignAgentId, binding: explicit })).rejects.toThrow("unavailable");
    await expect(f.service.select({ ...f.select, agentId: f.peerAgentId })).rejects.toThrow("not permitted for this agent");
    await expect(f.service.save(f.companyId, f.owner, { ...f.intent, connectionId: undefined, agentIds: [f.foreignAgentId] }, f.credential)).rejects.toThrow("Agent does not belong");
    const credentials = await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.companyId));
    expect(credentials).toHaveLength(1); // The rejected foreign-agent save rolled back its secret too.
    await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.owner)));
    await expect(prepareManagedAiRuntime(db, f.runtime)).rejects.toThrow("not an active company member");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["api_key", "subscription"] as const)("refuses revoked %s defaults without falling back to another saved credential", async method => {
    const f = await fixture(method);
    await f.service.save(f.companyId, f.owner, { ...f.intent, name: "Unselected fallback", connectionId: undefined }, f.credential);
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.id, f.saved.grantId));
    await expect(prepareManagedAiRuntime(db, f.runtime)).rejects.toThrow("Reconnect or validate");
    expect((await f.service.list(f.companyId, f.owner)).find(row => row.grantId === f.saved.grantId)).toMatchObject({ status: "revoked", isDefault: true });
    expect(request).not.toHaveBeenCalled();
  });

  it("persists same-account project discovery with a new encrypted revision while preserving the session epoch", async () => {
    const f = await fixture("subscription");
    const [before] = await db.select().from(companySecrets).where(eq(companySecrets.id, f.secretId));
    const runtime = await prepareManagedAiRuntime(db, f.runtime);
    await writeFile(join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json"), googleCredential("resolved-project"));
    await runtime.cleanup();
    const [after] = await db.select().from(companySecrets).where(eq(companySecrets.id, f.secretId));
    expect(after.latestVersion).toBe(before.latestVersion + 1);
    expect(after.aiSessionEpoch).toBe(before.aiSessionEpoch);
    expect(await f.service.credential(await f.service.select(f.select))).toBe(googleCredential("resolved-project"));
    expect(request).not.toHaveBeenCalled();
  });

  it("waits for a real secret-row lock and preserves an authorized rotation committed while cleanup is blocked", async () => {
    const f = await fixture("subscription");
    const runtime = await prepareManagedAiRuntime(db, f.runtime);
    await writeFile(join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json"), googleCredential("stale-run-project"));
    let acquired!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await secretService(tx).rotate(f.secretId, { value: googleCredential("authorized-project") }, { userId: f.owner });
      acquired();
      await released;
    });
    await locked;
    const cleanup = runtime.cleanup();
    try {
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const rows = await db.execute(sql`select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%company_secrets%'`);
        waiting = rows.length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
    } finally { release(); }
    await holder;
    await cleanup;
    expect(await f.service.credential(await f.service.select(f.select))).toBe(googleCredential("authorized-project"));
    await expect(access(runtime.home!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["rotation", "commit", "lost_reply"] as const)("recovers a retired Google refresh after %s failure and loss of the old controller home", async failure => {
    const f = await fixture("subscription");
    const runtime = await prepareManagedAiRuntime(db, f.runtime);
    const replacement = googleCredential("recovered-project");
    await writeFile(join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json"), replacement);
    const journal = quotaCredentialRecovery(f.companyId, f.saved.grantId);
    const transaction = db.transaction.bind(db);
    const interrupted = failure === "lost_reply" ? vi.spyOn(db, "transaction").mockImplementationOnce(async (work, config) => {
      await transaction(work, config);
      throw new Error("fixture lost Google commit response");
    }) : undefined;
    if (!interrupted) await db.execute(sql.raw(`create function reject_google_recovery() returns trigger language plpgsql as $$ begin
      if new.secret_id = '${f.secretId}'::uuid then raise exception 'fixture Google writeback failure'; end if; return new; end $$;
      create ${failure === "commit" ? "constraint " : ""}trigger reject_google_recovery ${failure === "commit" ? "after" : "before"} insert on company_secret_versions
      ${failure === "commit" ? "deferrable initially deferred" : ""} for each row execute function reject_google_recovery();`));
    try {
      await expect(runtime.cleanup()).rejects.toThrow();
      await expect(access(runtime.home!)).rejects.toMatchObject({ code: "ENOENT" });
      const encrypted = await readFile(quotaCredentialRecoveryPath(f.companyId, f.saved.grantId), "utf8");
      expect(encrypted).not.toContain("fixture-google-refresh");
      expect(encrypted).not.toContain("recovered-project");
      expect(await journal.read()).toMatchObject({ provider: "google", value: replacement });
      // A fresh service must defer while the durable replacement cannot commit.
      if (!interrupted) await expect(prepareManagedAiRuntime(db, f.runtime)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
    } finally {
      if (interrupted) interrupted.mockRestore();
      else await db.execute(sql`drop trigger reject_google_recovery on company_secret_versions; drop function reject_google_recovery()`);
    }
    // The retired owner's ephemeral files and JS callbacks are no longer needed.
    await rm(runtime.home!, { recursive: true, force: true });
    const recovered = await prepareManagedAiRuntime(db, f.runtime);
    try {
      expect(await readFile(join(String(recovered.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json"), "utf8")).toBe(replacement);
      expect(await journal.read()).toBeNull();
      expect(request).not.toHaveBeenCalled();
      expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, f.secretId))).toHaveLength(2);
    } finally { await recovered.cleanup(); await journal.clear(); }
  });

  async function retiredJournal(f: Awaited<ReturnType<typeof fixture>>, value: string, verified = true) {
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, f.secretId));
    const journal = quotaCredentialRecovery(f.companyId, f.saved.grantId);
    await journal.write({ companyId: f.companyId, grantId: f.saved.grantId, connectionId: f.saved.connectionId,
      secretId: f.secretId, provider: "google", baseHash: quotaCredentialHash(f.credential), value,
      google: { sessionEpoch: secret.aiSessionEpoch, baseVersion: secret.latestVersion,
        versionSelector: "latest", accountEmail: "verified-owner@example.test", verified } });
    return journal;
  }

  it("settles a failed probe journal before another provider starts for the same Google account", async () => {
    const f = await fixture("subscription");
    const replacement = googleCredential("recovered-probe-project");
    const journalPath = quotaCredentialRecoveryPath(f.companyId, f.saved.grantId);
    const realOpen = fs.open.bind(fs);
    let unavailable = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (unavailable && String(args[0]).startsWith(`${journalPath}.`) && String(args[0]).endsWith(".tmp")) {
        throw new Error("fixture Google journal unavailable");
      }
      return realOpen(...args);
    });
    let originalHome: string | undefined;
    const provider = vi.fn(async (runtime: Awaited<ReturnType<typeof prepareManagedAiRuntime>>) => {
      expect(await readFile(join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json"), "utf8")).toBe(replacement);
    });
    try {
      await expect(withManagedAiProbe(db, f.runtime, async runtime => {
        originalHome = runtime.home;
        await writeFile(join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json"), replacement);
        unavailable = true;
      })).rejects.toThrow("fixture Google journal unavailable");
      await expect(access(originalHome!)).resolves.toBeUndefined();
      await expect(withManagedAiProbe(db, f.runtime, provider)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
      expect(provider).not.toHaveBeenCalled();
      expect(await f.service.credential(await f.service.select(f.select))).toBe(f.credential);
      unavailable = false;
      await withManagedAiProbe(db, f.runtime, provider);
      expect(provider).toHaveBeenCalledOnce();
      await expect(access(originalHome!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await f.service.credential(await f.service.select(f.select))).toBe(replacement);
      expect(await quotaCredentialRecovery(f.companyId, f.saved.grantId).read()).toBeNull();
      expect(request).not.toHaveBeenCalled();
    } finally { unavailable = false; open.mockRestore(); }
  });

  it("lets retirement cleanup acquire the credential lock before another account use joins it", async () => {
    const f = await fixture("subscription"), runtime = await prepareManagedAiRuntime(db, f.runtime);
    const replacement = googleCredential("retirement-concurrency-project");
    await writeFile(join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json"), replacement);
    const scope = { companyId: f.companyId, accountKey: f.saved.grantId };
    let entered!: () => void, release!: () => void, lockEntered!: () => void;
    const cleanupEntered = new Promise<void>(resolve => { entered = resolve; });
    const permitCleanup = new Promise<void>(resolve => { release = resolve; });
    const credentialLockEntered = new Promise<void>(resolve => { lockEntered = resolve; });
    const cleanup = async () => { entered(); await permitCleanup; await runtime.cleanup(); };
    retainGoogleCredentialCleanup({ scope, cleanup, retired: Promise.resolve() });
    await cleanupEntered;
    const originalLock = codexAdapter.withAccountHomeSecretMutationLock;
    const originalDirectoryLock = workspaceLocks.withDirectoryMergeLock;
    let requestedLock = false;
    const lock = vi.spyOn(codexAdapter, "withAccountHomeSecretMutationLock").mockImplementation((env, company, callback) => {
      if (requestedLock) return originalLock(env, company, callback);
      requestedLock = true;
      return originalLock(env, company, async () => { lockEntered(); return callback(); });
    });
    // Exercise the real filesystem mutex with its existing bounded test seam;
    // a regression reports contention promptly instead of waiting 30 seconds.
    const directoryLock = vi.spyOn(workspaceLocks, "withDirectoryMergeLock").mockImplementation((directory, callback, env, operation) =>
      originalDirectoryLock(directory, callback, env, operation, 100));
    const using = f.service.runtimeCredential(f.selection);
    void using.catch(() => undefined);
    try {
      if (requestedLock) await credentialLockEntered;
      release();
      await expect(using).resolves.toBe(replacement);
      await expect(access(runtime.home!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await f.service.credential(await f.service.select(f.select))).toBe(replacement);
      expect(request).not.toHaveBeenCalled();
    } finally {
      release(); await Promise.allSettled([using]);
      lock.mockRestore(); directoryLock.mockRestore();
      await reconcileRetainedGoogleCleanup(scope);
      await runtime.cleanup();
      await quotaCredentialRecovery(f.companyId, f.saved.grantId).clear();
    }
  });

  it("defers credential use when another retained owner arrives before lock acquisition", async () => {
    const f = await fixture("subscription"), scope = { companyId: f.companyId, accountKey: f.saved.grantId };
    let retire!: () => void;
    const retired = new Promise<void>(resolve => { retire = resolve; });
    const cleanup = vi.fn(async () => {});
    const originalLock = codexAdapter.withAccountHomeSecretMutationLock;
    const lock = vi.spyOn(codexAdapter, "withAccountHomeSecretMutationLock").mockImplementationOnce((env, company, callback) => {
      retainGoogleCredentialCleanup({ scope, cleanup, retired });
      return originalLock(env, company, callback);
    });
    try {
      await expect(f.service.runtimeCredential(f.selection)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
      expect(cleanup).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally { lock.mockRestore(); retire(); await reconcileRetainedGoogleCleanup(scope); }
  });

  it("does not join another retirement from cleanup that already holds the credential lock", async () => {
    const f = await fixture("subscription"), scope = { companyId: f.companyId, accountKey: f.saved.grantId };
    let retire!: () => void, entered!: () => void;
    const retired = new Promise<void>(resolve => { retire = resolve; });
    const cleanupEntered = new Promise<void>(resolve => { entered = resolve; });
    let failedLock = false, finished = false;
    const originalDirectoryLock = workspaceLocks.withDirectoryMergeLock;
    const directoryLock = vi.spyOn(workspaceLocks, "withDirectoryMergeLock").mockImplementation((directory, callback, env, operation) =>
      originalDirectoryLock(directory, callback, env, operation, 100));
    retainGoogleCredentialCleanup({ scope, retired, cleanup: async () => {
      entered();
      try { await codexAdapter.withAccountHomeSecretMutationLock(undefined, f.companyId, async () => { finished = true; }); }
      catch (error) { failedLock = true; throw error; }
    } });
    try {
      await codexAdapter.withAccountHomeSecretMutationLock(undefined, f.companyId, async () => {
        retire(); await cleanupEntered;
        await expect(f.service.runtimeCredential(f.selection, { credentialLockHeld: true }))
          .rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
        expect(failedLock).toBe(false);
        expect(finished).toBe(false);
      });
    } finally {
      retire(); await reconcileRetainedGoogleCleanup(scope); directoryLock.mockRestore();
    }
    expect(finished).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["epoch", "version", "account"] as const)("discards a retired journal after the selected Google %s changes", async change => {
    const f = await fixture("subscription");
    const journal = await retiredJournal(f, googleCredential("stale-retired-project", "fixture-stale-rotated-refresh"), false);
    if (change === "account") await db.update(connectionGrants).set({ providerTenant: { name: "reconnected-owner@example.test" } }).where(eq(connectionGrants.id, f.saved.grantId));
    else await secretService(db).rotate(f.secretId, { value: f.credential, preserveAiSessionEpoch: change === "version" }, { userId: f.owner });
    const runtime = await prepareManagedAiRuntime(db, f.runtime);
    try {
      expect(await readFile(join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json"), "utf8")).toBe(f.credential);
      expect(await journal.read()).toBeNull();
      expect(request).not.toHaveBeenCalled();
    } finally { await runtime.cleanup(); await journal.clear(); }
  });

  it.each(["verified-owner@example.test", "other@example.test"])("verifies %s before an unverified retired refresh can be recovered", async email => {
    const f = await fixture("subscription");
    const replacement = googleCredential("recovered-project", "fixture-retired-rotated-refresh");
    const journal = await retiredJournal(f, replacement, false);
    request.mockResolvedValueOnce(Response.json({ access_token: "fixture-access", token_type: "Bearer" }))
      .mockResolvedValueOnce(Response.json({ email_verified: true, email }));
    if (email === "verified-owner@example.test") {
      const runtime = await prepareManagedAiRuntime(db, f.runtime);
      try {
        expect(await readFile(join(String(runtime.config.env.GEMINI_HOME), "antigravity-acp", "acp_token.json"), "utf8")).toBe(replacement);
        expect(await journal.read()).toBeNull();
      } finally { await runtime.cleanup(); await journal.clear(); }
    } else {
      const failure = await prepareManagedAiRuntime(db, f.runtime).catch(error => error);
      expect(failure).toMatchObject({ details: { code: "ai_connection_busy" } });
      expect(failure.message).not.toContain("other@example.test");
      expect(await f.service.credential(await f.service.select(f.select))).toBe(f.credential);
      expect(await journal.read()).toMatchObject({ value: replacement, google: { verified: false } });
      await journal.clear();
    }
    expect(request).toHaveBeenCalledTimes(2);
  });
});
