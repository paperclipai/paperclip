import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDb, companies, agents, companyMemberships, adapterAuthSessions, environments, connectionGrants, toolConnections, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { secretService } from "../services/secrets.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { localAiLoginService } from "../services/local-ai-login.js";
import { readVerifiedLocalAiCredential } from "../services/local-ai-credentials.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID(), agentId = randomUUID(), owner = "audit-owner";
beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "ai-legacy-audit-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  database = await startEmbeddedPostgresTestDatabase("ai-legacy-audit-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Audit", issuePrefix: "AUD" });
  await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "owner" });
  await db.insert(environments).values({ name: "Local audit", driver: "local" }).onConflictDoNothing();
  await db.insert(agents).values({ id: agentId, companyId, name: "Unadopted legacy agent", adapterType: "claude_local" });
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); if (home) await rm(home, { recursive: true, force: true }); });

it("reconnect detaches an indexed credential without changing unadopted legacy agents", async () => {
  const vault = secretService(db), service = aiConnectionService(db);
  const definition = await vault.createUserSecretDefinition(companyId, { key: "audit_legacy_claude", name: "Legacy key", provider: "local_encrypted" }, { userId: owner });
  const secret = await vault.createCurrentUserSecretValue(companyId, owner, { definitionId: definition.id, value: "fixture-original" }, { userId: owner });
  const legacyConfig = { env: { ANTHROPIC_API_KEY: { type: "user_secret_ref", key: definition.key, required: true } } };
  await db.update(agents).set({ adapterConfig: legacyConfig }).where(eq(agents.id, agentId));
  await vault.syncUserSecretDeclarationsForTarget(companyId, { targetType: "agent", targetId: agentId }, [{ definitionKey: definition.key, configPath: "env.ANTHROPIC_API_KEY", envKey: "ANTHROPIC_API_KEY", required: true }]);
  const migration = await readFile(new URL("../../../packages/db/src/migrations/0276_hard_mandroid.sql", import.meta.url), "utf8");
  await db.execute(sql.raw(migration.slice(migration.indexOf("DO $$", migration.indexOf("-- Only declared")))));
  const connection = (await service.list(companyId, owner)).find(c => c.name === secret.name)!;
  const resolve = () => vault.resolveUserSecretValue(companyId, { definitionId: definition.id, responsibleUserId: owner, required: true, version: "latest" }, { companyId, responsibleUserId: owner, actorType: "system" });
  expect((await resolve())?.value).toBe("fixture-original");
  await service.save(companyId, owner, { provider: "anthropic", method: "api_key", name: connection.name, ownership: "personal", agentIds: [], allAgents: true, connectionId: connection.id, apiKey: "fixture-new-account" }, "fixture-new-account");
  expect((await resolve())?.value).toBe("fixture-original");
  const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, connection.grantId));
  expect(grant.credentialSecretRefs[0].secretId).not.toBe(secret.id);
  const selected = await service.select({ companyId, agentId, userId: owner, adapterType: "claude_local", binding: { provider: "anthropic", method: "api_key", mode: "responsible_user" } });
  expect(await service.credential(selected)).toBe("fixture-new-account");
  await service.save(companyId, owner, { provider: "anthropic", method: "api_key", name: connection.name, ownership: "personal", agentIds: [], allAgents: true, connectionId: connection.id, apiKey: "fixture-second" }, "fixture-second");
  expect((await resolve())?.value).toBe("fixture-original");
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  expect(agent.runtimeConfig.aiConnection).toBeUndefined();
  expect(agent.adapterConfig).toEqual(legacyConfig);
});

const intent = { provider: "openai", method: "subscription", name: "Isolated Codex", ownership: "personal", agentIds: [], allAgents: true } as const;
const loginIntent = () => ({ ...intent, agentIds: [] });
const auth = (mark: string, hour = 10) => JSON.stringify({ tokens: { account_id: "fixture-account", id_token: `id-${mark}`, access_token: `access-${mark}`, refresh_token: `refresh-${mark}` }, last_refresh: `2026-09-10T${hour}:00:00Z` });
const directoryFor = (id: string) => path.join(resolvePaperclipInstanceRoot(), "ai-local-logins", id);

