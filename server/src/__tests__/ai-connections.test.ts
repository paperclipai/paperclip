import { connectionIntentService } from "../services/connection-intents.js";
import { connectionIntentDeliveryService } from "../services/connection-intent-delivery.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { localAiLoginService } from "../services/local-ai-login.js";
// Background plan observations have their own provider-fixture coverage. Runtime
// auth tests must not send the selected fixture credentials to a real provider.
vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn().mockResolvedValue(undefined) }));
import * as localCredentials from "../services/local-ai-credentials.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { promises as fs } from "node:fs";
import { mkdtemp, realpath, rm, access, readFile, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { createDb, companies, agents, agentTaskSessions, heartbeatRuns, companyMemberships, connectionGrants, toolApplications, connectionGrantDelegations, connectionGrantMembers, toolConnections, toolConnectionInstalls, aiConnectionDefaults, aiProviderDefaults, adapterAuthSessions, environments, issues, issueThreadInteractions, issueRecoveryActions, connectionIntentDeliveries, agentWakeupRequests, companySecrets, companySecretVersions, userSecretDefinitions, principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { fetchCompanyQuotaWindows } from "../services/quota-windows.js";
import { quotaCredentialRecoveryPath, quotaCredentialRecovery, quotaCredentialHash } from "../services/quota-credential-recovery.js";
import { readAiConnectionConfigurationFailure } from "../services/ai-connection-configuration-failure.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { syncConnectionCredentialBindings } from "../services/connection-credential-bindings.js";
import * as codexAdapter from "@paperclipai/adapter-codex-local/server";
import { WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "@paperclipai/adapter-utils/workspace-restore-merge";
import * as executionTarget from "@paperclipai/adapter-utils/execution-target";
import { prepareManagedAiRuntime, withManagedAiProbe, assertManagedAiProjectAuth, isAiConnectionBusy } from "../services/ai-connection-runtime.js";
import { execute as executeGemini, testEnvironment as testGeminiEnvironment } from "@paperclipai/adapter-gemini-local/server";
import { toolAccessService } from "../services/tool-access.js";
import { secretService } from "../services/secrets.js";
import { resolveExecutionRunAdapterConfig } from "../services/heartbeat.js";
import { aiConnectionBindingSchema, connectionPurposeTransportSchema, createAiConnectionSchema, isAiConnectionCompatible } from "@paperclipai/shared";
import express from "express";
import request from "supertest";
import { aiConnectionRoutes, canInstallSharedAiConnectionForNewAgent, responsibleUserForAiRequest } from "../routes/ai-connections.js";
import { validateAiApiKey } from "../routes/ai-connections.js";
import { errorHandler } from "../middleware/error-handler.js";
vi.mock("../services/local-ai-browser-login.js", () => ({
  startLocalBrowserLogin: () => ({ authorizationUrl: "https://auth.openai.com/codex/device", code: "ABCD-EFGHJ", abort: () => {} }),
}));

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const otherCompanyId = randomUUID();
const agentId = randomUUID();
let service: ReturnType<typeof aiConnectionService>;
const binding = { provider: "anthropic", method: "api_key", mode: "responsible_user" } as const;
const input = { companyId, agentId, adapterType: "claude_local", binding };
const create = (userId: string, name: string, ownership: "personal" | "shared" = "personal") => service.save(companyId, userId, { provider: "anthropic", method: "api_key", ownership, name, apiKey: "fixture", agentIds: [], allAgents: true }, `fixture-${name}`);

beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-tests-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-connection-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-ai-db-");
  db = createDb(database.connectionString);
  service = aiConnectionService(db);
  await db.insert(companies).values([{ id: companyId, name: "AI connection tests", issuePrefix: "AIT" }, { id: otherCompanyId, name: "Other", issuePrefix: "AIO" }]);
  await db.insert(agents).values({ id: agentId, companyId, name: "Nova", adapterType: "claude_local" });
  await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

describe("managed AI connections", () => {
  it("marks explicit AI selection rejections without changing their HTTP contract", async () => {
    const owner = "selection-blocker-owner";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const expectSelectionFailure = async (promise: Promise<unknown>, reason: string) => {
      const error = await promise.catch((error: unknown) => error);
      expect(error).toMatchObject({ status: 422, details: { code: reason } });
      expect(readAiConnectionConfigurationFailure(error)).toBe(reason);
    };
    await expectSelectionFailure(service.select({ ...input, userId: null }), "ai_connection_responsible_user_missing");
    await expectSelectionFailure(service.select({ ...input, userId: owner, adapterType: "codex_local" }), "ai_connection_incompatible");
    await expectSelectionFailure(service.select({ ...input, userId: owner }), "ai_connection_default_missing");
    await expectSelectionFailure(service.select({ ...input, userId: owner, binding: {
      ...binding, mode: "delegated", connectionId: randomUUID(), grantId: randomUUID(),
    } }), "ai_connection_missing");
    const account = await create(owner, "Selection blocker account");
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, account.grantId));
    await expectSelectionFailure(service.select({ ...input, userId: owner }), "ai_connection_unavailable");
  });

  it("persists first-time recovery directories before consuming a single-use token", async () => {
    const owner = "quota-durable-path";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const original = JSON.stringify({ tokens: { account_id: owner, access_token: "expired", refresh_token: "single-use" } });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, original);
    const [row] = await service.quotaAccounts(companyId, owner);
    const file = quotaCredentialRecoveryPath(companyId, row.grant.id);
    const recoveryRoot = path.dirname(path.dirname(file));
    await expect(access(recoveryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const synced: string[] = [];
    let rejectRoot = true;
    const realOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        if (rejectRoot && args[0] === recoveryRoot) throw new Error("Injected recovery directory flush failure");
        await sync(); synced.push(String(args[0]));
      });
      return handle;
    });
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      expect(synced).toContain(recoveryRoot);
      expect(synced).toContain(path.dirname(recoveryRoot));
      return Response.json({ access_token: "fresh-durable", refresh_token: "replacement-durable" });
    });
    try {
      await expect(service.refreshQuotaCredential(row, original, new AbortController().signal)).rejects.toThrow("Injected recovery directory flush failure");
      expect(request).not.toHaveBeenCalled();
      expect(await service.credential(row)).toBe(original);
      rejectRoot = false;
      await service.refreshQuotaCredential(row, original, new AbortController().signal);
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await service.credential(row))).toMatchObject({ tokens: { access_token: "fresh-durable", refresh_token: "replacement-durable" } });
    } finally { open.mockRestore(); request.mockRestore(); }
  });

  it.each(["timeout", "unexpected"] as const)("classifies a manual probe's %s lock failure before starting the provider", async (kind) => {
    const owner = `manual-probe-lock-${kind}`;
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const auth = JSON.stringify({ tokens: { account_id: owner, access_token: "valid-access", refresh_token: "valid-refresh" } });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, auth);
    const [row] = await service.quotaAccounts(companyId, owner);
    const probe = vi.fn().mockResolvedValue("ok");
    const input = { companyId, agentId, responsibleUserId: owner, adapterType: "codex_local",
      binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, config: {} };
    const failure = Object.assign(new Error("injected private lock diagnostic"), { code: kind === "timeout" ? WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE : "EACCES" });
    const lock = vi.spyOn(codexAdapter, "withAccountHomeSecretMutationLock").mockRejectedValueOnce(failure);
    try {
      const error = await withManagedAiProbe(db, input, probe).then(() => { throw new Error("Probe must not start"); }, error => error);
      if (kind === "timeout") {
        expect(isAiConnectionBusy(error)).toBe(true);
        expect(error).toMatchObject({ status: 422, message: "AI credentials are being updated. Retry shortly.", details: { code: "ai_connection_busy" } });
      } else expect(error).toBe(failure);
      expect(probe).not.toHaveBeenCalled();
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id)))[0].status).toBe("active");
    } finally { lock.mockRestore(); }
    expect(await withManagedAiProbe(db, input, probe)).toBe("ok");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await service.credential(row)).toBe(auth);
  });

  it("keeps quota refresh outside a manual probe until its rotated credential is saved", async () => {
    const owner = "manual-probe-race";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (hour: string) => JSON.stringify({ tokens: { account_id: owner, id_token: "identity", access_token: `access-${hour}`, refresh_token: `refresh-${hour}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, auth("10"));
    const [row] = await service.quotaAccounts(companyId, owner);
    const entered = deferredSignal(), release = deferredSignal();
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Quota must not exchange the probe's token"));
    const probing = withManagedAiProbe(db, { companyId, agentId, responsibleUserId: owner, adapterType: "codex_local",
      binding: { provider: "openai", method: "subscription", mode: "responsible_user" }, config: {} }, async runtime => {
      entered.resolve(); await release.promise;
      await writeFile(path.join(String(runtime.config.env.CODEX_HOME), "auth.json"), auth("11"));
    });
    let refreshing: Promise<string> | undefined;
    let lock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await entered.promise;
      lock = vi.spyOn(codexAdapter, "withAccountHomeSecretMutationLock");
      // Start outside the probe's async scope; it is a separate HTTP request.
      refreshing = service.refreshQuotaCredential(row, auth("10"), new AbortController().signal);
      await vi.waitFor(() => expect(lock).toHaveBeenCalled());
      expect(request).not.toHaveBeenCalled();
      release.resolve(); await probing;
      expect(await refreshing).toBe(auth("11"));
      expect(await service.credential(row)).toBe(auth("11"));
      expect(request).not.toHaveBeenCalled();
    } finally { release.resolve(); await Promise.allSettled([probing, refreshing]); lock?.mockRestore(); request.mockRestore(); }
  });

  it("rejects preparation when reconnect replaces the selected credential reference", async () => {
    const owner = "replaced-ref-owner";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (id: string) => JSON.stringify({ tokens: { account_id: id, access_token: id, refresh_token: id } });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, auth("old-account"));
    const [row] = await service.quotaAccounts(companyId, owner);
    const definition = await secretService(db).createUserSecretDefinition(companyId, { key: "replacement_credential", name: "Replacement", provider: "local_encrypted" }, { userId: owner });
    const replacement = await secretService(db).createCurrentUserSecretValue(companyId, owner, { definitionId: definition.id, value: auth("new-account") }, { userId: owner });
    const prepare = () => prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "codex_local",
      binding: { provider: "openai", method: "subscription", mode: "responsible_user" }, config: {} });
    const original = codexAdapter.withAccountHomeSecretMutationLock;
    const lock = vi.spyOn(codexAdapter, "withAccountHomeSecretMutationLock").mockImplementationOnce(async (env, company, callback) => {
      await db.update(connectionGrants).set({ credentialSecretRefs: row.grant.credentialSecretRefs.map(ref => ref.configPath === "ai.credential" ? { ...ref, secretId: replacement.id } : ref) }).where(eq(connectionGrants.id, row.grant.id));
      await syncConnectionCredentialBindings(db, row.connection);
      return original(env, company, callback);
    });
    try { await expect(prepare()).rejects.toThrow("AI credential changed during preparation"); }
    finally { lock.mockRestore(); }
    const runtime = await prepare();
    try {
      expect(runtime.sessionIdentity).toContain(replacement.id);
      expect(await readFile(path.join(String(runtime.config.env.CODEX_HOME), "auth.json"), "utf8")).toBe(auth("new-account"));
    } finally { await runtime.cleanup(); }
  });

  it("caches quota after a real secret read but invalidates credential rotation and revocation", async () => {
    const owner = "quota-cache-owner";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const account = await service.save(companyId, owner, { provider: "anthropic", method: "subscription", ownership: "personal", name: "Quota cache account", loginSessionId: "fixture", agentIds: [], allAgents: true }, "quota-cache-original");
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    const secretId = grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!.secretId;
    const [before] = await db.select().from(companySecrets).where(eq(companySecrets.id, secretId));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 42 } })));
    try {
      const first = await fetchCompanyQuotaWindows(db, companyId, owner);
      const [after] = await db.select().from(companySecrets).where(eq(companySecrets.id, secretId));
      expect(after.lastResolvedAt).not.toBeNull();
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      expect(first[0].ok).toBe(true);
      expect(await fetchCompanyQuotaWindows(db, companyId, owner)).toEqual(first);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await secretService(db).rotate(secretId, { value: "quota-cache-rotated" });
      const rotated = await fetchCompanyQuotaWindows(db, companyId, owner);
      expect(rotated[0].ok).toBe(true);
      expect(rotated[0].accountKey).not.toBe(first[0].accountKey);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer quota-cache-rotated" }) }));
      await db.update(userSecretDefinitions).set({ status: "disabled" }).where(eq(userSecretDefinitions.id, before.userSecretDefinitionId!));
      const disabled = await fetchCompanyQuotaWindows(db, companyId, owner);
      expect(disabled[0]).toMatchObject({ ok: false, errorFamily: "credentials_unavailable", windows: [] });
      expect(disabled[0].accountKey).not.toBe(rotated[0].accountKey);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      await db.update(userSecretDefinitions).set({ status: "active" }).where(eq(userSecretDefinitions.id, before.userSecretDefinitionId!));
      expect((await fetchCompanyQuotaWindows(db, companyId, owner))[0].ok).toBe(true);
      await db.update(companySecretVersions).set({ status: "disabled", revokedAt: new Date() }).where(and(eq(companySecretVersions.secretId, secretId), eq(companySecretVersions.version, 2)));
      const revoked = await fetchCompanyQuotaWindows(db, companyId, owner);
      expect(revoked[0].ok).toBe(false);
      expect(revoked[0].windows).toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally { fetchSpy.mockRestore(); }
  });

  it("caches refreshed quota under the saved grant and secret revision", async () => {
    const owner = "quota-refreshed-cache-owner";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const original = JSON.stringify({ tokens: { access_token: "expired-cache", refresh_token: "single-use", account_id: "cache-account" } });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: "Refreshed cache", loginSessionId: "fixture", agentIds: [], allAgents: true }, original);
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      if (String(url).endsWith("/oauth/token")) return Response.json({ access_token: "fresh-cache", refresh_token: "replacement" });
      if (new Headers(options?.headers).get("authorization") === "Bearer expired-cache") return new Response("Expired", { status: 401 });
      return Response.json({ rate_limit: { primary_window: { used_percent: 42 } } });
    });
    try {
      const first = await fetchCompanyQuotaWindows(db, companyId, owner);
      expect(first[0]).toMatchObject({ ok: true, windows: [{ usedPercent: 42 }] });
      expect(await fetchCompanyQuotaWindows(db, companyId, owner)).toEqual(first);
      expect(request).toHaveBeenCalledTimes(3); // rejected quota, OAuth, refreshed quota
    } finally { request.mockRestore(); }
  });

  it.each(["rotation", "secret_metadata", "activity", "commit"] as const)("recovers exchanged OAuth tokens after %s persistence failure without another exchange", async (failure) => {
    const owner = `quota-rollback-${failure}`;
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const original = JSON.stringify({ tokens: { access_token: `expired-${failure}`, refresh_token: "single-use", account_id: owner } });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, original);
    const [row] = await service.quotaAccounts(companyId, owner);
    const ref = row.grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    const table = failure === "secret_metadata" ? "company_secrets" : failure === "activity" ? "activity_log" : "company_secret_versions";
    const condition = failure === "secret_metadata" ? `new.id = '${ref.secretId}'::uuid and new.latest_version > old.latest_version` : failure === "activity" ? `new.action = 'ai_connection.credential_refreshed'` : `new.secret_id = '${ref.secretId}'::uuid`;
    await db.execute(sql.raw(`create function quota_save_failure() returns trigger language plpgsql as $$ begin
      if ${condition} then raise exception 'injected quota save failure'; end if; return new; end $$;
      create ${failure === "commit" ? "constraint " : ""}trigger quota_save_failure ${failure === "commit" ? "after" : "before"} ${failure === "secret_metadata" ? "update" : "insert"} on ${table}
      ${failure === "commit" ? "deferrable initially deferred" : ""} for each row execute function quota_save_failure();`));
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: `fresh-${failure}`, refresh_token: `replacement-${failure}` }));
    const file = quotaCredentialRecoveryPath(companyId, row.grant.id);
    let triggerDropped = false;
    try {
      await expect(service.refreshQuotaCredential(row, original, new AbortController().signal)).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
      expect(await service.credential(row)).toBe(original);
      const encrypted = await readFile(file, "utf8");
      expect(encrypted).not.toContain(`fresh-${failure}`);
      expect(encrypted).not.toContain(`replacement-${failure}`);
      await db.execute(sql.raw(`drop trigger quota_save_failure on ${table}; drop function quota_save_failure();`));
      triggerDropped = true;
      // A new service instance recovers from disk, without an in-memory cache.
      const recovered = aiConnectionService(db);
      await recovered.refreshQuotaCredential(row, original, new AbortController().signal);
      expect(JSON.parse(await recovered.credential(row))).toMatchObject({ tokens: { access_token: `fresh-${failure}`, refresh_token: `replacement-${failure}` } });
      expect(request).toHaveBeenCalledTimes(1);
      await expect(access(file)).rejects.toThrow();
      expect((await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, ref.secretId))).map(version => version.version).sort()).toEqual([1, 2]);
    } finally {
      request.mockRestore();
      if (!triggerDropped) await db.execute(sql.raw(`drop trigger quota_save_failure on ${table}; drop function quota_save_failure();`));
    }
  });

  it.each(["company_file", "grant_row", "secret_row"] as const)("defers runtime preparation on a contended %s lock and succeeds once it clears", async (kind) => {
    const owner = `runtime-lock-${kind}`;
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const auth = JSON.stringify({ tokens: { access_token: "valid-access", refresh_token: "valid-refresh", account_id: owner } });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, auth);
    const [row] = await service.quotaAccounts(companyId, owner);
    const ref = row.grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    const prepare = () => prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "codex_local",
      binding: { provider: "openai", method: "subscription", mode: "responsible_user" }, config: {} });
    const held = deferredSignal(), release = deferredSignal();
    const lock = kind === "company_file" ? vi.spyOn(codexAdapter, "withAccountHomeSecretMutationLock")
      .mockRejectedValueOnce(Object.assign(new Error("company lock held by another account"), { code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE })) : undefined;
    const holding = kind === "company_file" ? Promise.resolve() : db.transaction(async tx => {
      if (kind === "grant_row") await tx.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id)).for("update");
      else await tx.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId)).for("update");
      held.resolve(); await release.promise;
    });
    try {
      if (kind !== "company_file") await held.promise;
      const error = await prepare().then(() => { throw new Error("Runtime must defer"); }, error => error);
      expect(isAiConnectionBusy(error)).toBe(true);
      expect(error).toMatchObject({ status: 422, details: { code: "ai_connection_busy" } });
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id)))[0].status).toBe("active");
    } finally { release.resolve(); await holding; lock?.mockRestore(); }
    const run = await prepare();
    try { expect(await readFile(path.join(String(run.config.env.CODEX_HOME), "auth.json"), "utf8")).toBe(auth); }
    finally { await run.cleanup(); }
  });

  it.each([
    ["runtime", "rotation"], ["runtime", "commit"], ["failed_run", "rotation"], ["failed_run", "commit"],
  ] as const)("recovers pending quota credentials before %s can reuse or invalidate the consumed token after %s failure", async (consumer, failure) => {
    const owner = `quota-consumer-${consumer}-${failure}`;
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (marker: string) => JSON.stringify({ tokens: { access_token: `${marker}-access`, refresh_token: `${marker}-refresh`, account_id: owner } });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, auth("old"));
    const [row] = await service.quotaAccounts(companyId, owner);
    const prepare = () => prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "codex_local",
      binding: { provider: "openai", method: "subscription", mode: "responsible_user" }, config: {} });
    const oldRun = await prepare();
    const ref = row.grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    const journal = quotaCredentialRecovery(companyId, row.grant.id);
    await journal.write({ companyId, grantId: row.grant.id, connectionId: row.connection.id, secretId: ref.secretId,
      baseHash: quotaCredentialHash(auth("old")), value: auth("new") });
    const fail = () => service.markAuthenticationFailed({ companyId, agentId, runStartedAt: new Date(),
      attribution: { ...oldRun.attribution, identity: oldRun.identity } });
    await db.execute(sql.raw(`create function reject_consumer_recovery() returns trigger language plpgsql as $$ begin
      if new.secret_id = '${ref.secretId}'::uuid then raise exception 'recovery unavailable'; end if; return new; end $$;
      create ${failure === "commit" ? "constraint " : ""}trigger reject_consumer_recovery ${failure === "commit" ? "after" : "before"} insert on company_secret_versions
      ${failure === "commit" ? "deferrable initially deferred" : ""} for each row execute function reject_consumer_recovery();`));
    try {
      if (consumer === "runtime") {
        const error = await prepare().then(() => { throw new Error("Runtime must defer"); }, error => error);
        expect(isAiConnectionBusy(error)).toBe(true);
        expect(error).toMatchObject({ status: 422, details: { code: "ai_connection_busy" } });
      } else await expect(fail()).rejects.toThrow();
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id)))[0].status).toBe("active");
      expect(await service.credential(row)).toBe(auth("old"));
      expect(await journal.read()).not.toBeNull();
    } finally {
      await db.execute(sql`drop trigger reject_consumer_recovery on company_secret_versions; drop function reject_consumer_recovery()`);
    }
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Recovery must not exchange again"));
    let nextRun: Awaited<ReturnType<typeof prepare>> | undefined;
    try {
      if (consumer === "failed_run") await fail();
      nextRun = await prepare();
      expect(await readFile(path.join(String(nextRun.config.env.CODEX_HOME), "auth.json"), "utf8")).toBe(auth("new"));
      expect(nextRun.sessionIdentity).toBe(oldRun.sessionIdentity);
      await fail(); // A late failure of the old run cannot invalidate the recovered identity.
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id)))[0].status).toBe("active");
      expect(await service.credential(row)).toBe(auth("new"));
      expect(await journal.read()).toBeNull();
      expect(request).not.toHaveBeenCalled();
      expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, ref.secretId))).toHaveLength(2);
    } finally { request.mockRestore(); await oldRun.cleanup(); await nextRun?.cleanup(); await journal.clear(); }
  });

  it.each(["rollback", "lost_commit_reply"] as const)("automatically saves one exchanged token across %s", async (failure) => {
    const owner = `quota-once-${failure}`;
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const original = JSON.stringify({ tokens: { access_token: "expired", refresh_token: "single-use", account_id: owner } });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, original);
    const [row] = await service.quotaAccounts(companyId, owner);
    const transaction = db.transaction.bind(db);
    const interrupted = vi.spyOn(db, "transaction").mockImplementationOnce(async (work, config) => {
      await transaction(async (tx) => {
        await work(tx);
        if (failure === "rollback") throw new Error("Injected rollback after writes");
      }, config);
      throw new Error("Injected lost commit response");
    });
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "fresh-once", refresh_token: "replacement-once" }));
    try {
      await service.refreshQuotaCredential(row, original, new AbortController().signal);
      expect(JSON.parse(await service.credential(row))).toMatchObject({ tokens: { access_token: "fresh-once", refresh_token: "replacement-once" } });
      expect(request).toHaveBeenCalledTimes(1);
      await expect(access(quotaCredentialRecoveryPath(companyId, row.grant.id))).rejects.toThrow();
    } finally { interrupted.mockRestore(); request.mockRestore(); }
  });

  it("recovers the current credential's pending replacement before answering a delayed older poll", async () => {
    const owner = "delayed-quota-poll";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const original = JSON.stringify({ tokens: { access_token: "A", refresh_token: "refresh-A", account_id: owner } });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, original);
    const [row] = await service.quotaAccounts(companyId, owner);
    const ref = row.grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    const journal = quotaCredentialRecovery(companyId, row.grant.id);
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "B", refresh_token: "refresh-B" }))
      .mockResolvedValueOnce(Response.json({ access_token: "C", refresh_token: "refresh-C" }));
    let triggerInstalled = false;
    try {
      const current = await service.refreshQuotaCredential(row, original, new AbortController().signal);
      await db.execute(sql.raw(`create function delayed_quota_commit_failure() returns trigger language plpgsql as $$ begin
        if new.secret_id = '${ref.secretId}'::uuid then raise exception 'injected delayed quota commit failure'; end if; return new; end $$;
        create constraint trigger delayed_quota_commit_failure after insert on company_secret_versions deferrable initially deferred
        for each row execute function delayed_quota_commit_failure();`));
      triggerInstalled = true;
      await expect(service.refreshQuotaCredential(row, current, new AbortController().signal)).rejects.toThrow();
      expect(await service.credential(row)).toBe(current);
      expect(JSON.parse((await journal.read())!.value).tokens.access_token).toBe("C");
      await db.execute(sql`drop trigger delayed_quota_commit_failure on company_secret_versions; drop function delayed_quota_commit_failure()`);
      triggerInstalled = false;
      const recovered = await service.refreshQuotaCredential(row, original, new AbortController().signal);
      expect(JSON.parse(recovered).tokens).toMatchObject({ access_token: "C", refresh_token: "refresh-C" });
      expect(await service.credential(row)).toBe(recovered);
      expect(await journal.read()).toBeNull();
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      if (triggerInstalled) await db.execute(sql`drop trigger delayed_quota_commit_failure on company_secret_versions; drop function delayed_quota_commit_failure()`);
      request.mockRestore(); await journal.clear();
    }
  });

  it.each(["reconnected", "expired_reconnect", "revoked"] as const)("does not apply a pending refresh over a %s identity", async (change) => {
    const owner = `quota-replay-${change}`;
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const original = JSON.stringify({ tokens: { access_token: "expired", refresh_token: "single-use", account_id: owner } });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, original);
    const [row] = await service.quotaAccounts(companyId, owner);
    const ref = row.grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    const journal = quotaCredentialRecovery(companyId, row.grant.id);
    await journal.write({ companyId, grantId: row.grant.id, connectionId: row.connection.id, secretId: ref.secretId, baseHash: quotaCredentialHash(original), value: "old-pending-replacement" });
    const request = vi.spyOn(globalThis, "fetch");
    try {
      if (change === "reconnected") {
        await secretService(db).rotate(ref.secretId, { value: "new-authorized-identity" });
        expect(await service.refreshQuotaCredential(row, original, new AbortController().signal)).toBe("new-authorized-identity");
        expect(await service.credential(row)).toBe("new-authorized-identity");
        expect(await journal.read()).toBeNull();
      } else if (change === "expired_reconnect") {
        const reconnected = JSON.stringify({ tokens: { access_token: "expired-new-account", refresh_token: "new-account-refresh", account_id: owner } });
        await secretService(db).rotate(ref.secretId, { value: reconnected });
        request.mockResolvedValueOnce(Response.json({ access_token: "new-account-fresh", refresh_token: "new-account-replacement" }));
        await service.refreshQuotaCredential(row, reconnected, new AbortController().signal);
        expect(request).toHaveBeenCalledOnce();
        expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({ refresh_token: "new-account-refresh" });
        expect(JSON.parse(await service.credential(row))).toMatchObject({ tokens: { access_token: "new-account-fresh", refresh_token: "new-account-replacement" } });
        expect(await journal.read()).toBeNull();
      } else {
        await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, row.grant.id));
        await expect(service.refreshQuotaCredential(row, original, new AbortController().signal)).rejects.toThrow("credentials_unavailable");
        expect(await journal.read()).not.toBeNull();
      }
      if (change !== "expired_reconnect") expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); await journal.clear(); }
  });

  it("saves exchanged tokens when the quota deadline expires during response-body reading", async () => {
    const owner = "quota-body-deadline-owner";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const original = JSON.stringify({ tokens: { access_token: "expired", refresh_token: "single-use", account_id: "deadline-account" } });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: "Slow token body", loginSessionId: "fixture", agentIds: [], allAgents: true }, original);
    const [row] = await service.quotaAccounts(companyId, owner);
    const reading = deferredSignal(), releaseBody = deferredSignal(), quotaDeadline = new AbortController();
    let refreshSignal: AbortSignal | null | undefined;
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      refreshSignal = options?.signal;
      return { ok: true, json: async () => {
        reading.resolve(); await releaseBody.promise;
        refreshSignal?.throwIfAborted();
        return { access_token: "fresh-after-deadline", refresh_token: "replacement" };
      } } as Response;
    });
    const saving = service.refreshQuotaCredential(row, original, quotaDeadline.signal);
    try {
      await reading.promise;
      quotaDeadline.abort();
      expect(refreshSignal?.aborted).toBe(false);
      releaseBody.resolve();
      await saving;
      expect(JSON.parse(await service.credential(row))).toMatchObject({ tokens: { access_token: "fresh-after-deadline", refresh_token: "replacement" } });
      await expect(service.refreshQuotaCredential(row, original, quotaDeadline.signal)).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    } finally { releaseBody.resolve(); await saving.catch(() => {}); request.mockRestore(); }
  });

  it("retries another account's token write-back while a slow quota exchange holds the company lock", async () => {
    const auth = (account: string, marker: string) => JSON.stringify({ tokens: { account_id: account, id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: marker === "old" ? "2026-09-10T10:00:00Z" : "2026-09-10T11:00:00Z" });
    const quotaOwner = "slow-quota-owner", runOwner = "slow-quota-other-run";
    await db.insert(companyMemberships).values([quotaOwner, runOwner].map(principalId => ({ companyId, principalId, principalType: "user" as const, status: "active" as const, membershipRole: "member" as const })));
    for (const owner of [quotaOwner, runOwner]) await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, auth(owner, "old"));
    const [quotaRow] = await service.quotaAccounts(companyId, quotaOwner);
    // Runtime credential reads now serialize with quota exchanges. Prepare this
    // already-running, different account before testing its contended write-back.
    const preparedRun = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: runOwner, adapterType: "codex_local", binding: { provider: "openai", method: "subscription", mode: "responsible_user" }, config: {} });
    const started = deferredSignal(), release = deferredSignal();
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      started.resolve(); await release.promise;
      return Response.json({ access_token: "quota-fresh", refresh_token: "quota-replacement" });
    });
    const refreshing = service.refreshQuotaCredential(quotaRow, auth(quotaOwner, "old"), new AbortController().signal);
    let run: Awaited<ReturnType<typeof prepareManagedAiRuntime>> | undefined;
    let cleaning: Promise<void> | undefined;
    let lock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await started.promise;
      run = preparedRun;
      const authFile = path.join(String(run.config.env.CODEX_HOME), "auth.json");
      await writeFile(authFile, auth(runOwner, "replacement"));
      // Inject the two 30-second acquisition expirations, then use the real
      // still-held lock and real Postgres write-back for the final attempt.
      lock = vi.spyOn(codexAdapter, "withAccountHomeSecretMutationLock")
        .mockRejectedValueOnce(Object.assign(new Error("lock timeout"), { code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE }))
        .mockRejectedValueOnce(Object.assign(new Error("lock timeout"), { code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE }));
      cleaning = run.cleanup();
      await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(3));
      expect(await readFile(authFile, "utf8")).toBe(auth(runOwner, "replacement"));
      release.resolve();
      await Promise.all([refreshing, cleaning]);
      const [runRow] = await service.quotaAccounts(companyId, runOwner);
      expect(await service.credential(runRow)).toBe(auth(runOwner, "replacement"));
      expect(JSON.parse(await service.credential(quotaRow))).toMatchObject({ tokens: { access_token: "quota-fresh", refresh_token: "quota-replacement" } });
      await expect(access(run.home!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { release.resolve(); await Promise.allSettled([refreshing, cleaning]); lock?.mockRestore(); request.mockRestore(); }
  });

  it.each(["new", "reconnect"])("retains a completed %s sign-in across two lock waits behind a quota refresh", async kind => {
    const owner = `slow-quota-login-${kind}`, loginOwner = kind === "reconnect" ? owner : "contended-login-owner";
    await db.insert(companyMemberships).values([...new Set([owner, loginOwner])].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
    const original = JSON.stringify({ tokens: { account_id: owner, access_token: "old", refresh_token: "old-refresh" } });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, original);
    const [quotaRow] = await service.quotaAccounts(companyId, owner);
    const [environment] = await db.insert(environments).values({ name: "Contended AI login", driver: "sandbox" }).returning();
    const intent = { provider: "openai", method: "subscription", ownership: "personal", name: "Contended sign-in", agentIds: [], allAgents: true, ...(kind === "reconnect" ? { connectionId: quotaRow.connection.id } : {}) } as const;
    const sessionId = randomUUID();
    await db.insert(adapterAuthSessions).values({ id: sessionId, publicSessionId: randomUUID(), companyId, environmentId: environment.id, adapterType: "codex_local", startedByUserId: loginOwner, status: "promoting", aiConnection: { ...intent, agentIds: [] }, expiresAt: new Date(Date.now() + 600_000) });
    const started = deferredSignal(), release = deferredSignal();
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      started.resolve(); await release.promise;
      return Response.json({ access_token: "quota-fresh", refresh_token: "quota-replacement" });
    });
    const refreshing = service.refreshQuotaCredential(quotaRow, original, new AbortController().signal);
    let saving: ReturnType<typeof service.save> | undefined;
    let lock: ReturnType<typeof vi.spyOn> | undefined;
    const credential = JSON.stringify({ tokens: { account_id: "signed-in", access_token: "login-token", refresh_token: "login-refresh" } });
    try {
      await started.promise;
      // Represent two expired 30-second acquisitions, then wait on the real
      // held lock. The credential must survive until that final save commits.
      lock = vi.spyOn(codexAdapter, "withAccountHomeSecretMutationLock")
        .mockRejectedValueOnce(Object.assign(new Error("lock timeout"), { code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE }))
        .mockRejectedValueOnce(Object.assign(new Error("lock timeout"), { code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE }));
      saving = service.save(companyId, loginOwner, { ...intent, agentIds: [] }, credential, sessionId);
      void saving.catch(() => {});
      await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(3));
      expect((await db.select().from(adapterAuthSessions).where(eq(adapterAuthSessions.id, sessionId)))[0].connectionId).toBeNull();
      release.resolve();
      const [, saved] = await Promise.all([refreshing, saving]);
      const [row] = (await service.quotaAccounts(companyId, loginOwner)).filter(row => row.connection.id === saved.connectionId);
      expect(await service.credential(row)).toBe(credential);
      expect(await service.save(companyId, loginOwner, { ...intent, agentIds: [] }, credential, sessionId)).toEqual(saved);
      if (kind === "new") expect(JSON.parse(await service.credential(quotaRow))).toMatchObject({ tokens: { access_token: "quota-fresh", refresh_token: "quota-replacement" } });
    } finally {
      release.resolve(); await Promise.allSettled([refreshing, saving]); lock?.mockRestore(); request.mockRestore();
      await db.delete(adapterAuthSessions).where(eq(adapterAuthSessions.id, sessionId));
      await db.delete(environments).where(eq(environments.id, environment.id));
    }
  });

  it.each(["quota", "recovery", "runtime"])("allows an in-flight reconnect after automatic %s credential rotation", async kind => {
    const owner = `reconnect-refresh-${kind}`;
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (label: string, hour: number) => JSON.stringify({ tokens: { account_id: owner, id_token: "identity", access_token: `access-${label}`, refresh_token: `refresh-${label}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    const intent = { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true } as const;
    const account = await service.save(companyId, owner, { ...intent, agentIds: [] }, auth("old", 10));
    const [row] = await service.quotaAccounts(companyId, owner);
    const ref = row.grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    const before = (await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId)))[0];
    const started = new Date();
    if (kind === "quota") {
      const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "access-fresh", refresh_token: "refresh-fresh" }));
      try { await service.refreshQuotaCredential(row, auth("old", 10), new AbortController().signal); }
      finally { request.mockRestore(); }
    } else if (kind === "recovery") {
      const recovery = quotaCredentialRecovery(companyId, row.grant.id);
      await recovery.write({ companyId, grantId: row.grant.id, connectionId: row.connection.id, secretId: ref.secretId, baseHash: quotaCredentialHash(auth("old", 10)), value: auth("fresh", 11) });
      expect(await service.runtimeCredential(row)).toBe(auth("fresh", 11));
    } else {
      const runtime = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "codex_local", binding: { provider: "openai", method: "subscription", mode: "responsible_user" }, config: {} });
      await writeFile(path.join(String(runtime.config.env.CODEX_HOME), "auth.json"), auth("fresh", 11));
      await runtime.cleanup();
    }
    const after = (await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId)))[0];
    expect(after.latestVersion).toBeGreaterThan(before.latestVersion);
    expect(after.aiSessionEpoch).toBe(before.aiSessionEpoch);
    const saved = await service.save(companyId, owner, { ...intent, agentIds: [], connectionId: account.connectionId }, auth("reconnected", 12), undefined, started);
    expect(saved).toEqual(account);
    expect(await service.credential(row)).toBe(auth("reconnected", 12));
    await expect(service.save(companyId, owner, { ...intent, agentIds: [], connectionId: account.connectionId }, auth("older-login", 13), undefined, started)).rejects.toThrow("changed");
    // A real later revocation still fences this same old reconnect attempt.
    await db.update(connectionGrants).set({ status: "revoked", updatedAt: new Date() }).where(eq(connectionGrants.id, account.grantId));
    await expect(service.save(companyId, owner, { ...intent, agentIds: [], connectionId: account.connectionId }, auth("stale", 13), undefined, started)).rejects.toThrow("changed");
  });

  it.each(["lock", "database"])("preserves replacement tokens after exhausted %s write-back and permits a later retry", async failure => {
    const owner = `retained-writeback-${failure}`;
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (hour: string) => JSON.stringify({ tokens: { account_id: owner, id_token: "identity", access_token: `access-${hour}`, refresh_token: `refresh-${hour}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, auth("10"));
    const run = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "codex_local", binding: { provider: "openai", method: "subscription", mode: "responsible_user" }, config: {} });
    const authFile = path.join(String(run.config.env.CODEX_HOME), "auth.json");
    await writeFile(authFile, auth("11"));
    const injected = failure === "lock"
      ? vi.spyOn(codexAdapter, "withAccountHomeSecretMutationLock").mockRejectedValue(Object.assign(new Error("lock timeout"), { code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE }))
      : vi.spyOn(db, "transaction").mockRejectedValue(new Error("database unavailable"));
    try {
      await expect(run.cleanup()).rejects.toThrow(failure === "lock" ? "lock timeout" : "database unavailable");
      expect(injected).toHaveBeenCalledTimes(failure === "lock" ? 3 : 1);
      expect(await readFile(authFile, "utf8")).toBe(auth("11"));
    } finally { injected.mockRestore(); }
    await run.cleanup();
    const [row] = await service.quotaAccounts(companyId, owner);
    expect(await service.credential(row)).toBe(auth("11"));
    await expect(access(run.home!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes quota exchange with a concurrent secret edit and runtime credential read", async () => {
    const owner = "quota-race-owner";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const original = JSON.stringify({ tokens: { access_token: "old-access", refresh_token: "single-use", id_token: "identity", account_id: "race-account" } });
    const account = await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: "Racing refresh", loginSessionId: "fixture", agentIds: [], allAgents: true }, original);
    const [row] = await service.quotaAccounts(companyId, owner);
    const secretId = row.grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!.secretId;
    const exchangeStarted = deferredSignal();
    const releaseExchange = deferredSignal();
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      exchangeStarted.resolve(); await releaseExchange.promise;
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh" });
    });
    let runtime: Awaited<ReturnType<typeof prepareManagedAiRuntime>> | undefined;
    let lock: ReturnType<typeof vi.spyOn> | undefined;
    const refreshing = service.refreshQuotaCredential(row, original, new AbortController().signal);
    try {
      await exchangeStarted.promise;
      const edit = secretService(db).update(secretId, { description: "Changed during refresh" });
      lock = vi.spyOn(codexAdapter, "withAccountHomeSecretMutationLock");
      const preparing = prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "codex_local", binding: { provider: "openai", method: "subscription", mode: "responsible_user" }, config: {} });
      // Runtime reads now wait at the company file lock before touching the
      // old credential. The returned home must contain the committed rotation.
      let prepared = false;
      void preparing.then(() => { prepared = true; });
      await vi.waitFor(() => expect(lock).toHaveBeenCalled());
      expect(prepared).toBe(false);
      releaseExchange.resolve();
      const results = await Promise.all([refreshing, edit, preparing]);
      runtime = results[2];
      expect(JSON.parse(await readFile(path.join(String(runtime.config.env.CODEX_HOME), "auth.json"), "utf8"))).toMatchObject({ tokens: { access_token: "new-access", refresh_token: "new-refresh" } });
      expect(JSON.parse(await service.credential(row))).toMatchObject({ tokens: { access_token: "new-access", refresh_token: "new-refresh" } });
      expect((await secretService(db).getById(secretId))?.description).toBe("Changed during refresh");
    } finally { releaseExchange.resolve(); await runtime?.cleanup(); request.mockRestore(); lock?.mockRestore(); }
  }, 10_000);

  it("serializes quota credential refresh, persists rotation, and defers while the provider is active", async () => {
    const owner = "quota-refresh-owner";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const original = JSON.stringify({ tokens: { access_token: "expired-access", refresh_token: "single-use", id_token: "identity", account_id: null } });
    const account = await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: "Refresh account", loginSessionId: "fixture", agentIds: [], allAgents: true }, original);
    const [row] = await service.quotaAccounts(companyId, owner);
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "rotated-once" })));
    const signal = new AbortController().signal;
    try {
      // A pre-existing transaction may own a secret row before asking for the
      // company file lock. Refresh must defer before exchanging its token.
      await db.transaction(async tx => {
        const secretId = row.grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!.secretId;
        await tx.select().from(companySecrets).where(eq(companySecrets.id, secretId)).for("update");
        await expect(service.refreshQuotaCredential(row, original, signal)).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
      });
      const activeId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: activeId, companyId, agentId, invocationSource: "on_demand", status: "running", contextSnapshot: { aiConnection: { grantId: account.grantId } } });
      await expect(service.refreshQuotaCredential(row, original, signal)).rejects.toThrow("provider_unavailable");
      expect(request).not.toHaveBeenCalled();
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, activeId));
      const [first, second] = await Promise.all([
        service.refreshQuotaCredential(row, original, signal),
        service.refreshQuotaCredential(row, original, signal),
      ]);
      expect(first).toBe(second);
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await service.credential(row))).toMatchObject({ tokens: { access_token: "fresh-access", refresh_token: "rotated-once", account_id: null } });
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, account.grantId));
      await expect(service.refreshQuotaCredential(row, first, signal)).rejects.toThrow("credentials_unavailable");
      expect(request).toHaveBeenCalledTimes(1);
    } finally { request.mockRestore(); }
  });

  it.each([
    ["openai", "codex_local", "responses"],
    ["anthropic", "claude_local", "messages"],
    ["openai", "opencode_local", "chat"],
  ] as const)("prepares a no-auth %s endpoint without a vault secret", async (provider, adapterType, protocol) => {
    const account = await service.save(companyId, "alice", {
      provider, method: "api_key", ownership: "personal", name: `No-auth ${adapterType}`,
      agentIds: [], allAgents: true,
      routing: { kind: "local", protocol, baseUrl: "http://127.0.0.1:9000/v1", auth: "none", models: [] },
    }, "");
    const binding = { provider, method: "api_key", mode: "connection", connectionId: account.connectionId, grantId: account.grantId } as const;
    const config = { model: "fixture-model", env: { OPENAI_API_KEY: "host-key", ANTHROPIC_API_KEY: "host-key" } };
    const first = await prepareManagedAiRuntime(db, { ...input, adapterType, responsibleUserId: "alice", binding, config });
    const second = await prepareManagedAiRuntime(db, { ...input, adapterType, responsibleUserId: "alice", binding, config });
    try {
      expect(first.sessionIdentity).toBe(second.sessionIdentity);
      expect(first.sessionIdentity).toContain("no-auth");
      expect(JSON.stringify(first.config)).not.toContain("host-key");
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
      expect(grant.credentialSecretRefs).toEqual([]);
    } finally { await Promise.all([first.cleanup(), second.cleanup()]); }
  });
  it("never restores retained Grok transcripts into same-user runtime homes", async () => {
    const account = await service.save(companyId, "alice", {
      provider: "xai", method: "api_key", ownership: "personal",
      name: "Grok history isolation", agentIds: [], allAgents: true,
    }, "fixture-grok-key");
    const taskKey = `grok-history-${randomUUID()}`;
    const runInput = { ...input, taskKey, adapterType: "grok_local", responsibleUserId: "alice", config: {},
      binding: { provider: "xai", method: "api_key", mode: "connection", connectionId: account.connectionId, grantId: account.grantId } as const };
    const first = await prepareManagedAiRuntime(db, runInput);
    const scope = createHash("sha256").update(JSON.stringify([
      companyId, agentId, taskKey, first.sessionIdentity,
    ])).digest("hex");
    await first.cleanup();
    // Seed a valid archive from the earlier implementation. Runtime preparation
    // must not decrypt it onto the host, even for its authorized agent/task.
    const retained = await localEncryptedProvider.createVersion({ value: JSON.stringify({
      scope, entries: [{ name: "history.json", bytes: Buffer.from("previous-task-private-transcript").toString("base64") }],
    }) });
    await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "grok_local", taskKey,
      sessionParamsJson: { sessionId: "history", paperclipGrokHistory: { scope, material: retained.material } } });
    const resumed = await prepareManagedAiRuntime(db, runInput);
    const peer = await prepareManagedAiRuntime(db, { ...runInput, agentId: randomUUID() });
    try {
      expect(resumed.home).not.toBe(first.home);
      expect(peer.home).not.toBe(resumed.home);
      const transcript = path.join(String(resumed.config.env.GROK_HOME), "sessions", "history.json");
      // A separate same-UID process can bypass 0700. It must find no restored
      // transcript because none was materialized, not because of permissions.
      const crossAgentRead = spawnSync(process.execPath, ["-e", `
        const fs = require("node:fs");
        try { process.stdout.write(fs.readFileSync(process.argv[1], "utf8")); }
        catch (error) { process.stdout.write(error.code); }
      `, transcript], { encoding: "utf8" });
      expect(crossAgentRead.status).toBe(0);
      expect(crossAgentRead.stdout).toBe("ENOENT");
      await expect(access(transcript)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await Promise.all([resumed.cleanup(), peer.cleanup()]); }
  });
  it("authenticates local Gemini probes and runs with the saved key in an isolated home", async () => {
    const root = await mkdtemp(path.join(home, "gemini-auth-"));
    const command = path.join(root, "gemini");
    await writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const settings = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".gemini/settings.json"), "utf8"));
if (settings.selectedAuthType !== "gemini-api-key" || settings.security?.auth?.selectedType !== "gemini-api-key" || process.env.GEMINI_API_KEY !== "saved-google-key") {
  console.error("Invalid auth method selected");
  process.exit(1);
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "gemini-managed" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "output_text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", result: "hello", session_id: "gemini-managed" }));
`, { mode: 0o700 });
    const saved = await service.save(companyId, "alice", {
      provider: "google", method: "api_key", ownership: "personal", name: "Saved Google",
      apiKey: "fixture", allAgents: true, agentIds: [],
    }, "saved-google-key");
    const runtime = await prepareManagedAiRuntime(db, {
      companyId, agentId, responsibleUserId: "alice", adapterType: "gemini_local",
      binding: { provider: "google", method: "api_key", mode: "responsible_user" },
      config: { engine: "cli", command, cwd: root, promptTemplate: "Say hello.", paperclipRuntimeSkills: [], env: { GEMINI_API_KEY: "ambient-google-key" } },
    });
    try {
      expect(runtime.attribution.grantId).toBe(saved.grantId);
      expect(runtime.home).not.toBe(os.homedir());
      const settingsFile = path.join(runtime.home!, ".gemini/settings.json");
      expect(await readFile(settingsFile, "utf8")).not.toContain("saved-google-key");
      expect((await stat(settingsFile)).mode & 0o777).toBe(0o600);
      const probe = await testGeminiEnvironment({ companyId, adapterType: "gemini_local", config: runtime.config });
      expect(probe.status).toBe("pass");
      expect(probe.checks).toContainEqual(expect.objectContaining({ code: "gemini_hello_probe_passed" }));
      const result = await executeGemini({
        runId: randomUUID(),
        agent: { id: agentId, companyId, name: "Gemini", adapterType: "gemini_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: runtime.config, context: {}, onLog: async () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe("gemini-managed");
    } finally {
      await runtime.cleanup();
      await rm(root, { recursive: true, force: true });
    }
    await expect(access(runtime.home!)).rejects.toThrow();
  });

  it("preserves Google account defaults when the provider constraint migration is reapplied", async () => {
    const saved = await service.save(companyId, "bob", {
      provider: "google", method: "api_key", ownership: "personal", name: "Google migration",
      apiKey: "fixture", allAgents: true, agentIds: [],
    }, "google-migration-key");
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0306_familiar_titania.sql", import.meta.url), "utf8");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await db.transaction(async (tx) => {
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.execute(sql.raw(statement));
        }
      });
    }
    const selected = await service.select({
      companyId, agentId, userId: "bob", adapterType: "gemini_local",
      binding: { provider: "google", method: "api_key", mode: "responsible_user" },
    });
    expect(selected.grant.id).toBe(saved.grantId);
  });

  it.each([false, true])("reports the authoritative connection-manager capability for custom grants (manager: %s)", async (manager) => {
    const userId = `custom-manager-${manager}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    if (manager) await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "tools:manage_connections" });
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    const response = await request(app).get(`/api/companies/${companyId}/ai-connections`);
    expect(response.status).toBe(200);
    expect(response.body.canManageConnections).toBe(manager);
  });

  it("probes only the requested authorized grant using its vaulted subscription token", async () => {
    const owner = "usage-probe-owner";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const account = await service.save(companyId, owner, { provider: "anthropic", method: "subscription", ownership: "personal", name: "Usage probe account", loginSessionId: "fixture", agentIds: [], allAgents: true }, "usage-selected-secret");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 42 }, seven_day: { utilization: 15 } })));
    const app = express();
    app.use((req, _res, next) => {
      req.actor = req.header("x-agent")
        ? { type: "agent", agentId, companyId, companyIds: [companyId], onBehalfOfUserId: owner }
        : { type: "board", userId: req.header("x-test-user") ?? owner, companyIds: [companyId] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const url = `/api/companies/${companyId}/ai-connections/${account.connectionId}/usage?grantId=${account.grantId}`;
    try {
      const result = await request(app).get(url);
      expect(result.status).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.body).toMatchObject({ ...account, status: "ok", provider: "anthropic", limits: [{ usedPercent: 42 }, { usedPercent: 15 }] });
      expect(fetchSpy).toHaveBeenLastCalledWith("https://api.anthropic.com/api/oauth/usage", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer usage-selected-secret" }) }));
      expect(JSON.stringify(result.body)).not.toContain("usage-selected-secret");
      fetchSpy.mockClear();
      expect((await request(app).get(url).set("x-test-user", "bob")).status).toBe(404);
      expect((await request(app).get(url.replace(companyId, otherCompanyId))).status).toBe(403);
      expect((await request(app).get(url.replace(account.grantId, randomUUID()))).status).toBe(404);
      expect((await request(app).get(url).set("x-agent", "yes")).status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, account.grantId));
      const revoked = await request(app).get(url);
      expect(revoked.body).toMatchObject({ status: "unavailable", errorCode: "connection_unavailable", limits: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it("uses the same usage probe for shared accounts across legacy and native runner selections", async () => {
    const account = await service.save(companyId, "alice", { provider: "anthropic", method: "subscription", ownership: "shared", name: "Shared usage account", loginSessionId: "fixture", agentIds: [], allAgents: true }, "shared-usage-secret");
    const selected = { provider: "anthropic", method: "subscription", mode: "shared", ...account } as const;
    const tools = toolAccessService(db);
    await tools.replaceConnectionGrantMembers(account.connectionId, account.grantId, ["alice"], { userId: "alice" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 100 }, extra_usage: { is_enabled: false } })));
    try {
      await expect(service.probeUsage(companyId, "bob", account.connectionId)).rejects.toThrow("not found");
      expect(fetchSpy).not.toHaveBeenCalled();
      await tools.replaceConnectionGrantMembers(account.connectionId, account.grantId, ["bob"], { userId: "alice" });
      for (const config of [{ adapterType: "claude_local" }, { adapterType: "paperclip_runner", runnerProvider: "acpx", acpxAgent: "claude" }]) {
        const row = await service.select({ companyId, userId: "bob", agentId, binding: selected, ...config });
        expect(await service.probeUsage(companyId, "bob", row.connection.id, row.grant.id)).toMatchObject({ status: "ok", overage: { available: false }, limits: [{ limitReached: true }, { allowed: false }] });
      }
      // Unsupported methods do not resolve or send secrets.
      const owner = "usage-api-owner";
      await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
      const apiAccount = await create(owner, "Unsupported usage method");
      fetchSpy.mockClear();
      expect(await service.probeUsage(companyId, owner, apiAccount.connectionId)).toMatchObject({ status: "unsupported" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it("vaults routed credentials, enforces compatibility and access, and configures both Codex runners", async () => {
    const routing = { kind: "openrouter", protocol: "responses", auth: "bearer", models: [{ id: "openai/gpt-5.4" }] } as const;
    const saved = await service.save(companyId, "alice", { provider: "openrouter", method: "api_key", name: "Routed test", ownership: "personal", apiKey: "fixture", allAgents: true, agentIds: [], routing: { ...routing, models: [...routing.models] } }, "fixture-routed-credential");
    const selected = { provider: "openrouter", method: "api_key", mode: "delegated", ...saved } as const;
    expect(JSON.stringify(await service.list(companyId, "alice"))).not.toContain("fixture-routed-credential");
    expect(await service.list(companyId, "alice")).toEqual(expect.arrayContaining([expect.objectContaining({ id: saved.connectionId, routing, isDefault: false })]));
    await expect(service.setDefault(companyId, "alice", saved.grantId)).rejects.toThrow("explicit connection");
    await expect(service.select({ ...input, binding: selected, userId: "bob", adapterType: "codex_local", model: "openai/gpt-5.4" })).rejects.toThrow("not shared");
    await expect(service.select({ ...input, companyId: otherCompanyId, binding: selected, userId: "alice", adapterType: "codex_local" })).rejects.toThrow();
    for (const adapterType of ["codex_local", "paperclip_runner"]) {
      const runtime = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: "alice", binding: selected, adapterType, config: { provider: "codex", model: "openai/gpt-5.4", env: { OPENAI_API_KEY: "ambient" } } });
      try {
        expect(runtime.config.env.OPENAI_API_KEY).toBe("");
        expect(runtime.config.env.PAPERCLIP_AI_PROVIDER_KEY).toBe("fixture-routed-credential");
        const toml = await readFile(path.join(String(runtime.config.env.CODEX_HOME), "config.toml"), "utf8");
        expect(toml).toContain('base_url = "https://openrouter.ai/api/v1"');
        expect(toml).toContain('wire_api = "responses"');
        expect(toml).not.toContain("fixture-routed-credential");
      } finally { await runtime.cleanup(); }
    }
    await expect(service.save(companyId, "alice", { provider: "openrouter", method: "api_key", name: "Routed test", ownership: "personal", apiKey: "fixture", connectionId: saved.connectionId, allAgents: true, agentIds: [], routing: { ...routing, kind: "gateway", baseUrl: "https://other.example/v1", models: [] } }, "fixture-replacement")).rejects.toThrow("retain");
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, saved.grantId));
    await expect(service.select({ ...input, binding: selected, userId: "alice", adapterType: "codex_local", model: "openai/gpt-5.4" })).rejects.toThrow("Reconnect");
  });
  it("reconnects JSONB routing without changing its identity or access", async () => {
    const routing = { kind: "gateway", protocol: "responses", auth: "bearer", baseUrl: "https://gateway.example/v1", models: [{ id: "gateway-model" }] } as const;
    const input = { provider: "openai", method: "api_key", name: "Reconnect gateway", ownership: "personal", allAgents: false, agentIds: [agentId], routing: { ...routing, models: [...routing.models] } } as const;
    const saved = await service.save(companyId, "alice", { ...input, agentIds: [...input.agentIds] }, "old-gateway-credential");
    const [stored] = await db.select().from(toolConnections).where(eq(toolConnections.id, saved.connectionId));
    expect(stored!.config.ai).toMatchObject({ routing });
    expect(stored!.config.sourceTemplateKey).toBe("responses-api");
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, stored!.applicationId));
    expect(application).toMatchObject({ applicationKey: "app-gallery:responses-api", metadata: { sourceTemplateKey: "responses-api" } });
    // PostgreSQL JSONB reorders object keys; compare values, not serialization.
    const reordered = { models: [...routing.models], auth: routing.auth, baseUrl: routing.baseUrl, protocol: routing.protocol, kind: routing.kind };
    expect(await service.save(companyId, "alice", { ...input, agentIds: [], allAgents: true, connectionId: saved.connectionId, routing: reordered }, "new-gateway-credential")).toEqual(saved);
    const selection = { companyId, agentId, userId: "alice", adapterType: "codex_local", binding: { provider: "openai", method: "api_key", mode: "delegated", ...saved } } as const;
    const selected = await service.select(selection);
    expect(await service.credential(selected)).toBe("new-gateway-credential");
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, saved.connectionId));
    expect(installs).toEqual([expect.objectContaining({ targetType: "agent", targetId: agentId })]);
    await expect(service.save(companyId, "alice", { ...input, agentIds: [agentId], connectionId: saved.connectionId, routing: { ...reordered, baseUrl: "https://different.example/v1" } }, "rejected-credential")).rejects.toThrow("retain");
    expect(await service.credential(await service.select(selection))).toBe("new-gateway-credential");
  });

  it("saves no-auth endpoints without a secret and refuses protocol mismatches", async () => {
    const routing = { kind: "local", protocol: "chat", auth: "none", baseUrl: "http://localhost:11434/v1", models: [] } as const;
    const saved = await service.save(companyId, "alice", { provider: "openai", method: "api_key", name: "Local", ownership: "personal", allAgents: true, agentIds: [], routing: { ...routing, models: [] } }, "");
    const selected = { provider: "openai", method: "api_key", mode: "delegated", ...saved } as const;
    await expect(service.select({ ...input, binding: selected, userId: "alice", adapterType: "codex_local" })).rejects.toThrow("incompatible");
    const row = await service.select({ ...input, binding: selected, userId: "alice", adapterType: "opencode_local", model: "qwen" });
    expect(row.grant.credentialSecretRefs).toEqual([]);
    expect(await service.credential(row)).toBe("");
  });

  it.each([
    ["anthropic", false], ["openai", false], ["anthropic", true], ["openai", true],
  ] as const)("turns a %s auth failure into one card and resumes after repair (switch method: %s)", async (provider, switchMethod) => {
    const userId = `auth-recovery-${provider}-${switchMethod}`;
    const id = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const adapterType = provider === "openai" ? "codex_local" : "claude_local";
    const selectedBinding = { provider, method: "api_key", mode: "responsible_user" } as const;
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id, companyId, name: "Auth recovery", adapterType, runtimeConfig: { aiConnection: selectedBinding } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Fix provider login", status: "in_progress", assigneeAgentId: id });
    const account = await service.save(companyId, userId, { provider, method: "api_key", ownership: "personal", name: "Recovery account", apiKey: "fixture", agentIds: [id], allAgents: false }, "fixture-recovery-key");
    const runtime = await prepareManagedAiRuntime(db, { companyId, agentId: id, responsibleUserId: userId, adapterType, binding: selectedBinding, config: {} });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: id, status: "failed", errorCode: "acpx_auth_required", responsibleUserId: userId,
      contextSnapshot: { issueId, aiConnection: { ...runtime.attribution, identity: runtime.identity } } });
    await runtime.cleanup();
    const intents = connectionIntentService(db);
    const card = await intents.requestForRunAuthFailure(runId);
    expect(card).toMatchObject({ state: "needs_user_action", service: provider });
    expect((await intents.requestForRunAuthFailure(runId))?.interactionId).toBe(card!.interactionId);
    const setup = await intents.setupOptions(card!.interactionId!);
    expect(setup.existingConnections).toEqual([]);
    expect(setup.aiRepair).toMatchObject({ canReconnect: true, connection: { id: account.connectionId, status: "needs_attention" } });
    await expect(intents.complete(card!.interactionId!, account.connectionId, userId)).rejects.toThrow();
    // A stopped run's token cannot call the public request path.
    await expect(intents.request({ sub: id, company_id: companyId, run_id: runId, responsible_user_id: userId }, provider, { purpose: "ai" })).rejects.toThrow("no longer active");
    // Reverification can keep the same credential bytes; it still supersedes the failure.
    let repaired = account;
    if (switchMethod) {
      const token = provider === "openai" ? JSON.stringify({ tokens: { access_token: "fixture-subscription", refresh_token: "fixture-refresh", id_token: "fixture-id", account_id: "fixture-account" } }) : "fixture-subscription";
      repaired = await service.save(companyId, userId, { provider, method: "subscription", ownership: "personal", name: "Recovery subscription", loginSessionId: "fixture", agentIds: [id], allAgents: false }, token);
      await service.setDefault(companyId, userId, repaired.grantId);
      const [original] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
      expect(original.status).toBe("needs_reauthorization");
    } else {
      await service.save(companyId, userId, { provider, method: "api_key", ownership: "personal", name: "Recovery account", connectionId: account.connectionId, apiKey: "fixture", agentIds: [id], allAgents: false }, provider === "openai" ? "fixture-recovery-key" : "fixture-repaired-key");
    }
    expect((await intents.setupOptions(card!.interactionId!)).existingConnections.map(connection => connection.id)).toEqual([repaired.connectionId]);
    await intents.complete(card!.interactionId!, repaired.connectionId, userId);
    const wakeup = vi.fn(async (_agentId, opts) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId: id, source: "automation", status: "queued", idempotencyKey: opts.idempotencyKey });
      return null;
    });
    await connectionIntentDeliveryService(db, { wakeup } as never).deliver(card!.interactionId!);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(id, expect.objectContaining({ contextSnapshot: expect.objectContaining({ forceFreshSession: true }) }));
    // Reprocessing an old failure cannot invalidate the newly saved credential.
    await intents.requestForRunAuthFailure(runId);
    expect((await service.select({ companyId, agentId: id, userId, adapterType, binding: selectedBinding })).grant.status).toBe("active");
  });

  it("offers a compatible connection for legacy auth failures without silently adopting it", async () => {
    const id = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(agents).values({ id, companyId, name: "Legacy Codex", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Legacy auth", status: "in_progress", assigneeAgentId: id });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: id, nativeIssueId: issueId, status: "failed", errorCode: "acpx_auth_required", responsibleUserId: "alice", contextSnapshot: {} });
    const intents = connectionIntentService(db);
    const card = await intents.requestForRunAuthFailure(runId);
    expect(card).toMatchObject({ service: "openai", state: "needs_user_action" });
    expect(await intents.setupOptions(card!.interactionId!)).toMatchObject({ aiConnectionRequiresAdoption: true, aiConnection: { provider: "openai", mode: "responsible_user" } });
    const [unchanged] = await db.select().from(agents).where(eq(agents.id, id));
    expect(unchanged.runtimeConfig.aiConnection).toBeUndefined();
    await db.insert(heartbeatRuns).values({ companyId, agentId: id, status: "succeeded", responsibleUserId: "alice", contextSnapshot: { issueId }, createdAt: new Date(Date.now() + 1000) });
    expect(await intents.requestForRunAuthFailure(runId)).toBeNull();
  });

  it("lists quotas only for the current member's accessible subscription accounts", async () => {
    const user = `quota-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId, principalId: user, principalType: "user", status: "active", membershipRole: "member" });
    const subscription = await service.save(companyId, user, { provider: "openai", method: "subscription", ownership: "personal", name: "Private quota", loginSessionId: "fixture", allAgents: true, agentIds: [] }, JSON.stringify({ tokens: { access_token: "fixture", account_id: "fixture", refresh_token: "fixture" } }));
    expect((await service.quotaAccounts(companyId, user)).some(row => row.connection.id === subscription.connectionId)).toBe(true);
    expect((await service.quotaAccounts(companyId, "bob")).some(row => row.connection.id === subscription.connectionId)).toBe(false);
    expect(await service.quotaAccounts(otherCompanyId, user)).toEqual([]);
    await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, user)));
    expect(await service.quotaAccounts(companyId, user)).toEqual([]);
  });

  it("repairs a teammate's missing onboarding key with their own inline AI connection", async () => {
    const userId = `new-teammate-${randomUUID()}`;
    const id = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const vault = secretService(db);
    const definition = await vault.createUserSecretDefinition(companyId, {
      key: `ANTHROPIC_API_KEY.${randomUUID()}`, name: "ANTHROPIC_API_KEY for onboarding",
    }, { userId: "alice" });
    const ownerSecret = await vault.createCurrentUserSecretValue(companyId, "alice", {
      definitionId: definition.id, value: "fixture-original-owner-key",
    }, { userId: "alice" });
    const adapterConfig = { env: { ANTHROPIC_API_KEY: {
      type: "user_secret_ref", key: definition.key, version: "latest", required: true,
    } } };
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const [agent] = await db.insert(agents).values({ id, companyId, name: "Chief of Staff", adapterType: "claude_local", adapterConfig }).returning();
    await vault.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: id }, adapterConfig.env);
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat with Chief of Staff", status: "blocked", assigneeAgentId: id, responsibleUserId: userId });
    const failure = await resolveExecutionRunAdapterConfig({
      companyId, agentId: id, adapterType: "claude_local", issueId,
      responsibleUserId: userId, executionRunConfig: adapterConfig, projectEnv: null, secretsSvc: vault,
    }).catch(error => error);
    expect(failure).toMatchObject({ code: "configuration_incomplete", resultJson: {
      configurationIncomplete: { reason: "secret_binding_missing", missingBindings: [
        expect.objectContaining({ bindingType: "user_secret_ref", envKey: "ANTHROPIC_API_KEY", errorCode: "user_secret_missing", responsibleUserId: userId }),
      ] },
    } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: id, status: "failed",
      errorCode: failure.code, resultJson: failure.resultJson, responsibleUserId: userId, contextSnapshot: { issueId } });
    await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: issueId,
      kind: "configuration_validation", cause: "configuration_incomplete", fingerprint: `missing-key:${issueId}`,
      nextAction: "Connect your AI account", ownerType: "board", evidence: { latestRunId: runId } });
    const intents = connectionIntentService(db);
    const card = await intents.requestForRunAuthFailure(runId);
    expect(card).toMatchObject({ service: "anthropic", state: "needs_user_action" });
    expect((await intents.setupOptions(card!.interactionId!))).toMatchObject({
      aiConnectionRequiresAdoption: true, aiConnection: { provider: "anthropic", mode: "responsible_user" },
      interaction: { addresseeUserId: userId, sourceRunId: runId },
    });
    expect((await intents.requestForRunAuthFailure(runId))?.interactionId).toBe(card!.interactionId);
    expect((await db.select().from(agents).where(eq(agents.id, id)))[0].runtimeConfig.aiConnection).toBeUndefined();

    const account = await create(userId, "Teammate's Claude");
    const setup = await intents.setupOptions(card!.interactionId!);
    await intents.complete(card!.interactionId!, account.connectionId, userId, {
      validatedAdoption: { agentUpdatedAt: agent.updatedAt, binding: setup.aiConnection! },
    });
    const wakeup = vi.fn(async (_agentId, opts) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId: id, source: "automation", status: "queued", idempotencyKey: opts.idempotencyKey });
      return null;
    });
    const delivery = connectionIntentDeliveryService(db, { wakeup } as never);
    await delivery.deliver(card!.interactionId!);
    await delivery.deliver(card!.interactionId!);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("in_progress");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(id, expect.objectContaining({ contextSnapshot: expect.objectContaining({ forceFreshSession: true }) }));
    expect(await issueRecoveryActionService(db).getActiveForIssue(companyId, issueId)).toBeNull();
    expect((await db.select().from(companySecrets).where(eq(companySecrets.id, ownerSecret.id)))[0]).toMatchObject({ ownerUserId: "alice", latestVersion: 1, status: "active" });
    const runtime = await prepareManagedAiRuntime(db, { companyId, agentId: id, responsibleUserId: userId, adapterType: "claude_local", binding: setup.aiConnection!, config: adapterConfig });
    try {
      expect(runtime.config.env).toMatchObject({ ANTHROPIC_API_KEY: "fixture-Teammate's Claude" });
      expect(runtime.attribution.grantId).toBe(account.grantId);
    } finally { await runtime.cleanup(); }
  }, 30000);
  it.each([
    ["anthropic", "claude_local", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    ["openai", "codex_local", "CODEX_HOME", "OPENAI_API_KEY"],
  ] as const)("runs the same %s agent with each responsible user's subscription or API key", async (provider, adapterType, subscriptionEnv, apiEnv) => {
    const subscriptionUser = `${provider}-subscription-user`;
    const apiUser = `${provider}-api-user`;
    await db.insert(companyMemberships).values([subscriptionUser, apiUser].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
    const token = provider === "openai" ? JSON.stringify({ tokens: { access_token: "fixture-subscription", refresh_token: "fixture-refresh", id_token: "fixture-id", account_id: "fixture-account" } }) : "fixture-subscription";
    const subscription = await service.save(companyId, subscriptionUser, { provider, method: "subscription", ownership: "personal", name: "Subscription", loginSessionId: "fixture", allAgents: true, agentIds: [] }, token);
    const api = await service.save(companyId, apiUser, { provider, method: "api_key", ownership: "personal", name: "API", apiKey: "fixture", allAgents: true, agentIds: [] }, "fixture-api");
    // This is the exact same saved bot config, including a legacy setup method.
    const bot = { ...input, adapterType, binding: { provider, method: "subscription", mode: "responsible_user" } as const, config: { model: "unchanged-model", env: { [apiEnv]: "ambient", CLAUDE_CODE_OAUTH_TOKEN: "ambient" } } };
    const original = structuredClone(bot);
    const [subRun, apiRun] = await Promise.all([subscriptionUser, apiUser].map(responsibleUserId => prepareManagedAiRuntime(db, { ...bot, responsibleUserId })));
    try {
      expect(subRun.attribution).toMatchObject({ grantId: subscription.grantId, method: "subscription", responsibleUserId: subscriptionUser });
      expect(apiRun.attribution).toMatchObject({ grantId: api.grantId, method: "api_key", responsibleUserId: apiUser });
      const subEnv = subRun.config.env as Record<string, string>;
      const apiEnvValues = apiRun.config.env as Record<string, string>;
      expect(subEnv[apiEnv]).toBe("");
      expect(apiEnvValues[apiEnv]).toBe("fixture-api");
      if (provider === "anthropic") {
        expect(subEnv[subscriptionEnv]).toBe(token);
        expect(apiEnvValues[subscriptionEnv]).toBe("");
      } else {
        expect(await readFile(path.join(subEnv.CODEX_HOME, "auth.json"), "utf8")).toBe(token);
        expect(JSON.parse(await readFile(path.join(apiEnvValues.CODEX_HOME, "auth.json"), "utf8"))).toEqual({ OPENAI_API_KEY: "fixture-api" });
      }
      expect(subEnv.HOME).not.toBe(apiEnvValues.HOME);
      expect(subRun.identity).not.toBe(apiRun.identity);
      expect(subRun.config.model).toBe(bot.config.model);
      expect(apiRun.config.model).toBe(bot.config.model);
      expect(bot).toEqual(original);
      expect(aiConnectionBindingSchema.parse(bot.binding)).toEqual(bot.binding);
    } finally { await Promise.all([subRun.cleanup(), apiRun.cleanup()]); }
  });

  it("has one provider default across methods, retains unavailable defaults and honors explicit account methods", async () => {
    const userId = "provider-default-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const api = await create(userId, "Provider API");
    const subscription = await service.save(companyId, userId, { provider: "anthropic", method: "subscription", ownership: "personal", name: "Provider subscription", loginSessionId: "fixture", allAgents: true, agentIds: [] }, "fixture-provider-subscription");
    expect((await service.select({ ...input, userId })).grant.id).toBe(api.grantId);
    expect((await service.list(companyId, userId)).filter(account => account.isDefault).map(account => account.grantId)).toEqual([api.grantId]);
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, api.grantId));
    await expect(service.select({ ...input, userId })).rejects.toThrow("Reconnect");
    await create(userId, "Another API");
    await expect(service.select({ ...input, userId })).rejects.toThrow("Reconnect");
    await service.setDefault(companyId, userId, subscription.grantId);
    expect((await service.select({ ...input, userId })).attribution).toMatchObject({ method: "subscription", grantId: subscription.grantId });
    expect((await service.list(companyId, userId)).filter(account => account.isDefault)).toHaveLength(1);
    await expect(service.select({ ...input, userId, binding: { ...binding, mode: "delegated", ...subscription } })).rejects.toThrow("incompatible");
  });

  it("backfills provider defaults repeatably without deleting old preferences or replacing an unavailable choice", async () => {
    const userId = "provider-default-migration-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const api = await create(userId, "Migration API");
    const subscription = await service.save(companyId, userId, { provider: "anthropic", method: "subscription", ownership: "personal", name: "Migration subscription", loginSessionId: "fixture", allAgents: true, agentIds: [] }, "fixture-migration-subscription");
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, api.grantId));
    await db.update(aiConnectionDefaults).set({ updatedAt: new Date("2030-01-01") }).where(eq(aiConnectionDefaults.grantId, api.grantId));
    await db.delete(aiProviderDefaults).where(and(eq(aiProviderDefaults.companyId, companyId), eq(aiProviderDefaults.userId, userId)));
    const legacyRows = await db.select().from(aiConnectionDefaults).where(eq(aiConnectionDefaults.userId, userId));
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0277_uneven_lady_deathstrike.sql", import.meta.url), "utf8");
    for (let pass = 0; pass < 2; pass++) for (const statement of migration.split("--> statement-breakpoint").filter(value => value.trim())) await db.execute(sql.raw(statement));
    expect(await db.select().from(aiConnectionDefaults).where(eq(aiConnectionDefaults.userId, userId))).toEqual(legacyRows);
    await expect(service.select({ ...input, userId })).rejects.toThrow("Reconnect");
    await service.setDefault(companyId, userId, subscription.grantId);
    for (const statement of migration.split("--> statement-breakpoint").filter(value => value.trim())) await db.execute(sql.raw(statement));
    expect((await service.select({ ...input, userId })).grant.id).toBe(subscription.grantId);
  });
  it("observes old-server default changes during rolling upgrades without treating new accounts as default changes", async () => {
    const userId = "rolling-upgrade-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const api = await create(userId, "Rolling API");
    const subscription = await service.save(companyId, userId, { provider: "anthropic", method: "subscription", ownership: "personal", name: "Rolling subscription", loginSessionId: "fixture", allAgents: true, agentIds: [] }, "fixture-rolling-subscription");
    expect((await service.select({ ...input, userId })).grant.id).toBe(api.grantId);
    // An older server updates only the legacy per-method row on Make default.
    await db.update(aiConnectionDefaults).set({ grantId: subscription.grantId, updatedAt: new Date() })
      .where(and(eq(aiConnectionDefaults.userId, userId), eq(aiConnectionDefaults.method, "subscription")));
    expect((await service.select({ ...input, userId })).attribution).toMatchObject({ grantId: subscription.grantId, method: "subscription" });
    expect((await service.list(companyId, userId)).filter(account => account.isDefault).map(account => account.grantId)).toEqual([subscription.grantId]);
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, subscription.grantId));
    await create(userId, "Rolling second API");
    await expect(service.select({ ...input, userId })).rejects.toThrow("Reconnect");
    await db.update(aiConnectionDefaults).set({ grantId: api.grantId, updatedAt: new Date() })
      .where(and(eq(aiConnectionDefaults.userId, userId), eq(aiConnectionDefaults.method, "api_key")));
    expect((await service.select({ ...input, userId })).grant.id).toBe(api.grantId);
  });
  it("checks the selected environment for project auth overrides without exposing their contents", async () => {
    const execute = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess");
    const target = { kind: "remote", transport: "sandbox", remoteCwd: "/workspace/project" } as Parameters<typeof assertManagedAiProjectAuth>[2];
    try {
      execute.mockResolvedValue({ exitCode: 42, stdout: "", stderr: "", signal: null, timedOut: false } as Awaited<ReturnType<typeof executionTarget.runAdapterExecutionTargetProcess>>);
      await expect(assertManagedAiProjectAuth({}, "openai", target)).rejects.toThrow("project authentication settings");
      expect(execute.mock.calls[0][3]).toContain("/workspace/project");
      expect(execute.mock.calls[0][3]).toContain(".codex/config.toml");
      execute.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", signal: null, timedOut: false } as Awaited<ReturnType<typeof executionTarget.runAdapterExecutionTargetProcess>>);
      await expect(assertManagedAiProjectAuth({}, "openai", target)).resolves.toBeUndefined();
      await expect(assertManagedAiProjectAuth({ args: ["--api-key=override"] }, "xai", target)).rejects.toThrow("overrides");
    } finally { execute.mockRestore(); }
  });
  it("keeps personal defaults separate and does not replace the first default", async () => {
    const first = await create("alice", "Alice first");
    await create("alice", "Alice second");
    const bob = await create("bob", "Bob first");
    const [a,b] = await Promise.all([service.select({ ...input, userId: "alice" }), service.select({ ...input, userId: "bob" })]);
    expect(a.grant.id).toBe(first.grantId); expect(b.grant.id).toBe(bob.grantId);
    expect(await service.credential(a)).toBe("fixture-Alice first");
    expect(await service.credential(b)).toBe("fixture-Bob first");
    expect(JSON.stringify(await service.list(companyId, "alice"))).not.toContain("fixture-");
    expect(await service.list(otherCompanyId, "alice")).toEqual([]);
  });
  it("retains a revoked default without automatic fallback", async () => {
    const selected = await service.select({ ...input, userId: "alice" });
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, selected.grant.id));
    await create("alice", "Alice third");
    expect(await toolAccessService(db).getConnection(selected.connection.id, companyId)).toMatchObject({ healthStatus: "missing_secret", requiresReauthorization: true });
    expect((await toolAccessService(db).listConnections(companyId)).find(connection => connection.id === selected.connection.id)?.healthStatus).toBe("missing_secret");
    await expect(service.select({ ...input, userId: "alice" })).rejects.toThrow("Reconnect");
    const second = (await service.list(companyId, "alice")).find(a => a.name === "Alice second")!;
    await service.setDefault(companyId, "alice", second.grantId);
    expect((await service.select({ ...input, userId: "alice" })).grant.id).toBe(second.grantId);
    await expect(service.setDefault(companyId, "bob", second.grantId)).rejects.toThrow("owner");
  });
  it("uses human access for every selection; an agent delegation cannot override Just me", async () => {
    const personal = await service.select({ ...input, userId: "alice" });
    const delegated = { ...binding, mode: "delegated" as const, connectionId: personal.connection.id, grantId: personal.grant.id };
    const rejection = await service.select({ ...input, userId: "bob", binding: delegated }).catch(error => error);
    expect(rejection).toMatchObject({ status: 403, message: "This credential is not shared with the responsible user" });
    expect(rejection.details).toBeUndefined();
    expect(readAiConnectionConfigurationFailure(rejection)).toBe("ai_connection_credential_not_shared");
    // Existing delegation records no longer confer an independent AI permission.
    await db.insert(connectionGrantDelegations).values({ companyId, grantId: personal.grant.id, agentId, createdByUserId: "alice" });
    await expect(service.select({ ...input, userId: "bob", binding: delegated })).rejects.toThrow("not shared");
    expect((await service.select({ ...input, userId: "alice", binding: delegated })).grant.id).toBe(personal.grant.id);
    expect((await service.list(companyId, "bob", agentId)).some(account => account.id === personal.connection.id)).toBe(false);
    await expect(toolAccessService(db).createConnectionGrantDelegation(personal.connection.id, personal.grant.id, agentId, "alice")).rejects.toThrow("human access settings");
  });
  it("applies the existing human audience editor to AI listing and execution without a second authorization", async () => {
    const shared = await create("alice", "Engineering", "shared");
    const sharedBinding = { ...binding, mode: "shared" as const, ...shared };
    const tools = toolAccessService(db);
    await tools.replaceConnectionGrantMembers(shared.connectionId, shared.grantId, ["alice"], { userId: "alice" });
    const rejection = await service.select({ ...input, userId: "bob", binding: sharedBinding }).catch(error => error);
    expect(rejection).toMatchObject({ status: 403, message: "This credential is not shared with the responsible user" });
    expect(readAiConnectionConfigurationFailure(rejection)).toBe("ai_connection_credential_not_shared");
    expect((await service.list(companyId, "bob", agentId)).some(account => account.id === shared.connectionId)).toBe(false);
    await tools.replaceConnectionGrantMembers(shared.connectionId, shared.grantId, ["bob"], { userId: "alice" });
    expect((await service.select({ ...input, userId: "bob", binding: sharedBinding })).grant.id).toBe(shared.grantId);
    expect((await service.list(companyId, "bob", agentId)).some(account => account.id === shared.connectionId)).toBe(true);
    await expect(service.select({ ...input, userId: "alice", binding: sharedBinding })).rejects.toThrow("not shared");
    await tools.replaceConnectionGrantMembers(shared.connectionId, shared.grantId, [], { userId: "alice" });
    for (const userId of ["alice", "bob"]) {
      expect((await service.select({ ...input, userId, binding: sharedBinding })).grant.id).toBe(shared.grantId);
    }
    const missingIdentity = await service.select({ ...input, userId: null, binding: sharedBinding }).catch(error => error);
    expect(missingIdentity).toMatchObject({ status: 403, message: "This credential is not shared with the responsible user" });
    expect(readAiConnectionConfigurationFailure(missingIdentity)).toBeNull();
    const inactiveMember = await service.select({ ...input, userId: "inactive-user", binding: sharedBinding }).catch(error => error);
    expect(inactiveMember).toMatchObject({ status: 403, message: "The responsible user is not an active company member" });
    expect(readAiConnectionConfigurationFailure(inactiveMember)).toBeNull();
    // Human permission still cannot bypass the separate agent-access setting.
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, shared.connectionId));
    const missingAgentPermission = await service.select({ ...input, userId: "bob", binding: sharedBinding }).catch(error => error);
    expect(missingAgentPermission).toMatchObject({ status: 403 });
    expect(missingAgentPermission.message).toContain("not permitted for this agent");
    expect(readAiConnectionConfigurationFailure(missingAgentPermission)).toBeNull();
    expect(sharedBinding).toEqual({ ...binding, mode: "shared", ...shared });
  });
  it.each(["inactive_owner", "wrong_binding_kind", "wrong_company_membership"] as const)(
    "does not classify other credential authorization denials as sharing configuration: %s", async (cause) => {
      const owner = `sharing-${cause}-owner`;
      await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
      const account = await create(owner, "Sharing permission fixture");
      const selected = { ...binding, mode: cause === "wrong_binding_kind" ? "shared" as const : "delegated" as const, ...account };
      let userId = "bob";
      if (cause === "inactive_owner") {
        await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, owner)));
      }
      if (cause === "wrong_company_membership") {
        userId = "other-company-sharing-user";
        await db.insert(companyMemberships).values({ companyId: otherCompanyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      }
      const error = await service.select({ ...input, userId, binding: selected }).catch(error => error);
      expect(error).toMatchObject({ status: 403, message: cause === "inactive_owner"
        ? "The account owner is no longer an active company member"
        : cause === "wrong_binding_kind" ? "Select a company-shared account"
        : "The responsible user is not an active company member" });
      expect(readAiConnectionConfigurationFailure(error)).toBeNull();
    },
  );

  it("isolates concurrent homes and overrides ambient credentials without changing the model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-never-use");
    const config = { model: "unchanged-model", env: { ANTHROPIC_API_KEY: "project-never-use" } };
    const [a,b] = await Promise.all(["alice", "bob"].map(responsibleUserId => prepareManagedAiRuntime(db, { ...input, responsibleUserId, config })));
    const ae = a.config.env as Record<string,string>, be = b.config.env as Record<string,string>;
    expect(ae.ANTHROPIC_API_KEY).toBe("fixture-Alice second"); expect(be.ANTHROPIC_API_KEY).toBe("fixture-Bob first");
    expect(ae.HOME).not.toBe(be.HOME); expect(a.identity).not.toBe(b.identity);
    expect(a.config.model).toBe("unchanged-model"); expect(config.env.ANTHROPIC_API_KEY).toBe("project-never-use");
    await Promise.all([a.cleanup(), b.cleanup()]); await expect(access(ae.HOME)).rejects.toThrow();
  });
  it("blocks missing identity, incompatible providers, and cross-company explicit selections", async () => {
    await expect(service.select({ ...input, userId: null })).rejects.toThrow("responsible user");
    await expect(service.select({ ...input, userId: "alice", adapterType: "codex_local" })).rejects.toThrow("compatible");
    const account = await service.select({ ...input, userId: "alice" });
    await expect(service.select({ ...input, companyId: otherCompanyId, userId: "alice", binding: { ...binding, mode: "shared", connectionId: account.connection.id, grantId: account.grant.id } })).rejects.toThrow();
  });
  it("resolves shared encrypted credentials through the existing secret binding system", async () => {
    const created = await create("alice", "Shared credential proof", "shared");
    const selected = await service.select({ ...input, userId: "bob", binding: { ...binding, mode: "shared", ...created } });
    expect(await service.credential(selected)).toBe("fixture-Shared credential proof");
  });
  it("saves successful login completion once and rejects abandoned attempts", async () => {
    const [environment] = await db.insert(environments).values({ name: "AI login test", driver: "sandbox" }).returning();
    const intent = { provider: "anthropic", method: "subscription", ownership: "personal", name: "Claude subscription", agentIds: [], allAgents: true } as const;
    const sessionId = randomUUID();
    await db.insert(adapterAuthSessions).values({ companyId, environmentId: environment.id, adapterType: "claude_local", startedByUserId: "alice", publicSessionId: sessionId, status: "submitting", aiConnection: { ...intent, agentIds: [] }, expiresAt: new Date(Date.now() + 60000) });
    const first = await service.save(companyId, "alice", { ...intent, agentIds: [] }, "fixture-subscription", sessionId);
    expect(await service.save(companyId, "alice", { ...intent, agentIds: [] }, "fixture-subscription", sessionId)).toEqual(first);
    const cancelled = randomUUID();
    await db.insert(adapterAuthSessions).values({ companyId, environmentId: environment.id, adapterType: "claude_local", startedByUserId: "alice", publicSessionId: cancelled, status: "cancelled", expiresAt: new Date(Date.now() + 60000) });
    await expect(service.save(companyId, "alice", { ...intent, agentIds: [] }, "fixture-never-save", cancelled)).rejects.toThrow("no longer active");
  });
  it("preserves connection identity and defaults through reconnect; revocation wins over older attempts", async () => {
    const current = await service.select({ ...input, userId: "bob" });
    const reconnect = { ...binding, ownership: "personal" as const, name: current.connection.name, apiKey: "fixture", agentIds: [], allAgents: true, connectionId: current.connection.id };
    const result = await service.save(companyId, "bob", reconnect, "fixture-reconnected");
    expect(result.grantId).toBe(current.grant.id);
    expect(await service.credential(await service.select({ ...input, userId: "bob" }))).toBe("fixture-reconnected");
    const beforeRevocation = new Date(Date.now() - 1000);
    await db.update(connectionGrants).set({ status: "revoked", updatedAt: new Date() }).where(eq(connectionGrants.id, current.grant.id));
    await expect(service.save(companyId, "bob", reconnect, "fixture-stale", undefined, beforeRevocation)).rejects.toThrow("changed");
    await expect(service.select({ ...input, userId: "bob" })).rejects.toThrow("Reconnect");
  });
  it("refuses to downgrade a durable setup-token credential through an ordinary reconnect", async () => {
    const setupToken = `sk-ant-oat01-${"c".repeat(40)}`;
    const intent = { provider: "anthropic", method: "subscription", ownership: "personal", name: "Setup token account", agentIds: [], allAgents: true } as const;
    const saved = await service.save(companyId, "alice", intent, setupToken);
    const row = async () => (await db.select({ connection: toolConnections, grant: connectionGrants }).from(toolConnections)
      .innerJoin(connectionGrants, eq(connectionGrants.connectionId, toolConnections.id))
      .where(eq(toolConnections.id, saved.connectionId)))[0];
    // An ordinary "Sign in" click reconnecting the same subscription method must not
    // silently overwrite the durable setup token with a short-lived login credential.
    await expect(service.save(companyId, "alice", { ...intent, connectionId: saved.connectionId }, "fixture-ordinary-login"))
      .rejects.toThrow("long-lived setup token");
    expect(await service.credential(await row())).toBe(setupToken);
    // Replacing it with another pasted setup token is still allowed.
    const rotatedSetupToken = `sk-ant-oat01-${"d".repeat(40)}`;
    await service.save(companyId, "alice", { ...intent, connectionId: saved.connectionId }, rotatedSetupToken);
    expect(await service.credential(await row())).toBe(rotatedSetupToken);
  });
  it("rejects invalid purpose/transport combinations in the database", async () => {
    const selected = await service.select({ ...input, userId: "alice" });
    await expect(db.update(toolConnections).set({ transport: "mcp_remote" }).where(eq(toolConnections.id, selected.connection.id))).rejects.toThrow();
    await expect(db.update(toolConnections).set({ connectionPurpose: "tool" }).where(eq(toolConnections.id, selected.connection.id))).rejects.toThrow();
  });
  it("indexes only known user credentials, retains references, and is repeatable without adopting agents", async () => {
    const selected = await service.select({ ...input, userId: "alice" });
    const [emailConnection] = await db.insert(toolConnections).values({
      companyId,
      applicationId: selected.connection.applicationId,
      name: "Existing AgentMail inbox",
      uid: `agentmail-migration-${randomUUID()}`,
      connectionPurpose: "channel",
      transport: "rest_api",
      authKind: "api_key",
      config: { provider: "agentmail" },
    }).returning();
    const vault = secretService(db);
    const definition = await vault.createUserSecretDefinition(companyId, { key: "legacy_claude", name: "Existing owned Claude key", provider: "local_encrypted" }, { userId: "alice" });
    const secret = await vault.createCurrentUserSecretValue(companyId, "alice", { definitionId: definition.id, value: "fixture-legacy" }, { userId: "alice" });
    await vault.syncUserSecretDeclarationsForTarget(companyId, { targetType: "agent", targetId: agentId }, [{ definitionKey: definition.key, configPath: "env.ANTHROPIC_API_KEY", envKey: "ANTHROPIC_API_KEY", required: true }]);
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0276_hard_mandroid.sql", import.meta.url), "utf8");
    const adoption = migration.slice(migration.indexOf("DO $$", migration.indexOf("-- Only declared")));
    await db.execute(sql.raw(adoption));
    const before = await service.list(companyId, "alice");
    for (const statement of migration.split("--> statement-breakpoint").filter(value => value.trim())) await db.execute(sql.raw(statement));
    expect(await service.list(companyId, "alice")).toEqual(before);
    const [preservedEmail] = await db.select().from(toolConnections).where(eq(toolConnections.id, emailConnection.id));
    expect(preservedEmail).toEqual(emailConnection);
    const indexed = before.find(account => account.name === secret.name)!;
    expect(indexed.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, indexed.grantId));
    expect(grant.credentialSecretRefs[0].secretId).toBe(secret.id);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.runtimeConfig.aiConnection).toBeUndefined();
  });
  it("runs two Claude subscription executions for the same grant at the same time", async () => {
    // Claude writes no auth file back to the grant, so two runs share no
    // mutable state and must not wait for each other.
    const subscription = { ...input, binding: { ...binding, method: "subscription" as const }, responsibleUserId: "alice", config: { model: "same-model" } };
    const account = (await service.list(companyId, "alice")).find(account => account.provider === "anthropic" && account.method === "subscription")!;
    await service.setDefault(companyId, "alice", account.grantId);
    const [first, second] = await Promise.all([prepareManagedAiRuntime(db, subscription), prepareManagedAiRuntime(db, subscription)]);
    try {
      expect(second.identity).toBe(first.identity);
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }
  });
  it("runs a same-agent OpenAI subscription child alongside a still-open parent", async () => {
    const userId = "subscription-contention-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const credential = JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id", account_id: "fixture-account" } });
    const account = await service.save(companyId, userId, { provider: "openai", method: "subscription", ownership: "personal", name: "Contention fixture", loginSessionId: "fixture", allAgents: true, agentIds: [] }, credential);
    const runInput = {
      companyId,
      agentId,
      adapterType: "codex_local",
      responsibleUserId: userId,
      binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const,
      config: {},
    };
    // A parent can create and assign a child before its own execution ends.
    // Both runs select the same personal subscription, even on the same agent.
    const parent = await prepareManagedAiRuntime(db, runInput);
    const child = await prepareManagedAiRuntime(db, runInput);
    try {
      expect(child.identity).toBe(parent.identity);
      expect(child.attribution.grantId).toBe(account.grantId);
      expect(parent.attribution.subscriptionId).toEqual(expect.any(String));
      expect(child.attribution.subscriptionId).toBe(parent.attribution.subscriptionId);
      expect(child.config.managedAiConnection).toMatchObject({ subscriptionId: parent.attribution.subscriptionId });
    } finally {
      await Promise.all([parent.cleanup(), child.cleanup()]);
    }
  });
  it("persists the freshest refreshed credential to its original grant across a same-account reconnect", async () => {
    const auth = (marker: string, hour: number) => JSON.stringify({ tokens: { account_id: "fixture-account", id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    const intent = { provider: "openai" as const, method: "subscription" as const, name: "Refresh test", ownership: "personal" as const, agentIds: [], allAgents: true, loginSessionId: "fixture" };
    const saved = await service.save(companyId, "alice", intent, auth("first", 10));
    const runInput = { ...input, adapterType: "codex_local", responsibleUserId: "alice", binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, config: { model: "same-model" } };
    const first = await prepareManagedAiRuntime(db, runInput);
    await writeFile(path.join(String(first.config.env.CODEX_HOME), "auth.json"), auth("refreshed", 11));
    await first.cleanup();
    const selected = await service.select({ ...runInput, userId: "alice" });
    expect(await service.credential(selected)).toBe(auth("refreshed", 11));
    const second = await prepareManagedAiRuntime(db, runInput);
    expect(second.identity).not.toBe(first.identity);
    // A same-account reconnect writes an older last_refresh than the run
    // that is still open.
    await service.save(companyId, "alice", { ...intent, connectionId: saved.connectionId }, auth("reconnect", 12));
    await writeFile(path.join(String(second.config.env.CODEX_HOME), "auth.json"), auth("later-refresh", 13));
    await second.cleanup();
    // The newer refresh persists to the grant it started from.
    expect(await service.credential(await service.select({ ...runInput, userId: "alice" }))).toBe(auth("later-refresh", 13));
  });
  it("resolves two concurrent OpenAI subscription write-backs by freshness, not by order", async () => {
    const userId = "concurrent-freshness-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (marker: string, hour: number) => JSON.stringify({ tokens: { account_id: "fixture-account", id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    await service.save(companyId, userId, { provider: "openai", method: "subscription", ownership: "personal", name: "Freshness fixture", loginSessionId: "fixture", allAgents: true, agentIds: [] }, auth("start", 10));
    const runInput = { ...input, adapterType: "codex_local", responsibleUserId: userId, binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, config: { model: "same-model" } };
    // Two runs use the same OpenAI subscription grant at the same time.
    // Neither call below throws ai_connection_busy.
    const older = await prepareManagedAiRuntime(db, runInput);
    const newer = await prepareManagedAiRuntime(db, runInput);
    await writeFile(path.join(String(older.config.env.CODEX_HOME), "auth.json"), auth("older", 11));
    await writeFile(path.join(String(newer.config.env.CODEX_HOME), "auth.json"), auth("newer", 12));
    // The run with the newer last_refresh writes back first. The run with
    // the older last_refresh writes back last and must not overwrite it.
    await newer.cleanup();
    await older.cleanup();
    const stored = await service.credential(await service.select({ ...runInput, userId }));
    expect(stored).toBe(auth("newer", 12));
  });
  it("resolves two concurrent OpenAI subscription write-backs by freshness in reverse arrival order", async () => {
    const userId = "concurrent-freshness-reverse-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (marker: string, hour: number) => JSON.stringify({ tokens: { account_id: "fixture-account", id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    await service.save(companyId, userId, { provider: "openai", method: "subscription", ownership: "personal", name: "Reverse freshness fixture", loginSessionId: "fixture", allAgents: true, agentIds: [] }, auth("start", 10));
    const runInput = { ...input, adapterType: "codex_local", responsibleUserId: userId, binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, config: { model: "same-model" } };
    // Two runs use the same OpenAI subscription grant at the same time.
    // Neither call below throws ai_connection_busy.
    const older = await prepareManagedAiRuntime(db, runInput);
    const newer = await prepareManagedAiRuntime(db, runInput);
    await writeFile(path.join(String(older.config.env.CODEX_HOME), "auth.json"), auth("older", 11));
    await writeFile(path.join(String(newer.config.env.CODEX_HOME), "auth.json"), auth("newer", 12));
    // The run with the older last_refresh writes back first. The run with
    // the newer last_refresh writes back last and must win.
    await older.cleanup();
    await newer.cleanup();
    const stored = await service.credential(await service.select({ ...runInput, userId }));
    expect(stored).toBe(auth("newer", 12));
  });
  it("resolves two concurrent xAI subscription write-backs by freshness, not by order", async () => {
    const userId = "concurrent-freshness-xai-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const identityKey = "https://auth.x.ai::33333333-3333-3333-3333-333333333333";
    const auth = (marker: string, expiresAtMs: number) => JSON.stringify({ [identityKey]: { key: `key-${marker}`, refresh_token: `refresh-${marker}`, expires_at: new Date(expiresAtMs).toISOString() } });
    const now = Date.now();
    await service.save(companyId, userId, { provider: "xai", method: "subscription", ownership: "personal", name: "Grok freshness fixture", loginSessionId: "fixture", allAgents: true, agentIds: [] }, auth("start", now));
    const runInput = { ...input, adapterType: "grok_local", responsibleUserId: userId, binding: { provider: "xai", method: "subscription", mode: "responsible_user" } as const, config: { model: "same-model" } };
    // Two runs use the same xAI subscription grant at the same time.
    // Neither call below throws ai_connection_busy.
    const older = await prepareManagedAiRuntime(db, runInput);
    const newer = await prepareManagedAiRuntime(db, runInput);
    await writeFile(path.join(String(older.config.env.GROK_HOME), "auth.json"), auth("older", now + 60 * 60 * 1000));
    await writeFile(path.join(String(newer.config.env.GROK_HOME), "auth.json"), auth("newer", now + 2 * 60 * 60 * 1000));
    // The run with the older expiry writes back first. The run with the
    // newer expiry writes back last and must win.
    await older.cleanup();
    await newer.cleanup();
    const stored = await service.credential(await service.select({ ...runInput, userId }));
    expect(stored).toBe(auth("newer", now + 2 * 60 * 60 * 1000));
  });
  it("discards a credential write-back when the grant is revoked while the run is open", async () => {
    const userId = "revoked-write-back-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (marker: string, hour: number) => JSON.stringify({ tokens: { account_id: "fixture-account", id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    const saved = await service.save(companyId, userId, { provider: "openai", method: "subscription", ownership: "personal", name: "Revocation fixture", loginSessionId: "fixture", allAgents: true, agentIds: [] }, auth("start", 10));
    const runInput = { ...input, adapterType: "codex_local", responsibleUserId: userId, binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, config: { model: "same-model" } };
    const run = await prepareManagedAiRuntime(db, runInput);
    const [grantBeforeCleanup] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, saved.grantId));
    const ref = grantBeforeCleanup.credentialSecretRefs.find(r => r.configPath === "ai.credential")!;
    const [secretBefore] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
    // A newer last_refresh would win the freshness merge if the grant stayed
    // active. The revoked grant must discard the write-back before that merge
    // decides anything.
    await writeFile(path.join(String(run.config.env.CODEX_HOME), "auth.json"), auth("revoked-run", 11));
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, saved.grantId));
    await run.cleanup();
    const [secretAfter] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
    // service.select rejects a revoked grant, so it cannot read the stored
    // credential here. Compare the stored secret version directly instead.
    expect(secretAfter.latestVersion).toBe(secretBefore.latestVersion);
  });
  it("does not let a stale write-back overwrite an authorized secret rotation that commits while cleanup waits on the credential lock", async () => {
    const userId = "credential-lock-race-user";
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const auth = (marker: string, hour: number) => JSON.stringify({ tokens: { account_id: "fixture-account", id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
    const saved = await service.save(companyId, userId, { provider: "openai", method: "subscription", ownership: "personal", name: "Credential lock race fixture", loginSessionId: "fixture", allAgents: true, agentIds: [] }, auth("start", 10));
    const runInput = { ...input, adapterType: "codex_local", responsibleUserId: userId, binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, config: { model: "same-model" } };
    const run = await prepareManagedAiRuntime(db, runInput);
    // The run's own refresh looks newer than the value it started with, but
    // it must lose to a company-authorized rotation that commits while
    // cleanup is still waiting on the credential secret's row lock.
    await writeFile(path.join(String(run.config.env.CODEX_HOME), "auth.json"), auth("run-refresh", 11));
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, saved.grantId));
    const ref = grant.credentialSecretRefs.find(r => r.configPath === "ai.credential")!;
    let holdAcquired!: () => void;
    const holdAcquiredPromise = new Promise<void>(resolve => { holdAcquired = resolve; });
    let releaseHold!: () => void;
    const holdReleased = new Promise<void>(resolve => { releaseHold = resolve; });
    // An authorized rotation writes the new credential inside its own open
    // transaction, so it still holds the secret row's lock when signaled.
    const holder = db.transaction(async tx => {
      await secretService(tx).rotate(ref.secretId, { value: auth("authorized-rotation", 12) }, { userId });
      holdAcquired();
      await holdReleased;
    });
    await holdAcquiredPromise;
    const cleanupPromise = run.cleanup();
    releaseHold();
    await holder;
    await cleanupPromise;
    const stored = await service.credential(await service.select({ ...runInput, userId }));
    expect(stored).toBe(auth("authorized-rotation", 12));
  });
  it("enforces the shared transport discriminator and existing harness compatibility", () => {
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "ai", transport: "mcp_remote" }).success).toBe(false);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "tool", transport: "runtime_auth" }).success).toBe(false);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "channel", transport: "rest_api", config: { provider: "agentmail" } }).success).toBe(true);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "channel", transport: "rest_api", config: { provider: "slack" } }).success).toBe(false);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "channel", transport: "runtime_auth", config: { provider: "agentmail" } }).success).toBe(false);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "channel", transport: "voice", config: { provider: "speko" } }).success).toBe(true);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "channel", transport: "voice", config: { provider: "slack" } }).success).toBe(false);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "channel", transport: "chat_sdk", config: { provider: "speko" } }).success).toBe(false);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "tool", transport: "voice", config: { provider: "speko" } }).success).toBe(false);
    expect(aiConnectionBindingSchema.safeParse({ provider: "anthropic", mode: "responsible_user" }).success).toBe(false);
    expect(aiConnectionBindingSchema.safeParse({ provider: "anthropic", mode: "shared", connectionId: randomUUID(), grantId: randomUUID() }).success).toBe(false);
    expect(isAiConnectionCompatible({ provider: "anthropic", method: "api_key", mode: "responsible_user" }, "paperclip_runner", "same-model", "acpx", "claude")).toBe(true);
    expect(isAiConnectionCompatible(binding, "paperclip_runner", "same-model", "acpx", "claude")).toBe(true);
    expect(isAiConnectionCompatible(binding, "paperclip_runner", "same-model", "acpx", "codex")).toBe(false);
    expect(isAiConnectionCompatible({ provider: "openrouter", method: "api_key" }, "opencode_local", "anthropic/model")).toBe(false);
    const setupToken = `sk-ant-oat01-${"a".repeat(40)}`;
    const account = { provider: "anthropic", method: "subscription", name: "Setup token", ownership: "personal" } as const;
    expect(createAiConnectionSchema.safeParse({ ...account, setupToken }).success).toBe(true);
    expect(createAiConnectionSchema.safeParse({ ...account, setupToken: setupToken.slice(0, 20) }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({ ...account, setupToken, loginSessionId: "fixture" }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({ ...account, provider: "openai", setupToken }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({ ...account, method: "api_key", setupToken }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({ ...account, method: "api_key", apiKey: "fixture" }).success).toBe(true);
    expect(createAiConnectionSchema.safeParse({ ...account, loginSessionId: "fixture" }).success).toBe(true);
  });
  it("does not let a forged delegation bypass human access or accept an expired subscription attempt", async () => {
    const selected = await service.select({ ...input, userId: "alice" });
    const otherAgent = randomUUID();
    await db.insert(agents).values({ id: otherAgent, companyId, name: "Other" });
    await db.insert(connectionGrantDelegations).values({ companyId, grantId: selected.grant.id, agentId: otherAgent, createdByUserId: "bob" });
    await expect(service.select({ ...input, agentId: otherAgent, userId: "bob", binding: { ...binding, method: selected.attribution.method, mode: "delegated", connectionId: selected.connection.id, grantId: selected.grant.id } })).rejects.toThrow("not shared");
    const [environment] = await db.select().from(environments).limit(1);
    const sessionId = randomUUID();
    const intent = { provider: "anthropic", method: "subscription", ownership: "personal", name: "Expired", agentIds: [], allAgents: true } as const;
    await db.insert(adapterAuthSessions).values({ companyId, environmentId: environment.id, adapterType: "claude_local", startedByUserId: "alice", publicSessionId: sessionId, status: "submitting", aiConnection: { ...intent, agentIds: [] }, expiresAt: new Date(Date.now() - 1000) });
    await expect(service.save(companyId, "alice", { ...intent, agentIds: [] }, "fixture-never-save", sessionId)).rejects.toThrow("no longer active");
    expect((await service.list(companyId, "alice")).some(account => account.name === "Expired")).toBe(false);
  });
  it("authorizes account creation, reconnect and defaults at the HTTP boundary before provider calls", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userId = String(req.headers["x-test-user"] ?? "alice");
      const role = req.headers["x-test-role"] === "viewer" ? "viewer" : "member";
      req.actor = { type: "board", source: "session", userId, companyIds: [companyId], memberships: [{ companyId, membershipRole: role, status: "active" }] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const personal = await service.select({ ...input, userId: "alice" });
    const base = `/api/companies/${companyId}/ai-connections`;
    expect((await request(app).get(`/api/companies/${otherCompanyId}/ai-connections`)).status).toBe(403);
    expect((await request(app).put(`${base}/default`).set("x-test-user", "bob").send({ grantId: personal.grant.id })).status).toBe(403);
    expect((await request(app).put(`${base}/default`).set("x-test-role", "viewer").send({ grantId: personal.grant.id })).status).toBe(403);
    const payload = { provider: "anthropic", method: "api_key", name: "Fixture", ownership: "personal", apiKey: "fixture", allAgents: false, agentIds: [] };
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not reach provider"));
    try {
      expect((await request(app).post(base).set("x-test-role", "viewer").send(payload)).status).toBe(403);
      expect((await request(app).post(base).send({ ...payload, ownership: "shared" })).status).toBe(403);
      expect((await request(app).post(base).set("x-test-user", "bob").send({ ...payload, connectionId: personal.connection.id })).status).toBe(403);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it.each(["anthropic", "openai"] as const)("reports a missing %s browser process after a server restart", async provider => {
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local")).limit(1);
    const id = randomUUID();
    const owner = `restart-${provider}`;
    const intent = { provider, method: "subscription", ownership: "personal", name: "Interrupted sign-in", allAgents: false, agentIds: [] } as const;
    await db.insert(adapterAuthSessions).values({ id, publicSessionId: id, companyId, environmentId: environment.id, startedByUserId: owner, adapterType: provider === "anthropic" ? "claude_local" : "codex_local", aiConnection: { ...intent, agentIds: [] }, connectionMethod: "local_subscription", status: "waiting_for_user", expiresAt: new Date(Date.now() + 60_000) });
    const reader = vi.spyOn(localCredentials, "readVerifiedLocalAiCredential").mockRejectedValue(new Error("No credential yet"));
    try {
      const login = localAiLoginService(db);
      await expect(login.check(companyId, owner, { ...intent, agentIds: [] }, id)).resolves.toEqual({ status: "sign_in_required", error: "The server restarted during sign-in. Start sign-in again." });
      await expect(login.check(companyId, "bob", { ...intent, agentIds: [] }, id)).rejects.toThrow("not found");
      reader.mockResolvedValue("completed-before-restart");
      await expect(login.check(companyId, owner, { ...intent, agentIds: [] }, id)).resolves.toEqual({ status: "ready" });
    } finally { reader.mockRestore(); await db.delete(adapterAuthSessions).where(eq(adapterAuthSessions.id, id)); }
  });
  it("saves a pasted Claude setup token as a subscription and injects it at run time", async () => {
    const user = "setup-token-user";
    await db.insert(companyMemberships).values({ companyId, principalId: user, principalType: "user", status: "active", membershipRole: "admin" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: user, companyIds: [companyId], memberships: [{ companyId, membershipRole: "admin", status: "active" }] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use(errorHandler);
    const setupToken = `sk-ant-oat01-${"b".repeat(80)}`;
    const base = `/api/companies/${companyId}/ai-connections`;
    const payload = { provider: "anthropic", method: "subscription", name: "Claude setup token", ownership: "personal", agentIds: [], allAgents: true };
    // The token has no usage scope, so saving it must not call the provider.
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not reach provider"));
    try {
      expect((await request(app).post(base).send(payload)).status).toBe(400);
      expect((await request(app).post(base).send({ ...payload, setupToken: "not-a-setup-token" })).status).toBe(400);
      const saved = await request(app).post(base).send({ ...payload, setupToken });
      expect(saved.status).toBe(201);
      expect(JSON.stringify(saved.body)).not.toContain(setupToken);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
    const run = await prepareManagedAiRuntime(db, { ...input, responsibleUserId: user, binding: { provider: "anthropic", method: "subscription", mode: "responsible_user" }, config: { model: "same-model" } });
    try {
      expect((run.config.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN).toBe(setupToken);
    } finally { await run.cleanup(); }
  });
  it("requires an owned browser sign-in attempt for local subscriptions", async () => {
    const reader = vi.spyOn(localCredentials, "readVerifiedLocalAiCredential").mockResolvedValue("fixture-local-token");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: req.headers["x-local"] === "yes" ? "local_implicit" : "session", userId: String(req.headers["x-test-user"] ?? "alice"), companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const url = `/api/companies/${companyId}/ai-connections/local`;
    const payload = { provider: "anthropic", method: "subscription", name: "Local account test", ownership: "personal", agentIds: [agentId], allAgents: false };
    try {
      expect((await request(app).post(url).send(payload)).status).toBe(403);
      expect(reader).not.toHaveBeenCalled();
      expect((await request(app).post(`${url}/check`).send(payload)).status).toBe(403);
      expect(reader).not.toHaveBeenCalled();
      const checked = await request(app).post(`${url}/check`).set("x-local", "yes").send(payload);
      expect(checked.status).toBe(422);
      expect((await service.list(companyId, "alice")).some(c => c.name === payload.name)).toBe(false);
      const connected = await request(app).post(url).set("x-local", "yes").send(payload);
      expect(connected.status).toBe(422);
      expect(reader).not.toHaveBeenCalled();
      const codex = { ...payload, provider: "openai", name: "Isolated terminal login" };
      const attempts = `${url}/attempts`;
      expect((await request(app).post(attempts).send(codex)).status).toBe(403); // This member cannot authorize agentId.
      expect((await request(app).post(url).set("x-local", "yes").send(codex)).status).toBe(422);
      const prepared = await request(app).post(attempts).set("x-local", "yes").send(codex);
      expect(prepared.status).toBe(201);
      expect(prepared.body.command).toBeUndefined();
      expect((await request(app).post(attempts).set("x-local", "yes").send(codex)).body).toEqual(prepared.body);
      expect((await request(app).delete(`${attempts}/${prepared.body.sessionId}`).set("x-test-user", "bob").send()).status).toBe(404);
      expect((await request(app).delete(`${attempts}/${prepared.body.sessionId}`).set("x-local", "yes").send()).status).toBe(200);
      expect((await request(app).post(url).set("x-local", "yes").send({ ...codex, localSessionId: prepared.body.sessionId })).status).toBe(422);
    } finally { reader.mockRestore(); }
  });
  it.each(["anthropic", "openai"] as const)("blocks server-host %s login on a public deployment without a trusted host", async provider => {
    const reader = vi.spyOn(localCredentials, "readVerifiedLocalAiCredential");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "alice", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "public", trustedLocalStdioRuntimeHost: "" }));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const base = `/api/companies/${companyId}/ai-connections/local`;
    const intent = { provider, method: "subscription", ownership: "personal", name: "Hosted account", allAgents: false, agentIds: [] };
    try {
      for (const endpoint of [base, `${base}/attempts`, `${base}/check`]) {
        const result = await request(app).post(endpoint).send(intent);
        expect(result.status).toBe(422);
        expect(result.body.error).toContain("unavailable on this hosted instance");
      }
      expect(reader).not.toHaveBeenCalled();
    } finally { reader.mockRestore(); }
  });
  it.each(["anthropic", "openai"] as const)("lets authenticated users connect only their own isolated %s login", async provider => {
    const owner = `self-hosted-${provider}`;
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const reader = vi.spyOn(localCredentials, "readVerifiedLocalAiCredential").mockResolvedValue("isolated-fixture-token");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: String(req.headers["x-test-user"] ?? owner), companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: req.headers["x-viewer"] ? "viewer" : "member" }] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const base = `/api/companies/${companyId}/ai-connections/local`;
    const intent = { provider, method: "subscription", ownership: "personal", name: `Self-hosted ${provider}`, allAgents: false, agentIds: [] };
    try {
      expect((await request(app).post(`${base}/attempts`).set("x-viewer", "yes").send(intent)).status).toBe(403);
      const started = await request(app).post(`${base}/attempts`).send(intent);
      expect(started.status).toBe(201);
      expect(started.headers["cache-control"]).toBe("no-store");
      expect(started.body.command).toBeUndefined();
      expect((await request(app).post(`${base}/attempts`).send(intent)).body).toEqual(started.body);
      const input = { ...intent, localSessionId: started.body.sessionId };
      for (const endpoint of [base, `${base}/check`]) {
        expect((await request(app).post(endpoint).set("x-test-user", "bob").send(input)).status).toBe(404);
        expect((await request(app).post(endpoint.replace(companyId, otherCompanyId)).send(input)).status).toBe(403);
      }
      if (provider === "anthropic") {
        const codeUrl = `${base}/attempts/${started.body.sessionId}/code`;
        expect((await request(app).post(codeUrl).set("x-test-user", "bob").send({ browserCode: "fixture-code" })).status).toBe(404);
        expect((await request(app).post(codeUrl).send({ browserCode: "fixture-code" })).status).toBe(422);
      }
      expect(reader).not.toHaveBeenCalled();
      const checked = await request(app).post(`${base}/check`).send(input);
      expect(checked.body).toEqual({ status: "ready" });
      expect(reader).toHaveBeenLastCalledWith(provider, path.join(home, "instances/ai-connection-fixture/ai-local-logins", started.body.sessionId));
      const saved = await request(app).post(base).send(input);
      expect(saved.status).toBe(201);
      expect((await request(app).post(base).send(input)).body).toEqual(saved.body);
      expect(JSON.stringify(saved.body)).not.toContain("isolated-fixture-token");
      expect((await service.list(companyId, owner)).filter(c => c.name === intent.name)).toHaveLength(1);
    } finally { reader.mockRestore(); }
  });
  it("rejects invalid credentials without exposing the provider response", async () => {
    const request = vi.fn().mockResolvedValue(new Response("secret-provider-body", { status: 401 }));
    await expect(validateAiApiKey("anthropic", "fixture", request)).rejects.toThrow("rejected");
    expect(request.mock.calls[0][1].redirect).toBe("error");
  });
  it("uses the authenticated responsible user for agent-originated configuration and tests", async () => {
    const req = { actor: { type: "agent", agentId, onBehalfOfUserId: "alice" } } as express.Request;
    const selected = await service.select({ ...input, userId: responsibleUserForAiRequest(req) });
    expect(selected.grant.subjectUserId).toBe("alice");
    req.actor.onBehalfOfUserId = undefined;
    expect(responsibleUserForAiRequest(req)).toBeNull();
    await expect(service.select({ ...input, userId: responsibleUserForAiRequest(req) })).rejects.toThrow();
  });

  it("protects active-run attribution with the connection human audience", async () => {
    const account = await create("alice", "Private run attribution");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { aiConnection: { connectionId: account.connectionId, grantId: account.grantId } } });
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: String(req.headers["x-test-user"] ?? "alice"), companyIds: [companyId] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const url = `/api/companies/${companyId}/ai-connections/${account.connectionId}/active-runs`;
    const own = await request(app).get(url);
    expect(own.status).toBe(200);
    expect(own.headers["cache-control"]).toBe("no-store");
    expect(own.body).toEqual([expect.objectContaining({ id: runId, agentId })]);
    expect((await request(app).get(url).set("x-test-user", "bob")).status).toBe(404);
    await db.update(connectionGrants).set({ kind: "organization", subjectUserId: null }).where(eq(connectionGrants.id, account.grantId));
    await db.insert(connectionGrantMembers).values({ companyId, grantId: account.grantId, subjectType: "user", subjectId: "alice" });
    expect((await request(app).get(url).set("x-test-user", "bob")).status).toBe(404);
    await db.insert(connectionGrantMembers).values({ companyId, grantId: account.grantId, subjectType: "user", subjectId: "bob" });
    expect((await request(app).get(url).set("x-test-user", "bob")).body).toEqual(own.body);
    expect((await request(app).get(url.replace(companyId, otherCompanyId))).status).toBe(403);
  });
  it("permits new-agent shared installation only for a connection configurator, without bypassing audience", async () => {
    const account = await service.save(companyId, "alice", { provider: "anthropic", method: "api_key", ownership: "shared", name: "Restricted shared", apiKey: "fixture", agentIds: [], allAgents: false }, "fixture-restricted");
    const selected = { provider: "anthropic", method: "api_key", mode: "shared", ...account } as const;
    const futureAgentId = randomUUID();
    const req = (userId: string, role = "member") => ({ actor: { type: "board", source: "session", userId, companyIds: [companyId], memberships: [{ companyId, membershipRole: role, status: "active" }] } }) as express.Request;
    expect(await canInstallSharedAiConnectionForNewAgent(db, req("alice"), companyId, selected)).toBe(true);
    expect(await canInstallSharedAiConnectionForNewAgent(db, req("bob"), companyId, selected)).toBe(false);
    expect(await canInstallSharedAiConnectionForNewAgent(db, req("alice", "viewer"), companyId, selected)).toBe(false);
    expect(await canInstallSharedAiConnectionForNewAgent(db, { actor: { type: "agent", onBehalfOfUserId: "alice" } } as express.Request, companyId, selected)).toBe(false);
    const selectionInput = { ...input, agentId: futureAgentId, userId: "alice", binding: selected };
    await expect(service.select(selectionInput)).rejects.toThrow("not permitted for this agent");
    const run = await prepareManagedAiRuntime(db, { companyId, agentId: futureAgentId, responsibleUserId: "alice", adapterType: "claude_local", binding: selected, config: { cwd: home, model: "same-model" }, allowUninstalledShared: true });
    expect(run.config.model).toBe("same-model");
    await run.cleanup();
    await db.insert(connectionGrantMembers).values({ companyId, grantId: account.grantId, subjectType: "user", subjectId: "bob" });
    await expect(service.select({ ...selectionInput, allowUninstalledShared: true })).rejects.toThrow("not shared with the responsible user");
    await db.delete(connectionGrantMembers).where(eq(connectionGrantMembers.grantId, account.grantId));
    await db.insert(agents).values({ id: futureAgentId, companyId, name: "New shared agent", adapterType: "claude_local" });
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: account.connectionId, targetType: "agent", targetId: futureAgentId, createdByUserId: "alice" });
    expect((await service.select(selectionInput)).grant.id).toBe(account.grantId);
  });

  it.each([false, true])("validates runner account adoption in the inherited sandbox (inline: %s)", async (inline) => {
    const { agentRoutes } = await import("../routes/agents.js");
    const { instanceSettingsService } = await import("../services/instance-settings.js");
    const targetModule = await import("../services/environment-execution-target.js");
    const runtimeModule = await import("../services/environment-runtime.js");
    const { requireServerAdapter } = await import("../adapters/index.js");
    const settings = instanceSettingsService(db);
    const previous = await settings.get();
    const [environment] = await db.insert(environments).values({ name: `Adoption sandbox ${inline}`, driver: "sandbox", config: { provider: "daytona" } }).returning();
    await settings.update({ defaultEnvironmentId: environment.id });
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name: "Runner adoption", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" } });
    const account = await service.save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Runner adoption account", apiKey: "fixture-adoption-key", agentIds: inline ? [] : [id], allAgents: false }, "fixture-adoption-key");
    await service.setDefault(companyId, "alice", account.grantId);
    const tryDeliver = vi.fn(async (interactionId: string) => {
      // Dispatch observes committed adoption, never a partially saved choice.
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId)))[0].status).toBe("accepted");
      expect((await db.select().from(agents).where(eq(agents.id, id)))[0].runtimeConfig.aiConnection).toMatchObject({ mode: "responsible_user" });
    });
    const deliveryModule = await import("../services/connection-intent-delivery.js");
    const delivery = vi.spyOn(deliveryModule, "connectionIntentDeliveryService").mockReturnValue({ tryDeliver } as never);
    let interactionId: string | undefined;
    if (inline) {
      const issueId = randomUUID();
      const runId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: "Atomic adoption", status: "in_progress", assigneeAgentId: id });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: id, status: "failed", errorCode: "acpx_auth_required", responsibleUserId: "alice", contextSnapshot: { issueId } });
      interactionId = (await connectionIntentService(db).requestForRunAuthFailure(runId))!.interactionId!;
    }
    const target = { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", providerKey: "daytona", runner: { execute: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false })) } } as const;
    const resolveTarget = vi.spyOn(targetModule, "resolveEnvironmentExecutionTarget").mockResolvedValue(target);
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn(async () => ({ lease: { id: randomUUID(), provider: "daytona", providerLeaseId: "test-sandbox", metadata: {} }, leaseContext: {} }));
    const runtime = vi.spyOn(runtimeModule, "environmentRuntimeService").mockReturnValue({ acquireRunLease: acquire, realizeWorkspace: vi.fn(async () => ({ cwd: "/workspace" })), getDriver: () => ({ releaseRunLease: release }) } as any);
    const probe = vi.spyOn(requireServerAdapter("paperclip_runner"), "testEnvironment").mockImplementation(async context => ({ adapterType: "paperclip_runner", status: context.executionTarget ? "pass" : "fail", testedAt: new Date().toISOString(), checks: [{ code: context.executionTarget ? "codex_hello_probe_passed" : "host_probe_failed", level: context.executionTarget ? "info" : "error", message: "fixture" }] }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "alice", companyIds: [companyId] }; next(); });
    app.use("/api", agentRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    const selected = { provider: "openai", method: "api_key", mode: "responsible_user" } as const;
    const providerRequest = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 200 }));
    const adopt = () => inline
      ? request(app).post(`/api/agents/${id}/connection-intents/${interactionId}/adopt`).send({ connectionId: account.connectionId })
      : request(app).patch(`/api/agents/${id}`).send({ runtimeConfig: { aiConnection: selected } });
    try {
      // Target resolution can return only warning checks. Adoption still must
      // fail closed, rather than quietly running the probe on the server host.
      resolveTarget.mockResolvedValueOnce(null);
      const unavailable = await adopt();
      expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(422);
      expect(tryDeliver).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(providerRequest).not.toHaveBeenCalled();
      expect((await db.select().from(agents).where(eq(agents.id, id)))[0].runtimeConfig.aiConnection).toBeUndefined();
      if (inline) {
        const assertUnchanged = async () => {
          expect((await db.select().from(agents).where(eq(agents.id, id)))[0].runtimeConfig.aiConnection).toBeUndefined();
          expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, account.connectionId))).toEqual([]);
          expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId!)))[0].status).toBe("pending");
        };
        await assertUnchanged();
        // Force the last write to fail after binding and install changes.
        await db.execute(sql.raw(`CREATE FUNCTION reject_atomic_adoption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${interactionId}'::uuid THEN RAISE EXCEPTION 'injected resolution failure'; END IF; RETURN NEW; END $$`));
        await db.execute(sql.raw("CREATE TRIGGER reject_atomic_adoption BEFORE UPDATE ON issue_thread_interactions FOR EACH ROW EXECUTE FUNCTION reject_atomic_adoption()"));
        try {
          const failed = await adopt();
          expect(failed.status).toBe(500);
          expect(tryDeliver).not.toHaveBeenCalled();
          await assertUnchanged();
        } finally {
          await db.execute(sql.raw("DROP TRIGGER reject_atomic_adoption ON issue_thread_interactions"));
          await db.execute(sql.raw("DROP FUNCTION reject_atomic_adoption()"));
        }
      }
      const saved = await adopt();
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const savedAgent = (await db.select().from(agents).where(eq(agents.id, id)))[0];
      expect(savedAgent.defaultEnvironmentId).toBeNull();
      expect(savedAgent.runtimeConfig.aiConnection).toEqual(inline ? { ...selected, method: "subscription" } : selected);
      if (inline) {
        expect(saved.body.status).toBe("accepted");
        expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, account.connectionId))).toHaveLength(1);
        expect((await adopt()).status).toBe(200);
        expect(tryDeliver).toHaveBeenCalledTimes(2);
        expect(tryDeliver).toHaveBeenCalledWith(interactionId);
      }
      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ companyId, environment: expect.objectContaining({ id: environment.id }) }));
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({ executionTarget: target, config: expect.objectContaining({ provider: "codex", model: "gpt-5.6-sol", managedAiConnection: expect.any(Object) }) }));
      expect(providerRequest).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({
        headers: { Authorization: "Bearer fixture-adoption-key" },
        redirect: "error",
      }));
      expect(release).toHaveBeenCalledTimes(inline ? 3 : 2);
      expect(JSON.stringify(saved.body)).not.toContain("fixture-adoption-key");
    } finally {
      delivery.mockRestore(); providerRequest.mockRestore(); probe.mockRestore(); runtime.mockRestore(); resolveTarget.mockRestore();
      await settings.update({ defaultEnvironmentId: previous.defaultEnvironmentId });
    }
  });

  it("creates and hires agents with an authorized restricted shared connection", async () => {
    const { agentRoutes } = await import("../routes/agents.js");
    await db.update(companies).set({ requireBoardApprovalForNewAgents: false }).where(eq(companies.id, companyId));
    const account = await service.save(companyId, "alice", { provider: "anthropic", method: "api_key", ownership: "shared", name: "Shared creation routes", apiKey: "fixture", agentIds: [], allAgents: false }, "fixture-create-routes");
    const selected = { ...binding, mode: "shared", ...account } as const;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "alice", companyIds: [companyId] };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    for (const endpoint of ["agents", "agent-hires"]) {
      const response = await request(app).post(`/api/companies/${companyId}/${endpoint}`).send({ name: `Shared ${endpoint}`, role: "general", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-6" }, runtimeConfig: { aiConnection: selected } });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const agent = endpoint === "agents" ? response.body : response.body.agent;
      expect(agent.adapterConfig.model).toBe("claude-sonnet-4-6");
      expect(agent.runtimeConfig.aiConnection).toEqual(selected);
      const installs = await db.select().from(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.connectionId, account.connectionId), eq(toolConnectionInstalls.targetId, agent.id)));
      expect(installs).toHaveLength(1);
      expect((await service.select({ ...input, agentId: agent.id, userId: "alice", binding: selected })).grant.id).toBe(account.grantId);
    }
    // A database failure between the two inserts must roll back the agent too.
    await db.execute(sql`CREATE FUNCTION reject_test_ai_install() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture install failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER reject_test_ai_install BEFORE INSERT ON tool_connection_installs FOR EACH ROW EXECUTE FUNCTION reject_test_ai_install()`);
    try {
      for (const endpoint of ["agents", "agent-hires"]) {
        const name = `Rollback ${endpoint}`;
        const response = await request(app).post(`/api/companies/${companyId}/${endpoint}`).send({ name, role: "general", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-6" }, runtimeConfig: { aiConnection: selected } });
        expect(response.status).toBe(500);
        expect(await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, name)))).toEqual([]);
      }
    } finally {
      await db.execute(sql`DROP TRIGGER reject_test_ai_install ON tool_connection_installs`);
      await db.execute(sql`DROP FUNCTION reject_test_ai_install()`);
    }
  }, 30000);

});


