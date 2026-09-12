import { connectionIntentService } from "../services/connection-intents.js";
import { connectionIntentDeliveryService } from "../services/connection-intent-delivery.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import * as localCredentials from "../services/local-ai-credentials.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { createDb, companies, agents, heartbeatRuns, companyMemberships, connectionGrants, connectionGrantDelegations, connectionGrantMembers, toolConnections, toolConnectionInstalls, aiConnectionDefaults, adapterAuthSessions, environments, issues, issueThreadInteractions, issueRecoveryActions, connectionIntentDeliveries, agentWakeupRequests } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import * as executionTarget from "@paperclipai/adapter-utils/execution-target";
import { prepareManagedAiRuntime, assertManagedAiProjectAuth } from "../services/ai-connection-runtime.js";
import { toolAccessService } from "../services/tool-access.js";
import { secretService } from "../services/secrets.js";
import { connectionPurposeTransportSchema, isAiConnectionCompatible } from "@paperclipai/shared";
import express from "express";
import request from "supertest";
import { aiConnectionRoutes, canInstallSharedAiConnectionForNewAgent, responsibleUserForAiRequest } from "../routes/ai-connections.js";
import { validateAiApiKey } from "../routes/ai-connections.js";

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
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-tests-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  database = await startEmbeddedPostgresTestDatabase("paperclip-ai-db-");
  db = createDb(database.connectionString);
  service = aiConnectionService(db);
  await db.insert(companies).values([{ id: companyId, name: "AI connection tests", issuePrefix: "AIT" }, { id: otherCompanyId, name: "Other", issuePrefix: "AIO" }]);
  await db.insert(agents).values({ id: agentId, companyId, name: "Nova", adapterType: "claude_local" });
  await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