it("isolates sign-in and refresh from the host, survives restart, and completes only once", async () => {
  const hostHome = path.join(home, "host-codex");
  await mkdir(hostHome);
  await writeFile(path.join(hostHome, "auth.json"), auth("legacy"));
  vi.stubEnv("CODEX_HOME", hostHome);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const login = localAiLoginService(db);
  const attempt = await login.start(companyId, owner, loginIntent());
  const directory = directoryFor(attempt.sessionId);
  expect(await localAiLoginService(db).start(companyId, owner, loginIntent())).toEqual(attempt);
  expect(attempt.command).toContain(`(export CODEX_HOME='${directory}' && mkdir -p "$CODEX_HOME" && codex`);
  expect(await readFile(path.join(directory, "config.toml"), "utf8")).toContain('cli_auth_credentials_store = "file"');
  expect(await login.check(companyId, owner, loginIntent(), attempt.sessionId)).toEqual({ status: "sign_in_required" });
  // Resuming a valid attempt also repairs a missing directory without changing its ID.
  await rm(directory, { recursive: true });
  expect(await login.start(companyId, owner, loginIntent())).toEqual(attempt);
  expect(await readFile(path.join(directory, "config.toml"), "utf8")).toContain('cli_auth_credentials_store = "file"');
  // A valid host login cannot satisfy an unfinished connection-specific login.
  await expect(login.complete(companyId, owner, attempt.sessionId, loginIntent())).rejects.toThrow("sign-in command shown");
  expect((await aiConnectionService(db).list(companyId, owner)).filter(c => c.provider === "openai")).toHaveLength(0);
  await writeFile(path.join(directory, "auth.json"), auth("independent-login"));
  expect(await login.check(companyId, owner, loginIntent(), attempt.sessionId)).toEqual({ status: "ready" });
  expect((await aiConnectionService(db).list(companyId, owner)).filter(c => c.provider === "openai")).toHaveLength(0);
  await expect(login.check(companyId, "another-owner", loginIntent(), attempt.sessionId)).rejects.toThrow("not found");
  await expect(login.check(randomUUID(), owner, loginIntent(), attempt.sessionId)).rejects.toThrow("not found");
  await expect(login.check(companyId, owner, { ...loginIntent(), ownership: "shared" }, attempt.sessionId)).rejects.toThrow("not found");
  // New service instance simulates process restart: all intent is durable.
  const results = await Promise.all([
    localAiLoginService(db).complete(companyId, owner, attempt.sessionId, loginIntent()),
    localAiLoginService(db).complete(companyId, owner, attempt.sessionId, loginIntent()),
  ]);
  expect(results[0]).toEqual(results[1]);
  await expect(readFile(path.join(directory, "auth.json"))).rejects.toHaveProperty("code", "ENOENT");
  const input = { companyId, agentId, adapterType: "codex_local", responsibleUserId: owner, binding: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, config: { cwd: home, model: "unchanged-model" } };
  const run = await prepareManagedAiRuntime(db, input);
  const credentialFile = path.join(String(run.config.env.CODEX_HOME), "auth.json");
  expect(JSON.parse(await readFile(credentialFile, "utf8")).tokens.refresh_token).toBe("refresh-independent-login");
  await writeFile(credentialFile, auth("rotated-independent", 11));
  await run.cleanup();
  expect(await readFile(path.join(hostHome, "auth.json"), "utf8")).toBe(auth("legacy"));
  const next = await prepareManagedAiRuntime(db, input);
  expect(JSON.parse(await readFile(path.join(String(next.config.env.CODEX_HOME), "auth.json"), "utf8")).tokens.refresh_token).toBe("refresh-rotated-independent");
  expect(next.config.model).toBe(input.config.model);
  await next.cleanup();
  // Cancellation after successful completion must not revoke the saved account.
  await login.cancel(companyId, owner, attempt.sessionId);
  expect((await aiConnectionService(db).list(companyId, owner)).find(c => c.id === results[0].connectionId)?.status).toBe("connected");
  expect((await db.select().from(activityLog).where(eq(activityLog.entityId, attempt.sessionId)))
    .filter(event => event.action === "ai_connection.local_login_cancelled")).toHaveLength(0);
  const reconnectIntent = { ...loginIntent(), connectionId: results[0].connectionId };
  const reconnect = await login.start(companyId, owner, reconnectIntent);
  expect(reconnect.sessionId).not.toBe(attempt.sessionId);
  await writeFile(path.join(directoryFor(reconnect.sessionId), "auth.json"), auth("new-login"));
  expect(await login.complete(companyId, owner, reconnect.sessionId, reconnectIntent)).toEqual(results[0]);
  expect(await readFile(path.join(hostHome, "auth.json"), "utf8")).toBe(auth("legacy"));
});