describe("AI connection recovery delivery", () => {
  it.each(["ai_connection_unavailable", "secret_binding_missing"].flatMap(reason =>
    ["restored", "newer failure", "different blocker", "revoked again", "closed task"].map(scenario => [reason, scenario]),
  ))(
    "continues only the repaired %s source failure: %s", async (reason, scenario) => {
      const userId = `recovery-${randomUUID()}`;
      const recoveringAgentId = randomUUID();
      const issueId = randomUUID();
      const failedRunId = randomUUID();
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
      await db.insert(agents).values({ id: recoveringAgentId, companyId, name: "Recovery agent", status: "active", adapterType: "claude_local", runtimeConfig: { aiConnection: binding } });
      await db.insert(issues).values({ id: issueId, companyId, title: "Restore selected account", status: "in_progress", assigneeAgentId: recoveringAgentId });
      await db.insert(heartbeatRuns).values({ id: failedRunId, companyId, agentId: recoveringAgentId, status: "running", responsibleUserId: userId, contextSnapshot: { issueId } });
      const intents = connectionIntentService(db);
      const pending = await intents.request({ sub: recoveringAgentId, company_id: companyId, run_id: failedRunId, responsible_user_id: userId }, "anthropic", { purpose: "ai" });
      const account = await create(userId, `Recovered ${scenario}`);
      expect((await intents.setupOptions(pending.interactionId!)).existingConnections.map(connection => connection.id)).toEqual([account.connectionId]);
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "configuration_incomplete", resultJson: { configurationIncomplete: { reason,
        ...(reason === "secret_binding_missing" ? { agentId: recoveringAgentId, missingBindings: [{ bindingType: "user_secret_ref", consumerType: "agent", consumerId: recoveringAgentId, envKey: "ANTHROPIC_API_KEY", configPath: "env.ANTHROPIC_API_KEY", errorCode: "user_secret_missing" }] } : {}),
      } } }).where(eq(heartbeatRuns.id, failedRunId));
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
      await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: issueId, kind: "configuration_validation", cause: "configuration_incomplete", fingerprint: `ai:${issueId}`, nextAction: "Reconnect", ownerType: "board", evidence: { latestRunId: failedRunId } });
      await intents.complete(pending.interactionId!, account.connectionId, userId);
      if (scenario === "newer failure") await db.insert(heartbeatRuns).values({ companyId, agentId: recoveringAgentId, status: "failed", contextSnapshot: { issueId }, createdAt: new Date(Date.now() + 1000) });
      if (scenario === "different blocker") await db.update(issueRecoveryActions).set({ cause: "workspace_validation_failed" }).where(eq(issueRecoveryActions.sourceIssueId, issueId));
      if (scenario === "closed task") await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      if (scenario === "revoked again") {
        await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });
        const repairOptions = await intents.setupOptions(pending.interactionId!);
        expect(repairOptions.existingConnections).toEqual([]);
        expect(repairOptions.aiRepair).toMatchObject({ canReconnect: true, connection: { id: account.connectionId, grantId: account.grantId, isDefault: true, status: "revoked" } });
      }
      const wakeup = vi.fn(async (_agentId, opts) => {
        await db.insert(agentWakeupRequests).values({ companyId, agentId: recoveringAgentId, source: "automation", status: "queued", idempotencyKey: opts.idempotencyKey });
        return null;
      });
      const delivery = connectionIntentDeliveryService(db, { wakeup } as never);
      await delivery.deliver(pending.interactionId!);
      await delivery.deliver(pending.interactionId!);
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      if (scenario === "restored") {
        expect(issue.status).toBe("in_progress");
        expect(wakeup).toHaveBeenCalledTimes(1);
        expect(wakeup).toHaveBeenCalledWith(recoveringAgentId, expect.objectContaining({ contextSnapshot: expect.objectContaining({ forceFreshSession: true }) }));
        expect(await issueRecoveryActionService(db).getActiveForIssue(companyId, issueId)).toBeNull();
        const [receipt] = await db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, pending.interactionId!));
        expect(receipt.deliveredAt).not.toBeNull();
      } else {
        expect(wakeup).not.toHaveBeenCalled();
        expect(issue.status).toBe(scenario === "closed task" ? "done" : "blocked");
      }
    }, 30000,
  );
});

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