describe("managed AI connections", () => {
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
    await expect(service.select({ ...input, userId: "bob", binding: delegated })).rejects.toThrow("not shared");
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
    await expect(service.select({ ...input, userId: "bob", binding: sharedBinding })).rejects.toThrow("not shared");
    expect((await service.list(companyId, "bob", agentId)).some(account => account.id === shared.connectionId)).toBe(false);
    await tools.replaceConnectionGrantMembers(shared.connectionId, shared.grantId, ["bob"], { userId: "alice" });
    expect((await service.select({ ...input, userId: "bob", binding: sharedBinding })).grant.id).toBe(shared.grantId);
    expect((await service.list(companyId, "bob", agentId)).some(account => account.id === shared.connectionId)).toBe(true);
    await expect(service.select({ ...input, userId: "alice", binding: sharedBinding })).rejects.toThrow("not shared");
    await tools.replaceConnectionGrantMembers(shared.connectionId, shared.grantId, [], { userId: "alice" });
    for (const userId of ["alice", "bob"]) {
      expect((await service.select({ ...input, userId, binding: sharedBinding })).grant.id).toBe(shared.grantId);
    }
    await expect(service.select({ ...input, userId: null, binding: sharedBinding })).rejects.toThrow("not shared");
    // Human permission still cannot bypass the separate agent-access setting.
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, shared.connectionId));
    await expect(service.select({ ...input, userId: "bob", binding: sharedBinding })).rejects.toThrow("not permitted for this agent");
    expect(sharedBinding).toEqual({ ...binding, mode: "shared", ...shared });
  });
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
  it("serializes subscription refresh and releases the lease after execution", async () => {
    const subscription = { ...input, binding: { ...binding, method: "subscription" as const }, responsibleUserId: "alice", config: { model: "same-model" } };
    const first = await prepareManagedAiRuntime(db, subscription);
    await expect(prepareManagedAiRuntime(db, subscription)).rejects.toThrow("in use");
    await first.cleanup();
    const next = await prepareManagedAiRuntime(db, subscription);
    expect(next.identity).toBe(first.identity);
    await next.cleanup();
  });
  it("persists refreshed credentials only to their original grant and fences reconnects", async () => {
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
    await service.save(companyId, "alice", { ...intent, connectionId: saved.connectionId }, auth("reconnect", 12));
    await writeFile(path.join(String(second.config.env.CODEX_HOME), "auth.json"), auth("stale-process", 13));
    await second.cleanup();
    expect(await service.credential(await service.select({ ...runInput, userId: "alice" }))).toBe(auth("reconnect", 12));
  });
  it("enforces the shared transport discriminator and existing harness compatibility", () => {
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "ai", transport: "mcp_remote" }).success).toBe(false);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "tool", transport: "runtime_auth" }).success).toBe(false);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "channel", transport: "rest_api", config: { provider: "agentmail" } }).success).toBe(true);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "channel", transport: "rest_api", config: { provider: "slack" } }).success).toBe(false);
    expect(connectionPurposeTransportSchema.safeParse({ connectionPurpose: "channel", transport: "runtime_auth", config: { provider: "agentmail" } }).success).toBe(false);
    expect(isAiConnectionCompatible(binding, "paperclip_runner", "same-model", "acpx", "claude")).toBe(true);
    expect(isAiConnectionCompatible(binding, "paperclip_runner", "same-model", "acpx", "codex")).toBe(false);
    expect(isAiConnectionCompatible({ provider: "openrouter", method: "api_key" }, "opencode_local", "anthropic/model")).toBe(false);
  });
  it("does not let a forged delegation bypass human access or accept an expired subscription attempt", async () => {
    const selected = await service.select({ ...input, userId: "alice" });
    const otherAgent = randomUUID();
    await db.insert(agents).values({ id: otherAgent, companyId, name: "Other" });
    await db.insert(connectionGrantDelegations).values({ companyId, grantId: selected.grant.id, agentId: otherAgent, createdByUserId: "bob" });
    await expect(service.select({ ...input, agentId: otherAgent, userId: "bob", binding: { ...binding, mode: "delegated", connectionId: selected.connection.id, grantId: selected.grant.id } })).rejects.toThrow("not shared");
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
  it("imports only for the local operator and preserves identity and permissions on reconnect", async () => {
    const reader = vi.spyOn(localCredentials, "readVerifiedLocalAiCredential").mockResolvedValue("fixture-local-token");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: req.headers["x-local"] === "yes" ? "local_implicit" : "session", userId: "alice", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] };
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
      expect(checked.status).toBe(200);
      expect(checked.body).toEqual({ status: "ready" });
      expect((await service.list(companyId, "alice")).some(c => c.name === payload.name)).toBe(false);
      const connected = await request(app).post(url).set("x-local", "yes").send(payload);
      expect(connected.status).toBe(201);
      expect(JSON.stringify(connected.body)).not.toContain("fixture-local-token");
      const before = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connected.body.connectionId));
      expect(before.map(i => [i.targetType, i.targetId])).toEqual([["agent", agentId]]);
      const reconnected = await request(app).post(url).set("x-local", "yes").send({ ...payload, connectionId: connected.body.connectionId, allAgents: true });
      expect(reconnected.status).toBe(201);
      expect(reconnected.body).toEqual(connected.body);
      const after = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connected.body.connectionId));
      expect(after).toEqual(before);
      reader.mockRejectedValueOnce(Object.assign(new Error("Sign in locally and retry"), { status: 422 }));
      const failed = await request(app).post(url).set("x-local", "yes").send({ ...payload, name: "Unsuccessful local login" });
      expect(failed.status).toBe(422);
      expect((await service.list(companyId, "alice")).some(c => c.name === "Unsuccessful local login")).toBe(false);
      const codex = { ...payload, provider: "openai", name: "Isolated terminal login" };
      const attempts = `${url}/attempts`;
      expect((await request(app).post(attempts).send(codex)).status).toBe(403);
      expect((await request(app).post(url).set("x-local", "yes").send(codex)).status).toBe(422);
      const prepared = await request(app).post(attempts).set("x-local", "yes").send(codex);
      expect(prepared.status).toBe(201);
      expect(prepared.body.command).toMatch(/^\(export CODEX_HOME=.* && mkdir -p .* && codex -c .* login\)$/);
      expect((await request(app).post(attempts).set("x-local", "yes").send(codex)).body).toEqual(prepared.body);
      expect((await request(app).delete(`${attempts}/${prepared.body.sessionId}`).send()).status).toBe(403);
      expect((await request(app).delete(`${attempts}/${prepared.body.sessionId}`).set("x-local", "yes").send()).status).toBe(200);
      expect((await request(app).post(url).set("x-local", "yes").send({ ...codex, localSessionId: prepared.body.sessionId })).status).toBe(422);
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
  it.each(["restored", "newer failure", "different blocker", "revoked again", "closed task"])(
    "continues only the repaired source failure: %s", async (scenario) => {
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
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "configuration_incomplete", resultJson: { configurationIncomplete: { reason: "ai_connection_unavailable" } } }).where(eq(heartbeatRuns.id, failedRunId));
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