it("enforces local attempt ownership, company, target, cancellation, and expiry", async () => {
  const login = localAiLoginService(db);
  const attempt = await login.start(companyId, owner, loginIntent());
  const cancellations = async () => (await db.select().from(activityLog).where(eq(activityLog.entityId, attempt.sessionId)))
    .filter(event => event.action === "ai_connection.local_login_cancelled");
  await expect(login.complete(companyId, "another-owner", attempt.sessionId, loginIntent())).rejects.toThrow("not found");
  await expect(login.cancel(companyId, "another-owner", attempt.sessionId)).rejects.toThrow("not found");
  await expect(login.cancel(randomUUID(), owner, attempt.sessionId)).rejects.toThrow("not found");
  await expect(login.complete(companyId, owner, attempt.sessionId, { ...loginIntent(), ownership: "shared" })).rejects.toThrow("not found");
  expect(await cancellations()).toHaveLength(0);
  await login.cancel(companyId, owner, attempt.sessionId);
  await login.cancel(companyId, owner, attempt.sessionId);
  expect(await cancellations()).toEqual([expect.objectContaining({
    companyId, actorType: "user", actorId: owner, entityType: "adapter_auth_session",
    entityId: attempt.sessionId, details: { provider: "openai" },
  })]);
  await expect(login.complete(companyId, owner, attempt.sessionId, loginIntent())).rejects.toThrow("cancelled");
  const retry = await login.start(companyId, owner, loginIntent());
  await writeFile(path.join(directoryFor(retry.sessionId), "auth.json"), auth("abandoned"));
  await db.update(adapterAuthSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(adapterAuthSessions.id, retry.sessionId));
  await expect(login.complete(companyId, owner, retry.sessionId, loginIntent())).rejects.toThrow("expired");
  expect(await login.check(companyId, owner, loginIntent(), retry.sessionId)).toEqual({ status: "expired" });
  await localAiLoginService(db).reapExpired();
  await expect(readFile(path.join(directoryFor(retry.sessionId), "auth.json"))).rejects.toHaveProperty("code", "ENOENT");
  const [row] = await db.select().from(adapterAuthSessions).where(eq(adapterAuthSessions.id, retry.sessionId));
  expect(row.status).toBe("timed_out");
});

it("explicit retry replaces another owned local attempt while ordinary navigation preserves it", async () => {
  const login = localAiLoginService(db);
  const first = await login.start(companyId, owner, loginIntent());
  const restricted = { ...loginIntent(), allAgents: false, agentIds: [agentId] };
  await expect(login.start(companyId, owner, restricted)).rejects.toThrow("Another sign-in");
  const retry = await login.start(companyId, owner, restricted, true);
  expect(retry.sessionId).not.toBe(first.sessionId);
  const [old] = await db.select().from(adapterAuthSessions).where(eq(adapterAuthSessions.id, first.sessionId));
  expect(old.status).toBe("cancelled");
  await expect(readFile(path.join(directoryFor(first.sessionId), "config.toml"))).rejects.toHaveProperty("code", "ENOENT");
  expect(await login.start(companyId, owner, restricted)).toEqual(retry);
  await login.cancel(companyId, owner, retry.sessionId);
});

it("blocks preview-era copied subscriptions until isolated reconnect, leaving legacy config intact", async () => {
  const service = aiConnectionService(db);
  const account = (await service.list(companyId, owner)).find(c => c.provider === "openai")!;
  const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.id));
  await db.update(toolConnections).set({ config: { ...connection.config, aiIsolatedSubscription: false } }).where(eq(toolConnections.id, account.id));
  await expect(prepareManagedAiRuntime(db, {
    companyId, agentId, adapterType: "codex_local", responsibleUserId: owner,
    binding: { provider: "openai", method: "subscription", mode: "responsible_user" }, config: { cwd: home },
  })).rejects.toThrow("separate sign-in");
  expect((await service.list(companyId, owner)).find(c => c.id === account.id)?.status).toBe("needs_attention");
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  expect(agent.runtimeConfig.aiConnection).toBeUndefined();
  const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
  expect(grant.status).toBe("active");
});
