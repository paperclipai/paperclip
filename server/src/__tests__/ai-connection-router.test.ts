import { enableRunFailureReporting } from "./helpers/run-failure-reporting.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb, closeRegisteredClients, companies, agents, authUsers, companyMemberships, connectionGrants, plugins, aiConnectionRouterCursors, aiConnectionTaskPins, toolConnections, companySecrets, heartbeatRuns, issues, dotAgentBindings, grokBotRoutines } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import type { AiConnectionMetadata, AiConnectionPoolMember, AiConnectionRouterRequest, AiConnectionRouterResult, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { aiConnectionRouterService, AiConnectionPoolExhausted, poolMemberRuntimeConfig, applyAiConnectionRouterTaskSettings } from "../services/ai-connection-router.js";
import { aiConnectionSessionCompatibilityInputs } from "../services/ai-connection-session.js";
import { projectPaperclipRunnerTaskConfig, resolvePaperclipRunnerNativeProviderInput } from "../services/native-runtime/provider-profile.js";
import { aiConnectionService } from "../services/ai-connections.js";
import * as aiConnections from "../services/ai-connections.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { environmentService } from "../services/environments.js";
import { createHeartbeatPoolRuntimeValidator } from "../services/heartbeat/environment-selection.js";
import { managedAiSessionFingerprintConfig, prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { secretService } from "../services/secrets.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import express from "express";
import request from "supertest";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { errorHandler } from "../middleware/index.js";
import { heartbeatService, buildEffectiveRunSessionConfigMetadata, resolveTaskSessionConfigFreshness } from "../services/heartbeat.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { waitForPendingRunFailureReports } from "../services/run-failure-report.js";
import { dotRunnerBroker } from "../services/dot-runner-broker.js";
import { isPluginRunnerManagedCredentialSupported } from "../services/native-runtime/plugin-runner-credentials.js";

const captureRunFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../sentry.js")>(),
  captureRunFailure,
}));

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
let db: ReturnType<typeof createDb>;
let home: string;
let isolatedHome: ReturnType<typeof createIsolatedTestHome> | undefined;
const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID(), secondAgentId = randomUUID(), pluginId = randomUUID();
const pluginKey = "fixture.ai-router";
const manifest: PaperclipPluginManifestV1 = { id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Fixture router", description: "Fixture", author: "Tests", categories: ["connector"], capabilities: ["ai.connections.route"], aiConnectionRouter: { name: "AI connection pool", description: "Use saved connections" }, entrypoints: { worker: "worker.js" } };
let members: AiConnectionPoolMember[];
const proposal = vi.fn(async (_id: string, _method: string, request: AiConnectionRouterRequest): Promise<AiConnectionRouterResult> => {
  const next = (request.memberOrder.indexOf(request.lastMemberId ?? "") + 1) % request.memberOrder.length;
  const order = request.pinnedMemberId ? [request.pinnedMemberId] : [...request.memberOrder.slice(next), ...request.memberOrder.slice(0, next)];
  const selected = order.find(id => request.candidates.some(candidate => candidate.member.id === id));
  return selected ? { kind: "selected", memberId: selected } : { kind: "unavailable", skipped: {} };
});
const worker = { isRunning: () => true, call: proposal } as unknown as PluginWorkerManager;
const defaultProposal = proposal.getMockImplementation()!;
const service = () => aiConnectionRouterService(db, worker);
const resolve = (poolId: string, taskKey: string, extra = {}) => service().resolve({ companyId, poolId, agentId, userId: "alice", adapterType: "paperclip_runner", taskKey, ...extra });
const makePool = async (config = {}) => service().save(pluginKey, { companyId, config: { name: randomUUID(), enabled: true, mode: "round_robin", thresholdPercent: 90, members, ...config } }, "alice");
beforeAll(async () => {
  isolatedHome = createIsolatedTestHome();
  home = isolatedHome.home;
  vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "router-fixture");
  if (externalTestDatabaseUrl) db = createDb(externalTestDatabaseUrl);
  else { database = await startEmbeddedPostgresTestDatabase("paperclip-router-db-"); db = createDb(database.connectionString); }
  await db.insert(companies).values([{ id: companyId, name: "Router fixture", issuePrefix: "RTF" }, { id: otherCompanyId, name: "Other", issuePrefix: "RTO" }]);
  await db.insert(agents).values([agentId, secondAgentId].map(id => ({ id, companyId, name: "Router agent", adapterType: "paperclip_runner" })));
  await db.insert(authUsers).values(["alice", "bob"].map(id => ({ id, name: id, email: `${id}@router.example.test`, createdAt: new Date(), updatedAt: new Date() }))).onConflictDoNothing();
  await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
  await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: pluginKey, version: "0.1.0", manifestJson: manifest, status: "ready" });
  const accounts = aiConnectionService(db);
  const codex = await accounts.save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Codex", apiKey: "fixture", agentIds: [], allAgents: true }, "fixture-codex");
  const claude = await accounts.save(companyId, "alice", { provider: "anthropic", method: "subscription", ownership: "personal", name: "Claude", loginSessionId: "fixture", agentIds: [], allAgents: true }, "fixture-claude");
  members = [
    { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...codex }, profile: { provider: "codex", model: "gpt-5.6-sol", effort: "low" } },
    { id: randomUUID(), binding: { mode: "delegated", provider: "anthropic", method: "subscription", ...claude }, profile: { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" } },
  ];
}, 90000);
afterAll(async () => {
  await waitForPendingRunFailureReports();
  if (externalTestDatabaseUrl) await closeRegisteredClients(externalTestDatabaseUrl);
  await db?.$client.end();
  await database?.cleanup(); vi.unstubAllEnvs(); isolatedHome?.cleanup();
});

describe("durable, authorized connection routing", () => {
  it("defaults off and does not expose selectable pools before opt-in", async () => {
    expect((await instanceSettingsService(db).getExperimental()).enableAiConnectionRouters).toBe(false);
    expect((await service().catalog())[0]?.availability).toEqual({ available: false, reason: "Ask your instance operator to enable AI connection routing." });
    await expect(makePool()).rejects.toThrow("instance operator");
    expect(await service().selectable(companyId, "alice")).toEqual([]);
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
  });
  it("saves and selects a chat gateway with the OpenCode harness", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
    const routing = { kind: "gateway", protocol: "chat", auth: "bearer", baseUrl: "https://gateway.example/v1", models: [{ id: "custom/model" }] } as const;
    const account = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Chat gateway", apiKey: "fixture", allAgents: true, agentIds: [], routing: { ...routing, models: [...routing.models] } }, "fixture-gateway");
    const member: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...account }, profile: { provider: "opencode", model: "custom/model" } };
    const pool = await makePool({ members: [member] });
    const originalService = aiConnectionService;
    let selects = 0;
    const spy = vi.spyOn(aiConnections, "aiConnectionService").mockImplementation((client) => {
      const service = originalService(client);
      const originalSelect = service.select;
      const originalAuthorize = service.authorize;
      return { ...service, select: async (...args: Parameters<typeof originalSelect>) => { selects++; return originalSelect(...args); }, authorize: async (...args: Parameters<typeof originalAuthorize>) => { selects++; return originalAuthorize(...args); } };
    });
    try {
      const selected = await resolve(pool.id, "chat-gateway");
      expect(selects).toBeGreaterThan(0);
      expect(selects).toBeLessThanOrEqual(2);
      selects = 0;
      await resolve(pool.id, "chat-gateway");
      expect(selects).toBeLessThanOrEqual(1);
      expect(selected.binding).toEqual(member.binding);
      expect(selected.runtimeConfig).toMatchObject({ provider: "opencode", model: "paperclip/custom/model" });
    } finally {
      spy.mockRestore();
    }
    await expect(makePool({ members: [{ ...member, profile: { provider: "codex", model: "model" } }] })).rejects.toThrow();
    await expect(makePool({ members: [{ ...member, binding: { ...member.binding, provider: "anthropic" } }] })).rejects.toThrow();
    await expect(makePool({ members: [{ ...member, binding: { ...member.binding, method: "subscription" } }] })).rejects.toThrow();
    await expect(makePool({ members: [{ ...members[0]!, profile: { provider: "opencode", model: "custom/model" } }] })).rejects.toThrow();
  });
  it.each(["gateway", "local"] as const)("validates %s pool profiles by routing protocol", (kind) => {
    const route = { kind, baseUrl: kind === "local" ? "http://127.0.0.1:1234" : "https://gateway.example/v1", auth: "bearer" as const, models: [] };
    for (const [protocol, profile, compatibleAdapter, incompatibleAdapter] of [
      ["responses", { provider: "codex", model: "custom" }, "codex_local", "claude_local"],
      ["messages", { provider: "acpx", acpxAgent: "claude", model: "custom" }, "claude_local", "codex_local"],
      ["chat", { provider: "opencode", model: "custom" }, "opencode_local", "codex_local"],
    ] as const) {
      const member = { ...members[0]!, profile };
      const metadata = { provider: "openai" as const, method: "api_key" as const, routing: { ...route, protocol } };
      const expected = { ...profile, model: protocol === "chat" ? "paperclip/custom" : profile.model };
      expect(poolMemberRuntimeConfig(member, "paperclip_runner", {}, metadata).config).toMatchObject(expected);
      expect(() => poolMemberRuntimeConfig(member, "paperclip_runner", {}, { ...metadata, routing: { ...metadata.routing, protocol: protocol === "chat" ? "responses" : "chat" } })).toThrow();
      expect(poolMemberRuntimeConfig(member, compatibleAdapter, {}, metadata).config).toMatchObject(expected);
      expect(() => poolMemberRuntimeConfig(member, incompatibleAdapter, {}, metadata)).toThrow("Pool member is incompatible with this harness");
    }
  });
  it.each(["gateway", "local"] as const)("accepts only projected %s routing hints as model overrides for the requesting harness", (kind) => {
    const route = { kind, baseUrl: kind === "local" ? "http://127.0.0.1:1234" : "https://gateway.example/v1", auth: "bearer" as const };
    for (const adapterType of ["paperclip_runner", "opencode_local", "hermes_local"]) {
      for (const declaredPrefix of ["", "paperclip/"]) {
        const prefix = `${adapterType === "hermes_local" ? "" : "paperclip/"}${declaredPrefix}`;
        const chatMember = { ...members[0]!, profile: { provider: "opencode" as const, model: `${declaredPrefix}custom/a` } };
        const chatMeta = { provider: "openai" as const, method: "api_key" as const, routing: { ...route, protocol: "chat" as const, models: [{ id: `${declaredPrefix}custom/a` }, { id: `${declaredPrefix}custom/b` }] } };
        for (const model of new Set([`${declaredPrefix}custom/b`, `${prefix}custom/b`])) {
          expect(poolMemberRuntimeConfig(chatMember, adapterType, { model }, chatMeta)).toEqual(model === `${prefix}custom/b` ? { config: { provider: "opencode", model }, notes: [] } : { config: { provider: "opencode", model: `${prefix}custom/a` }, notes: ["Model override is unavailable for this member; using its default."] });
        }
        expect(poolMemberRuntimeConfig(chatMember, adapterType, { model: "custom/c" }, chatMeta)).toEqual({ config: { provider: "opencode", model: `${prefix}custom/a` }, notes: ["Model override is unavailable for this member; using its default."] });
        if (adapterType === "hermes_local") {
          expect(poolMemberRuntimeConfig(chatMember, adapterType, { model: declaredPrefix ? "custom/b" : "paperclip/custom/b" }, chatMeta)).toEqual({ config: { provider: "opencode", model: `${prefix}custom/a` }, notes: ["Model override is unavailable for this member; using its default."] });
        }
        const manualModel = adapterType === "hermes_local" ? "paperclip/custom/manual" : "paperclip/paperclip/custom/manual";
        expect(poolMemberRuntimeConfig({ ...chatMember, profile: { provider: "opencode", model: "paperclip/custom/manual" } }, adapterType, {}, chatMeta)).toEqual({ config: { provider: "opencode", model: manualModel }, notes: [] });
      }
    }
    const responsesMember = { ...members[0]!, profile: { provider: "codex" as const, model: "a" } };
    const responsesMeta = { provider: "openai" as const, method: "api_key" as const, routing: { ...route, protocol: "responses" as const, models: [{ id: "a" }, { id: "b" }] } };
    expect(poolMemberRuntimeConfig(responsesMember, "paperclip_runner", { model: "b" }, responsesMeta)).toEqual({ config: { provider: "codex", model: "b" }, notes: [] });
    expect(poolMemberRuntimeConfig(responsesMember, "paperclip_runner", { model: "c" }, responsesMeta)).toEqual({ config: { provider: "codex", model: "a" }, notes: ["Model override is unavailable for this member; using its default."] });
    expect(poolMemberRuntimeConfig({ ...responsesMember, profile: { provider: "codex", model: "manual" } }, "paperclip_runner", {}, responsesMeta)).toEqual({ config: { provider: "codex", model: "manual" }, notes: [] });
  });
  it.each(["gateway", "local"] as const)("keeps the %s default when routing hints are empty", (kind) => {
    const metadata = { provider: "openai" as const, method: "api_key" as const, routing: { kind, protocol: "chat" as const, auth: "bearer" as const, baseUrl: kind === "local" ? "http://127.0.0.1:1234" : "https://gateway.example/v1", models: [] } };
    const member = { ...members[0]!, profile: { provider: "opencode" as const, model: "custom/default" } };
    for (const adapterType of ["paperclip_runner", "opencode_local", "hermes_local"]) {
      const model = adapterType === "hermes_local" ? "custom/default" : "paperclip/custom/default";
      for (const requested of ["custom/manual", "paperclip/custom/manual"]) {
        expect(poolMemberRuntimeConfig(member, adapterType, { model: requested }, metadata)).toEqual({ config: { provider: "opencode", model }, notes: ["Model override is unavailable for this member; using its default."] });
      }
      expect(poolMemberRuntimeConfig(member, adapterType, { model }, metadata)).toEqual({ config: { provider: "opencode", model }, notes: [] });
      expect(poolMemberRuntimeConfig(member, adapterType, {}, metadata)).toEqual({ config: { provider: "opencode", model: adapterType === "hermes_local" ? "custom/default" : "paperclip/custom/default" }, notes: [] });
    }
    expect(poolMemberRuntimeConfig({ ...member, profile: { provider: "opencode", model: "paperclip/custom/default" } }, "hermes_local", {}, metadata)).toEqual({ config: { provider: "opencode", model: "paperclip/custom/default" }, notes: [] });
  });
  it.each(["gateway", "local"] as const)("saves and selects a manual %s default absent from nonempty discovery hints", async (kind) => {
    const routing = { kind, protocol: "chat" as const, auth: "bearer" as const, baseUrl: kind === "local" ? "http://127.0.0.1:1234" : "https://gateway.example/v1", models: [{ id: "discovered" }] };
    const account = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Manual default", apiKey: "fixture", allAgents: true, agentIds: [], routing }, "fixture");
    const member: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...account }, profile: { provider: "opencode", model: "custom/manual" } };
    const pool = await makePool({ members: [member] });
    expect((await resolve(pool.id, `manual-${kind}`)).runtimeConfig).toEqual({ provider: "opencode", model: "paperclip/custom/manual" });
  });
  it.each([
    ["gateway", "fresh"], ["gateway", "pinned"], ["local", "fresh"], ["local", "pinned"],
  ] as const)("prioritizes the projected %s default over a raw hint alias for %s selections", async (kind, phase) => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
    const routing = { kind, protocol: "chat" as const, auth: "bearer" as const, baseUrl: kind === "local" ? "http://127.0.0.1:1234" : "https://gateway.example/v1", models: [{ id: "paperclip/custom/a" }] };
    const account = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Default alias collision", apiKey: "fixture", allAgents: true, agentIds: [], routing }, "fixture");
    const member: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...account }, profile: { provider: "opencode", model: "custom/a" } };
    const pool = await makePool({ members: [member] });
    for (const adapterType of ["paperclip_runner", "opencode_local"]) {
      const taskKey = `default-alias-${kind}-${phase}-${adapterType}`;
      if (phase === "pinned") await resolve(pool.id, taskKey, { adapterType });
      const pinsBefore = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id));
      const [cursorBefore] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id));
      for (const [index, model] of ["paperclip/custom/a", "paperclip/paperclip/custom/a", "paperclip/custom/a"].entries()) {
        const selection = await resolve(pool.id, phase === "fresh" ? `${taskKey}-${index}` : taskKey, { adapterType, overrides: { model } });
        expect(selection).toMatchObject({ memberId: member.id, binding: member.binding, runtimeConfig: { provider: "opencode", model: phase === "fresh" ? model : "paperclip/custom/a" }, notes: [] });
      }
      const pinsAfter = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id));
      const [cursorAfter] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id));
      expect(pinsAfter).toHaveLength(pinsBefore.length + (phase === "fresh" ? 3 : 0));
      expect(cursorAfter?.version).toBe(cursorBefore!.version + (phase === "fresh" ? 3 : 0));
      if (phase === "pinned") {
        expect(pinsAfter).toEqual(pinsBefore);
        expect(cursorAfter).toEqual(cursorBefore);
      }
    }
  });
  it.each([
    ["gateway", "fresh"], ["gateway", "pinned"], ["local", "fresh"], ["local", "pinned"],
  ] as const)("keeps a projected %s catalog identity canonical across members for %s selections", async (kind, phase) => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
    const route = { kind, protocol: "chat" as const, auth: "bearer" as const, baseUrl: kind === "local" ? "http://127.0.0.1:1234" : "https://gateway.example/v1" };
    const accountA = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Canonical member A", apiKey: "fixture", allAgents: true, agentIds: [], routing: { ...route, models: [{ id: "custom/a" }] } }, "fixture");
    const accountB = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Canonical member B", apiKey: "fixture", allAgents: true, agentIds: [], routing: { ...route, models: [{ id: "paperclip/custom/a" }, { id: "paperclip/custom/c" }] } }, "fixture");
    const memberA: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...accountA }, profile: { provider: "opencode", model: "custom/a" } };
    const memberB: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...accountB }, profile: { provider: "opencode", model: "other" } };
    const pool = await makePool({ members: [memberB, memberA] });
    proposal.mockImplementation(async (_id, _method, request) => ({ kind: "selected", memberId: request.pinnedMemberId ?? (request.taskKey.endsWith("-canonical") ? memberA.id : memberB.id) }));
    try {
      for (const adapterType of ["paperclip_runner", "opencode_local"]) {
        const taskKey = `cross-member-${kind}-${phase}-${adapterType}`;
        if (phase === "pinned") await resolve(pool.id, taskKey, { adapterType });
        const key = (suffix: string) => phase === "fresh" ? `${taskKey}-${suffix}` : taskKey;
        const fallback = await resolve(pool.id, key("fallback"), { adapterType, overrides: { model: "paperclip/custom/a" } });
        expect(fallback).toMatchObject({ memberId: memberB.id, binding: memberB.binding, runtimeConfig: { provider: "opencode", model: "paperclip/other" }, notes: phase === "fresh" ? ["Model override is unavailable for this member; using its default."] : [] });
        const alias = await resolve(pool.id, key("alias"), { adapterType, overrides: { model: "paperclip/paperclip/custom/a" } });
        expect(alias).toMatchObject({ memberId: memberB.id, runtimeConfig: { provider: "opencode", model: phase === "fresh" ? "paperclip/paperclip/custom/a" : "paperclip/other" }, notes: [] });
        const raw = await resolve(pool.id, key("raw"), { adapterType, overrides: { model: "paperclip/custom/c" } });
        expect(raw).toMatchObject({ memberId: memberB.id, runtimeConfig: { provider: "opencode", model: "paperclip/other" }, notes: phase === "fresh" ? ["Model override is unavailable for this member; using its default."] : [] });
        const canonical = await resolve(pool.id, `${taskKey}-canonical`, { adapterType, overrides: { model: "paperclip/custom/a" } });
        expect(canonical).toMatchObject({ memberId: memberA.id, runtimeConfig: { provider: "opencode", model: "paperclip/custom/a" }, notes: [] });
      }
    } finally { proposal.mockReset(); proposal.mockImplementation(defaultProposal); }
  });
  it("keeps a direct OpenRouter default out of a chat gateway member's overrides for fresh and pinned selections", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
    const routing = { kind: "gateway" as const, protocol: "chat" as const, auth: "bearer" as const, baseUrl: "https://gateway.example/v1", models: [{ id: "openrouter/vendor/model-a" }] };
    const direct = await aiConnectionService(db).save(companyId, "alice", { provider: "openrouter", method: "api_key", ownership: "personal", name: "Direct OpenRouter default", apiKey: "fixture", allAgents: true, agentIds: [] }, "fixture");
    const gateway = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Gateway OpenRouter hint", apiKey: "fixture", allAgents: true, agentIds: [], routing }, "fixture");
    const memberA: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openrouter", method: "api_key", ...direct }, profile: { provider: "opencode", model: "openrouter/vendor/model-a" } };
    const memberB: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...gateway }, profile: { provider: "opencode", model: "custom/b" } };
    const overrides = { model: "openrouter/vendor/model-a" };
    const fallback = { config: { provider: "opencode", model: "paperclip/custom/b" }, notes: ["Model override is unavailable for this member; using its default."] };
    expect(poolMemberRuntimeConfig(memberB, "paperclip_runner", overrides, { provider: "openai", method: "api_key", routing })).toEqual(fallback);
    const pool = await makePool({ members: [memberB, memberA] });
    const fresh = await resolve(pool.id, "openrouter-hint-fresh", { overrides });
    expect(fresh).toMatchObject({ memberId: memberB.id, runtimeConfig: fallback.config, notes: fallback.notes });
    expect(await resolve(pool.id, "openrouter-hint-fresh", { overrides })).toEqual(fresh);
    expect(await resolve(pool.id, "openrouter-hint-direct", { overrides })).toMatchObject({ memberId: memberA.id, runtimeConfig: { provider: "opencode", model: "openrouter/vendor/model-a" }, notes: [] });
    const pinned = await resolve(pool.id, "openrouter-hint-pinned");
    expect(pinned).toMatchObject({ memberId: memberB.id, runtimeConfig: fallback.config, notes: [] });
    expect(await resolve(pool.id, "openrouter-hint-pinned", { overrides })).toEqual(pinned);
  });
  it("does not let an incompatible Responses member contribute a chat member's model identity", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
    const route = { kind: "gateway" as const, auth: "bearer" as const, baseUrl: "https://gateway.example/v1" };
    const responses = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Responses member", apiKey: "fixture", allAgents: true, agentIds: [], routing: { ...route, protocol: "responses", models: [{ id: "custom/a" }] } }, "fixture");
    const chatRouting = { ...route, protocol: "chat" as const, models: [{ id: "paperclip/custom/a" }] };
    const chat = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Chat member", apiKey: "fixture", allAgents: true, agentIds: [], routing: chatRouting }, "fixture");
    const memberA: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...responses }, profile: { provider: "codex", model: "custom/a" } };
    const memberB: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...chat }, profile: { provider: "opencode", model: "custom/b" } };
    const chatMeta = { provider: "openai" as const, method: "api_key" as const, routing: chatRouting };
    const fallback = { config: { provider: "opencode", model: "paperclip/custom/b" }, notes: ["Model override is unavailable for this member; using its default."] };
    const mixed = await makePool({ members: [memberA, memberB] });
    const alone = await makePool({ members: [memberB] });
    const withResponses = await resolve(mixed.id, "phantom-identity", { adapterType: "opencode_local", overrides: { model: "paperclip/custom/a" } });
    const withoutResponses = await resolve(alone.id, "phantom-identity", { adapterType: "opencode_local", overrides: { model: "paperclip/custom/a" } });
    expect(withResponses).toMatchObject({ memberId: memberB.id, runtimeConfig: fallback.config, notes: fallback.notes });
    expect({ ...withResponses, poolId: alone.id }).toEqual(withoutResponses);
    expect(poolMemberRuntimeConfig(memberB, "opencode_local", { model: "paperclip/custom/a" }, chatMeta)).toEqual(fallback);
    expect(poolMemberRuntimeConfig(memberB, "opencode_local", { model: "paperclip/paperclip/custom/a" }, chatMeta)).toEqual({ config: { provider: "opencode", model: "paperclip/paperclip/custom/a" }, notes: [] });
  });
  it("replays a pinned task's stored settings after an unrelated member leaves the pool and still fails closed", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
    const route = { kind: "gateway" as const, protocol: "chat" as const, auth: "bearer" as const, baseUrl: "https://gateway.example/v1" };
    const accountA = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Unrelated member", apiKey: "fixture", allAgents: true, agentIds: [], routing: { ...route, models: [{ id: "custom/a" }] } }, "fixture");
    const accountB = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Pinned member", apiKey: "fixture", allAgents: true, agentIds: [], routing: { ...route, models: [{ id: "paperclip/custom/a" }] } }, "fixture");
    const memberA: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...accountA }, profile: { provider: "opencode", model: "custom/a" } };
    const memberB: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...accountB }, profile: { provider: "opencode", model: "other" } };
    const pool = await makePool({ members: [memberB, memberA] });
    const overrides = { model: "paperclip/custom/a" };
    const first = await resolve(pool.id, "frozen-pin", { overrides });
    expect(first).toMatchObject({ memberId: memberB.id, runtimeConfig: { provider: "opencode", model: "paperclip/other" }, notes: ["Model override is unavailable for this member; using its default."] });
    await service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: { name: "Without unrelated member", enabled: true, mode: "round_robin", thresholdPercent: 90, members: [memberB] } }, "alice");
    expect(await resolve(pool.id, "frozen-pin", { overrides })).toEqual(first);
    const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.taskKey, "frozen-pin")));
    expect(pin?.selection).toEqual(first);
    expect(await resolve(pool.id, "frozen-pin", { overrides, persisted: first })).toEqual(first);
    await expect(resolve(pool.id, "frozen-pin", { overrides, adapterType: "codex_local" })).rejects.toThrow();
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, accountB.grantId));
    try {
      await expect(resolve(pool.id, "frozen-pin", { overrides })).rejects.toThrow();
      await expect(resolve(pool.id, "frozen-pin", { overrides, persisted: first })).rejects.toThrow();
    } finally { await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, accountB.grantId)); }
  });
  it("authorizes direct OpenRouter members before evaluating fresh and pinned model overrides", async () => {
    const account = await aiConnectionService(db).save(companyId, "alice", { provider: "openrouter", method: "api_key", ownership: "personal", name: "OpenRouter", apiKey: "fixture", allAgents: true, agentIds: [] }, "fixture");
    const member: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openrouter", method: "api_key", ...account }, profile: { provider: "opencode", model: "anthropic/claude-sonnet-4.5" } };
    const pool = await makePool({ members: [member] });
    const overrides = { model: "openrouter/anthropic/claude-sonnet-4.5" };
    const selected = await resolve(pool.id, "openrouter-effective-model", { overrides });
    expect(selected.runtimeConfig).toEqual({ provider: "opencode", model: overrides.model });
    expect(await resolve(pool.id, "openrouter-effective-model", { overrides })).toEqual(selected);
    await expect(resolve(pool.id, "openrouter-wrong-user", { overrides, userId: "bob" })).rejects.toThrow();
    await expect(resolve(pool.id, "openrouter-effective-model", { overrides, userId: "bob" })).rejects.toThrow();
    await expect(resolve(pool.id, "openrouter-no-override")).rejects.toThrow();
  });
  it.each(["gateway", "local"] as const)("keeps distinct raw %s model identities and permits a bare Hermes default", async (kind) => {
    const routing = { kind, protocol: "chat" as const, auth: "bearer" as const, baseUrl: kind === "local" ? "http://127.0.0.1:1234" : "https://gateway.example/v1", models: [{ id: "custom/a" }, { id: "paperclip/custom/a" }] };
    const metadata = { provider: "openai" as const, method: "api_key" as const, routing };
    for (const [raw, projected] of [["custom/a", "paperclip/custom/a"], ["paperclip/custom/a", "paperclip/paperclip/custom/a"]]) {
      const member = { ...members[0]!, profile: { provider: "opencode" as const, model: raw! } };
      expect(poolMemberRuntimeConfig(member, "paperclip_runner", {}, metadata)).toEqual({ config: { provider: "opencode", model: projected }, notes: [] });
      expect(poolMemberRuntimeConfig(member, "opencode_local", { model: projected }, metadata)).toEqual({ config: { provider: "opencode", model: projected }, notes: [] });
      expect(poolMemberRuntimeConfig(member, "hermes_local", {}, metadata)).toEqual({ config: { provider: "opencode", model: raw }, notes: [] });
    }
    const account = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Bare Hermes", apiKey: "fixture", allAgents: true, agentIds: [], routing: { ...routing, models: [] } }, "fixture");
    const member: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...account }, profile: { provider: "opencode", model: "qwen" } };
    const pool = await makePool({ members: [member] });
    expect(pool.members[0]?.profile.model).toBe("qwen");
    expect((await resolve(pool.id, `bare-hermes-${kind}`, { adapterType: "hermes_local" })).runtimeConfig).toEqual({ provider: "opencode", model: "qwen" });
    expect((await resolve(pool.id, `bare-opencode-${kind}`)).runtimeConfig).toEqual({ provider: "opencode", model: "paperclip/qwen" });
  });
  it.each(["gateway", "local"] as const)("validates %s manual model syntax independently of inventory hints", (kind) => {
    const routing = { kind, protocol: "chat" as const, auth: "bearer" as const, baseUrl: kind === "local" ? "http://127.0.0.1:1234" : "https://gateway.example/v1", models: [] };
    const metadata = { provider: "openai" as const, method: "api_key" as const, routing };
    const member = { ...members[0]!, profile: { provider: "opencode" as const, model: "default" } };
    for (const adapterType of ["paperclip_runner", "opencode_local", "hermes_local"]) {
      const invalid = ["", " ", "\t", "m".repeat(257), ...(adapterType === "hermes_local" ? [] : ["paperclip/", "custom/"])];
      for (const model of invalid) {
        expect(poolMemberRuntimeConfig(member, adapterType, { model }, metadata)).toEqual({ config: { provider: "opencode", model: adapterType === "hermes_local" ? "default" : "paperclip/default" }, notes: ["Model override is unavailable for this member; using its default."] });
      }
      for (const raw of ["custom model", "/model", "custom//a"]) {
        const model = adapterType === "hermes_local" ? raw : `paperclip/${raw}`;
        expect(poolMemberRuntimeConfig(member, adapterType, { model: raw }, metadata)).toEqual({ config: { provider: "opencode", model: adapterType === "hermes_local" ? "default" : "paperclip/default" }, notes: ["Model override is unavailable for this member; using its default."] });
        expect(poolMemberRuntimeConfig({ ...member, profile: { provider: "opencode", model: raw } }, adapterType, {}, metadata)).toEqual({ config: { provider: "opencode", model }, notes: [] });
      }
      if (adapterType === "hermes_local") expect(poolMemberRuntimeConfig(member, adapterType, { model: "custom/" }, metadata)).toEqual({ config: { provider: "opencode", model: "default" }, notes: ["Model override is unavailable for this member; using its default."] });
      expect(poolMemberRuntimeConfig(member, adapterType, { model: " custom/a " }, metadata)).toEqual({ config: { provider: "opencode", model: adapterType === "hermes_local" ? "default" : "paperclip/default" }, notes: ["Model override is unavailable for this member; using its default."] });
      const raw = `paperclip/${"m".repeat(246)}`;
      expect(poolMemberRuntimeConfig({ ...member, profile: { provider: "opencode", model: raw } }, adapterType, {}, metadata).config.model).toBe(adapterType === "hermes_local" ? raw : `paperclip/${raw}`);
      expect(() => poolMemberRuntimeConfig({ ...member, profile: { provider: "opencode", model: "m".repeat(257) } }, adapterType, {}, metadata)).toThrow("valid pool member model");
    }
  });
  it.each(["gateway", "local"] as const)("projects %s OpenCode effort into the legacy variant field only", (kind) => {
    const metadata = { provider: "openai" as const, method: "api_key" as const, routing: { kind, protocol: "chat" as const, auth: "bearer" as const, baseUrl: kind === "local" ? "http://127.0.0.1:1234" : "https://gateway.example/v1", models: [] } };
    const member = { ...members[0]!, profile: { provider: "opencode" as const, model: "custom/model", effort: "high" } };
    expect(poolMemberRuntimeConfig(member, "opencode_local", {}, metadata)).toEqual({ config: { provider: "opencode", model: "paperclip/custom/model", variant: "high" }, notes: [] });
    expect(poolMemberRuntimeConfig(member, "opencode_local", { variant: "medium" }, metadata)).toEqual({ config: { provider: "opencode", model: "paperclip/custom/model", variant: "medium" }, notes: [] });
    expect(poolMemberRuntimeConfig(member, "opencode_local", { variant: "provider-specific" }, metadata)).toEqual({ config: { provider: "opencode", model: "paperclip/custom/model", variant: "provider-specific" }, notes: [] });
    for (const adapterType of ["opencode_local"]) {
      expect(poolMemberRuntimeConfig(member, adapterType, { variant: "v".repeat(32) }, metadata)).toEqual({ config: { provider: "opencode", model: "paperclip/custom/model", variant: "v".repeat(32) }, notes: [] });
      for (const variant of ["v".repeat(33), " ", "\t"]) {
        expect(poolMemberRuntimeConfig(member, adapterType, { variant }, metadata)).toEqual({ config: { provider: "opencode", model: "paperclip/custom/model", variant: "high" }, notes: ["Effort override is unavailable for this member; using its default."] });
      }
      expect(poolMemberRuntimeConfig(member, adapterType, { variant: "" }, metadata)).toEqual({ config: { provider: "opencode", model: "paperclip/custom/model", variant: "high" }, notes: [] });
    }
    expect(poolMemberRuntimeConfig(member, "paperclip_runner", { variant: "medium" }, metadata)).toEqual({ config: { provider: "opencode", model: "paperclip/custom/model" }, notes: ["Effort override is unavailable for this member; using its default."] });
  });
  it("rejects unsupported supplied execution targets before pinning and rechecks at commit", async () => {
    const routing = { kind: "gateway" as const, protocol: "chat" as const, auth: "bearer" as const, baseUrl: "https://gateway.example/v1", models: [] };
    const account = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", ownership: "personal", name: "Target guard", apiKey: "fixture", allAgents: true, agentIds: [], routing }, "fixture");
    const member: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...account }, profile: { provider: "opencode", model: "custom/model" } };
    const pool = await makePool({ members: [member] });
    const pluginTarget = { kind: "remote", transport: "sandbox", remoteCwd: ".", runnerTask: async () => ({}) } as const;
    let executionTarget: Parameters<typeof isPluginRunnerManagedCredentialSupported>[0]["executionTarget"] = pluginTarget;
    const validateRuntime = async (config: Record<string, unknown>, metadata: AiConnectionMetadata) => {
      if (!isPluginRunnerManagedCredentialSupported({ executionTarget, adapterType: "paperclip_runner", config, routing: metadata.routing })) throw new Error("Unsupported supplied target");
    };
    await expect(resolve(pool.id, "unsupported-target", { validateRuntime })).rejects.toThrow();
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0);
    expect((await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)))[0]?.version).toBe(0);
    executionTarget = { kind: "local" };
    const selection = await resolve(pool.id, "supported-target", { validateRuntime });
    expect(selection.runtimeConfig.model).toBe("paperclip/custom/model");
    executionTarget = pluginTarget;
    await expect(resolve(pool.id, "supported-target", { validateRuntime })).rejects.toThrow("Unsupported supplied target");
    executionTarget = { kind: "local" };
    proposal.mockImplementationOnce(async () => { executionTarget = pluginTarget; return { kind: "selected", memberId: member.id }; });
    try {
      await expect(resolve(pool.id, "changed-target", { validateRuntime })).rejects.toThrow("Unsupported supplied target");
      expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(1);
      expect((await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)))[0]?.version).toBe(1);
      await expect(resolve(pool.id, "supported-target", { persisted: selection, validateRuntime })).rejects.toThrow("Unsupported supplied target");
    } finally { proposal.mockReset(); proposal.mockImplementation(defaultProposal); }
  });
  it("commits concurrent allocations with the real environment validator on one database connection", async () => {
    const single = createDb(externalTestDatabaseUrl ?? database.connectionString, { maxConnections: 1 });
    const pool = await makePool();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const validateRuntime = await createHeartbeatPoolRuntimeValidator(single, {
        run: { id: randomUUID() }, agent: { id: agentId, companyId, defaultEnvironmentId: null }, adapterType: "paperclip_runner",
        issueId: null, issueContext: null, trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
        environmentsSvc: environmentService(single), instanceSettings: instanceSettingsService(single),
      });
      const allocations = ["one", "two", "three"].map(taskKey => aiConnectionRouterService(single, worker).resolve({
        companyId, poolId: pool.id, agentId, userId: "alice", adapterType: "paperclip_runner", taskKey, validateRuntime,
      }));
      const selected = await Promise.race([
        Promise.all(allocations),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Allocation stalled with one database connection")), 4000); }),
      ]);
      expect(selected).toHaveLength(3);
      expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(3);
      expect((await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)))[0]?.version).toBe(3);
    } finally {
      if (timer) clearTimeout(timer);
      await single.$client.end({ timeout: 1 });
    }
  }, 10_000);
  it("registers native connectors only for declared installed routers", async () => {
    const entry = (await service().catalog())[0]!;
    expect(entry.name).toBe("AI connection pool");
    expect(entry.aiConnectionRouter).toEqual({ pluginKey });
    expect(entry.availability?.available).toBe(true);
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
    try {
      expect((await service().catalog())[0]?.availability?.available).toBe(false);
      await db.update(plugins).set({ status: "uninstalled" }).where(eq(plugins.id, pluginId));
      expect(await service().catalog()).toEqual([]);
    } finally { await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId)); }
  });
  it("native connector removal retains durable pins and ordinary updates cannot bypass pool revisions", async () => {
    const pool = await makePool(); const selected = await resolve(pool.id, "catalog-removal");
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "alice", source: "local_implicit", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] } as typeof req.actor; next(); });
    app.use("/api", toolAccessRoutes(db)); app.use("/api", aiConnectionRoutes(db)); app.use(errorHandler);
    expect((await request(app).patch(`/api/tool-connections/${pool.id}`).send({ name: "Bypass" })).status).toBe(400);
    expect((await request(app).delete(`/api/tool-connections/${pool.id}`)).status).toBe(400);
    expect((await request(app).delete(`/api/companies/${companyId}/ai-connection-pools/${pool.id}`).send({ expectedRevision: pool.revision + 1 })).status).toBe(409);
    expect((await request(app).delete(`/api/companies/${companyId}/ai-connection-pools/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(200);
    expect((await service().list(companyId)).some(row => row.id === pool.id)).toBe(false);
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(1);
    expect(await resolve(pool.id, "catalog-removal", { persisted: selected })).toEqual(selected);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, members[0]!.binding.connectionId)))[0]?.status).toBe("active");
  });
  it("requires company connection management authority on pool configuration routes", async () => {
    await db.update(companyMemberships).set({ membershipRole: "owner" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "alice")));
    const app = express(); app.use(express.json());
    let actor = { type: "board", userId: "alice", source: "session", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] };
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); }); app.use("/api", aiConnectionRoutes(db)); app.use(errorHandler);
    const pool = await makePool(); const url = `/api/companies/${companyId}/ai-connection-pools`;
    expect((await request(app).get(url)).status).toBe(200);
    expect((await request(app).get(`/api/companies/${otherCompanyId}/ai-connection-pools`)).status).toBe(403);
    expect((await request(app).delete(`/api/companies/${otherCompanyId}/ai-connection-pools/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(403);
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "alice")));
    actor = { ...actor, memberships: [{ companyId, status: "active", membershipRole: "viewer" }] };
    expect((await request(app).get(url)).status).toBe(403);
    expect((await request(app).post(url).send({ pluginKey, config: pool })).status).toBe(403);
    expect((await request(app).get(`${url}/${pool.id}/inspection`)).status).toBe(403);
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(403);
    actor = { type: "agent", agentId, companyId, source: "agent_jwt" } as unknown as typeof actor;
    expect((await request(app).get(url)).status).toBe(403);
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(403);
    await db.update(companyMemberships).set({ membershipRole: "owner" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "alice")));
    actor = { type: "board", userId: "alice", source: "session", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] };
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: pool.revision + 1 })).status).toBe(409);
    expect((await request(app).delete(`${url}/${pool.id}`).send({ expectedRevision: pool.revision })).status).toBe(200);
    expect((await request(app).get(url)).body.some((entry: { id: string }) => entry.id === pool.id)).toBe(false);
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "alice")));
  });
  it("deletes pools without erasing pins, cursors, or admitted recovery evidence", async () => {
    const pool = await makePool(); const selected = await resolve(pool.id, "retained");
    await expect(service().remove(otherCompanyId, pool.id, pool.revision, "alice")).rejects.toThrow("not found");
    await expect(service().remove(companyId, pool.id, pool.revision + 1, "alice")).rejects.toThrow("reload before deleting");
    await service().remove(companyId, pool.id, pool.revision, "alice");
    expect((await service().list(companyId)).some(entry => entry.id === pool.id)).toBe(false);
    expect((await service().selectable(companyId, "alice")).some(entry => entry.id === pool.id)).toBe(false);
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(1);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
    await expect(resolve(pool.id, "new")).rejects.toThrow("choose another AI connection");
    expect(await resolve(pool.id, "retained", { persisted: selected })).toEqual(selected);
    const { name, enabled, mode, thresholdPercent, members: savedMembers } = pool;
    await expect(service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision + 1, config: { name, enabled, mode, thresholdPercent, members: savedMembers } }, "alice")).rejects.toThrow("not found");
  });
  it("does not commit a selection when its pool is deleted during a proposal", async () => {
    const pool = await makePool();
    proposal.mockImplementationOnce(async () => { await service().remove(companyId, pool.id, pool.revision, "alice"); return { kind: "selected", memberId: members[0]!.id }; });
    await expect(resolve(pool.id, "deleted-during-selection")).rejects.toThrow("choose another AI connection");
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(0);
  });
  it("allows cleanup while experimental routing and its plugin are disabled", async () => {
    const pool = await makePool();
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false });
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
    try { await expect(service().remove(companyId, pool.id, pool.revision, "alice")).resolves.toEqual({ ok: true }); }
    finally { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true }); await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId)); }
  });
  it("rotates new tasks across qualified backends and retains pins on turns, resets and service restart", async () => {
    const pool = await makePool();
    expect((await resolve(pool.id, "one")).memberId).toBe(members[0]!.id);
    expect((await resolve(pool.id, "two")).memberId).toBe(members[1]!.id);
    expect((await resolve(pool.id, "one", { overrides: { model: "claude-sonnet-5", modelReasoningEffort: "high" } })).memberId).toBe(members[0]!.id);
    expect((await aiConnectionRouterService(db, worker).resolve({ companyId, poolId: pool.id, agentId, userId: "alice", adapterType: "paperclip_runner", taskKey: "one" })).memberId).toBe(members[0]!.id);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(2);
  });
  it("commits one allocation for duplicate starts and serializes concurrent tasks", async () => {
    const pool = await makePool();
    const same = await Promise.all(Array.from({ length: 8 }, () => resolve(pool.id, "duplicate")));
    expect(new Set(same.map(s => s.memberId)).size).toBe(1);
    const many = await Promise.all(Array.from({ length: 8 }, (_, n) => resolve(pool.id, `concurrent-${n}`)));
    expect(many.filter(s => s.memberId === members[0]!.id)).toHaveLength(4);
    const pins = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id)); expect(pins).toHaveLength(9);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(9);
  });
  it("rolls back both pin and cursor on a failure during commit", async () => {
    const pool = await makePool();
    await db.execute(`CREATE FUNCTION fixture_router_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture commit crash'; END $$`);
    await db.execute(`CREATE TRIGGER fixture_router_crash BEFORE UPDATE ON ai_connection_router_cursors FOR EACH ROW EXECUTE FUNCTION fixture_router_crash()`);
    try { await expect(resolve(pool.id, "crash")).rejects.toThrow(); } finally { await db.execute(`DROP TRIGGER fixture_router_crash ON ai_connection_router_cursors`); await db.execute(`DROP FUNCTION fixture_router_crash()`); }
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0);
    const selected = await resolve(pool.id, "crash"); expect(selected.memberId).toBe(members[0]!.id);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
  });
  it("rechecks config revisions after a proposal and preserves removed member snapshots", async () => {
    const pool = await makePool(); const old = await resolve(pool.id, "existing");
    const saved = await service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: { name: "Edited", enabled: true, mode: "round_robin", thresholdPercent: 90, members: [members[1]!] } }, "alice");
    await expect(service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: saved }, "alice")).rejects.toThrow();
    expect((await resolve(pool.id, "existing")).binding).toEqual(old.binding);
    expect((await resolve(pool.id, "future")).memberId).toBe(members[1]!.id);
  });
  it("keeps pinned settings frozen and composer fallback independent", async () => {
    const pool = await makePool();
    const first = await resolve(pool.id, "composer");
    const changed = await resolve(pool.id, "composer", { overrides: { model: "claude-sonnet-5", modelReasoningEffort: "high" } });
    expect(changed.binding).toEqual(first.binding); expect(changed).toEqual(first); expect(changed.runtimeConfig).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", modelReasoningEffort: "low" }); expect(changed.notes).toEqual([]);
    const composer = poolMemberRuntimeConfig(members[0]!, "paperclip_runner", { model: "claude-sonnet-5", modelReasoningEffort: "high" });
    expect(composer.config).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", modelReasoningEffort: "high" }); expect(composer.notes).toHaveLength(1);
    const claude = poolMemberRuntimeConfig(members[1]!, "paperclip_runner", { model: "gpt-5.6-sol", modelReasoningEffort: "ultra" });
    expect(claude.config).toMatchObject({ provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" }); expect(claude.notes).toHaveLength(2);
    const claudeEffort = poolMemberRuntimeConfig(members[1]!, "paperclip_runner", { modelReasoningEffort: "xhigh" });
    expect(claudeEffort.config).toMatchObject({ provider: "acpx", acpxAgent: "claude", modelReasoningEffort: "xhigh" });
    expect(claudeEffort.notes).toEqual([]);
    const overrides = applyAiConnectionRouterTaskSettings({ model: "claude-sonnet-5", effort: "invalid", cwd: "/fixture" }, { ...changed, runtimeConfig: composer.config, notes: composer.notes });
    const native = resolvePaperclipRunnerNativeProviderInput({ backend: "codex_app_server", adapterConfig: projectPaperclipRunnerTaskConfig("codex_app_server", composer.config, overrides) });
    expect(native).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", codexReasoningEffort: "high" });
    expect(overrides).toMatchObject({ cwd: "/fixture" }); expect(overrides).not.toHaveProperty("effort");
  });
  it("retries a changed config proposal without advancing the abandoned selection", async () => {
    const pool = await makePool();
    proposal.mockImplementationOnce(async () => {
      await service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: { name: pool.name, enabled: true, mode: pool.mode, thresholdPercent: pool.thresholdPercent, members: [members[1]!] } }, "alice");
      return { kind: "selected", memberId: members[0]!.id };
    });
    expect((await resolve(pool.id, "revision-conflict")).memberId).toBe(members[1]!.id);
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
  });
  it("fails closed when the experimental flag changes during a proposal", async () => {
    const pool = await makePool();
    proposal.mockImplementationOnce(async () => { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false }); return { kind: "selected", memberId: members[0]!.id }; });
    try { await expect(resolve(pool.id, "disabled-in-flight")).rejects.toThrow("disabled during allocation"); expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0); }
    finally { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true }); }
  });
  it("uses only compatible legacy members and makes reassignment an independent pin", async () => {
    const pool = await makePool();
    expect((await resolve(pool.id, "legacy", { adapterType: "claude_local" })).memberId).toBe(members[1]!.id);
    expect((await resolve(pool.id, "legacy", { agentId: secondAgentId, adapterType: "codex_local" })).memberId).toBe(members[0]!.id);
    const pins = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id)); expect(pins).toHaveLength(2);
  });
  it("adopts a valid existing account and requires explicit reset for an unrelated session", async () => {
    const pool = await makePool();
    expect((await resolve(pool.id, "adopt", { requireExisting: true, existingGrantId: members[1]!.binding.grantId })).memberId).toBe(members[1]!.id);
    await expect(resolve(pool.id, "foreign-session", { requireExisting: true, existingGrantId: randomUUID() })).rejects.toThrow("Reset");
    expect((await resolve(pool.id, "foreign-session")).memberId).toBe(members[0]!.id);
  });
  it("rejects cross-company access and unauthorized plugin proposals", async () => {
    const pool = await makePool();
    await expect(resolve(pool.id, "foreign", { companyId: otherCompanyId })).rejects.toThrow();
    proposal.mockResolvedValueOnce({ kind: "selected", memberId: randomUUID() });
    await expect(resolve(pool.id, "bad-proposal")).rejects.toThrow("unauthorized");
    expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0);
  });
  it("does not grant members to another responsible user or move revoked pins", async () => {
    const pool = await makePool(); const selected = await resolve(pool.id, "revoke");
    await expect(resolve(pool.id, "revoke", { userId: "bob" })).rejects.toThrow();
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, selected.binding.mode === "responsible_user" ? "" : selected.binding.grantId));
    try { await expect(resolve(pool.id, "revoke")).rejects.toThrow(); expect((await resolve(pool.id, "new")).memberId).toBe(members[1]!.id); }
    finally { await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, members[0]!.binding.grantId)); }
  });
  it("never probes pure rotation, caches authorized observations, and invalidates on credential change", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 12 } })));
    try {
      const pure = await makePool(); await resolve(pure.id, "pure"); expect(spy).not.toHaveBeenCalled();
      const aware = await makePool({ mode: "usage_aware", members: [members[1]!] }); await resolve(aware.id, "aware"); expect(spy).toHaveBeenCalledTimes(1); await resolve(aware.id, "aware"); expect(spy).toHaveBeenCalledTimes(1);
      expect((await service().inspect(companyId, aware.id, "alice"))[members[1]!.id]?.checkedAt).not.toBeNull();
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId)); const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
      await secretService(db).rotate(ref.secretId, { value: "fixture-refreshed", preserveAiSessionEpoch: true }, { userId: "alice" });
      expect((await service().inspect(companyId, aware.id, "alice"))[members[1]!.id]?.checkedAt).toBeNull();
      await resolve(aware.id, "aware"); expect(spy).toHaveBeenCalledTimes(2);
      proposal.mockResolvedValueOnce({ kind: "exhausted", retryAt: new Date(Date.now() + 60_000).toISOString(), skipped: {} });
      await expect(resolve(aware.id, "aware")).rejects.toBeInstanceOf(AiConnectionPoolExhausted);
      const pins = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, aware.id)); expect(pins).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
  it("shares an in-flight usage observation across concurrent allocations", async () => {
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    await secretService(db).rotate(ref.secretId, { value: "fixture-shared-probe", preserveAiSessionEpoch: true }, { userId: "alice" });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return new Response(JSON.stringify({ five_hour: { utilization: 12 } }));
    });
    try {
      const pool = await makePool({ mode: "usage_aware", members: [members[1]!] });
      await Promise.all(Array.from({ length: 6 }, (_, index) => resolve(pool.id, `shared-probe-${index}`)));
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });
  it("expires a usage observation at a reported reset", async () => {
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    await secretService(db).rotate(ref.secretId, { value: "fixture-reset-cache", preserveAiSessionEpoch: true }, { userId: "alice" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: new Date(Date.now() + 200).toISOString() } })));
    try {
      const pool = await makePool({ mode: "usage_aware", members: [members[1]!] }); await resolve(pool.id, "reset-cache"); expect(spy).toHaveBeenCalledTimes(1);
      await new Promise(resolve => setTimeout(resolve, 250)); await resolve(pool.id, "reset-cache"); expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
  it("treats unfinished probes as unknown within the shared selection budget", async () => {
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    await secretService(db).rotate(ref.secretId, { value: "fixture-slow-probe", preserveAiSessionEpoch: true }, { userId: "alice" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    try { const pool = await makePool({ mode: "usage_aware", members: [members[1]!] }); const start = Date.now(); expect((await resolve(pool.id, "slow-probe")).memberId).toBe(members[1]!.id); expect(Date.now() - start).toBeLessThan(20_000); expect(proposal.mock.calls.at(-1)?.[2].candidates[0]?.usage).toBeUndefined(); }
    finally { spy.mockRestore(); }
  }, 25_000);
  it("persists run-key affinity before policy calls and reuses it across allocation recovery", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true, enableWorktreeRunExecution: true });
    const pool = await makePool({ members: [members[1]!] });
    const [agent] = await db.insert(agents).values({ companyId, name: "Run-key fixture", adapterType: "claude_local", adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    let affinity: string | undefined;
    const execute = vi.fn(); registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {} });
    proposal.mockImplementationOnce(async (_id, _method, request) => {
      const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.status, "running")));
      expect(run?.contextSnapshot?.aiRouterTaskKey).toBe(run?.id);
      expect(request.taskKey).toBe(run?.id);
      affinity = run!.id;
      throw new Error("fixture policy interruption");
    });
    try {
      const run = await heartbeat.wakeup(agent!.id, { source: "on_demand", reason: "manual", triggerDetail: "manual", contextSnapshot: { responsibleUserId: "alice", wakeReason: "manual" } });
      expect(run).not.toBeNull();
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("failed");
      expect(affinity).toBe(run!.id);
      expect((await heartbeat.getRun(run!.id))?.contextSnapshot?.aiRouterTaskKey).toBe(affinity);
      expect(execute).not.toHaveBeenCalled();
      const input = { agentId: agent!.id, adapterType: "claude_local" };
      const committed = await resolve(pool.id, affinity!, input);
      expect(await aiConnectionRouterService(db, worker).resolve({ companyId, poolId: pool.id, agentId: agent!.id, userId: "alice", adapterType: "claude_local", taskKey: affinity! })).toEqual(committed);
      const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
      expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(1);
    } finally { proposal.mockReset(); proposal.mockImplementation(defaultProposal); unregisterServerAdapter("claude_local"); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);
  it("defers a pinned task before provider work and schedules a retry with its affinity intact", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true, enableWorktreeRunExecution: true });
    const pool = await makePool({ members: [members[1]!] });
    const [agent] = await db.insert(agents).values({ companyId, name: "Quota fixture", adapterType: "claude_local", adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Quota fixture", status: "todo", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    const pinned = await resolve(pool.id, issue!.id, { agentId: agent!.id, adapterType: "claude_local" });
    await service().save(pluginKey, { companyId, id: pool.id, expectedRevision: pool.revision, config: { name: pool.name, enabled: true, mode: "usage_aware", thresholdPercent: 90, members: [members[1]!] } }, "alice");
    const execute = vi.fn(); registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 100 } })));
    proposal.mockResolvedValueOnce({ kind: "exhausted", retryAt: new Date(Date.now() + 60_000).toISOString(), skipped: { [members[1]!.id]: "Exhausted" } });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {} });
    try {
      const run = await heartbeat.wakeup(agent!.id, { source: "assignment", reason: "issue_assigned", payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, wakeReason: "issue_assigned", responsibleUserId: "alice" }, triggerDetail: "system" });
      expect(run).not.toBeNull();
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("cancelled");
      const cancelled = await heartbeat.getRun(run!.id); expect(cancelled?.errorCode).toBe("ai_connection_pool_exhausted");
      expect(cancelled?.resultJson).toMatchObject({
        executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false },
        cancellation: {
          source: "control_plane", expected: true, initiator: { type: "system" },
          reason: "Waiting for an AI connection pool account",
          recordedAt: cancelled!.finishedAt!.toISOString(),
        },
      });
      expect(legacyExecutionNeedsReconciliation(cancelled!)).toBe(false);
      expect(legacyExecutionNeedsReconciliation({ ...cancelled!, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
      await expect.poll(async () => (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.scheduledRetryReason, "ai_connection_pool_wait")))).length, { timeout: 5000 }).toBe(1);
      const [retry] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent!.id), eq(heartbeatRuns.scheduledRetryReason, "ai_connection_pool_wait")));
      await waitForPendingRunFailureReports();
      expect(captureRunFailure.mock.calls.filter(([report]) => report.runId === run!.id)).toHaveLength(0);
      expect(retry?.resultJson?.cancellation).toBeUndefined();
      expect(retry?.contextSnapshot?.aiRouterTaskKey).toBe(issue!.id); expect(retry?.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 }); expect(execute).not.toHaveBeenCalled();
      const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.agentId, agent!.id))); expect(pin?.selection).toEqual(pinned);
      const [cursor] = await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)); expect(cursor?.version).toBe(1);
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.agentId, agent!.id));
    } finally { fetch.mockRestore(); proposal.mockReset(); proposal.mockImplementation(defaultProposal); unregisterServerAdapter("claude_local"); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);
  it("keeps unexpected pool policy failures reportable before provider work", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true, enableWorktreeRunExecution: true });
    const pool = await makePool({ members: [members[1]!] });
    const [agent] = await db.insert(agents).values({ companyId, name: "Unexpected router failure", adapterType: "claude_local", adapterConfig: { cwd: home, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Router failure fixture", status: "todo", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    const execute = vi.fn(); registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
    proposal.mockRejectedValueOnce(new Error("Synthetic unexpected router policy failure"));
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {} });
    try {
      const run = await heartbeat.wakeup(agent!.id, { source: "assignment", reason: "issue_assigned", payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, wakeReason: "issue_assigned", responsibleUserId: "alice" }, triggerDetail: "system" });
      expect(run).not.toBeNull();
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("failed");
      const failed = await heartbeat.getRun(run!.id);
      expect(failed?.errorCode).toBe("configuration_incomplete");
      expect(failed?.resultJson).toMatchObject({ configurationIncomplete: { reason: "ai_connection_unavailable" } });
      expect(failed?.resultJson?.cancellation).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      await expect.poll(() => captureRunFailure.mock.calls.filter(([report]) => report.runId === run!.id)).toHaveLength(1);
      expect(captureRunFailure).toHaveBeenCalledWith(expect.objectContaining({ runId: run!.id, runStatus: "failed", errorCode: "configuration_incomplete" }));
    } finally { proposal.mockReset(); proposal.mockImplementation(defaultProposal); unregisterServerAdapter("claude_local"); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);
  it("repairs the failed pool account without replacing the pool or adopting the configured provider", async () => {
    const pool = await makePool({ members: [members[1]!] });
    const [agent] = await db.insert(agents).values({ companyId, name: "Pool repair", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Pool repair", status: "in_progress", assigneeAgentId: agent!.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    const selection = await resolve(pool.id, issue!.id, { agentId: agent!.id });
    const runtime = await prepareManagedAiRuntime(db, { companyId, agentId: agent!.id, responsibleUserId: "alice", adapterType: "paperclip_runner", config: selection.runtimeConfig, binding: selection.binding });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "failed", errorCode: "acpx_auth_required", responsibleUserId: "alice", startedAt: new Date(), contextSnapshot: { issueId: issue!.id, aiRouterTaskKey: issue!.id, aiRouterSelection: selection, aiConnection: { ...runtime!.attribution, identity: runtime!.identity } } }).returning();
    try {
      const intents = connectionIntentService(db);
      const card = await intents.requestForRunAuthFailure(run!.id);
      expect(card?.service).toBe("anthropic"); expect(card?.state).toBe("needs_user_action");
      const options = await intents.setupOptions(card!.interactionId!);
      expect(options.aiConnection).toEqual(selection.binding); expect(options.aiConnectionRequiresAdoption).toBeUndefined();
      const [failedGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[1]!.binding.grantId)); expect(failedGrant?.status).toBe("needs_reauthorization");
      await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, members[1]!.binding.grantId));
      await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, members[1]!.binding.connectionId));
      expect(await intents.complete(card!.interactionId!, members[1]!.binding.connectionId, "alice")).toMatchObject({ status: "accepted" });
      const [savedAgent] = await db.select().from(agents).where(eq(agents.id, agent!.id)); expect(savedAgent?.runtimeConfig.aiConnection).toEqual({ mode: "router", connectionId: pool.id });
      expect((await resolve(pool.id, issue!.id, { agentId: agent!.id })).binding).toEqual(selection.binding);
      await db.update(agents).set({ runtimeConfig: { aiConnection: { mode: "router", connectionId: randomUUID() } } }).where(eq(agents.id, agent!.id));
      await expect(intents.setupOptions(card!.interactionId!)).rejects.toThrow("configuration changed");
    } finally {
      await runtime?.cleanup();
      await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, members[1]!.binding.grantId));
      await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, members[1]!.binding.connectionId));
    }
  });
  it("rejects disabled routing but recovers server-owned native evidence after disable/uninstall", async () => {
    const pool = await makePool(); const selected = await resolve(pool.id, "recovery");
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: false });
    try { await expect(resolve(pool.id, "recovery")).rejects.toMatchObject({ status: 422, details: { code: "ai_connection_router_disabled" } }); expect(await resolve(pool.id, "recovery", { persisted: selected })).toEqual(selected); }
    finally { await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true }); }
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
    try { await expect(resolve(pool.id, "new")).rejects.toThrow("plugin"); expect(await resolve(pool.id, "recovery", { persisted: selected })).toEqual(selected); await db.delete(toolConnections).where(eq(toolConnections.id, pool.id)); expect(await resolve(pool.id, "recovery", { persisted: selected })).toEqual(selected); }
    finally { await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId)); }
  });
  it("resumes a responsible-user session through a delegated pool using real managed account configurations", async () => {
    await aiConnectionService(db).setDefault(companyId, "alice", members[0]!.binding.grantId!);
    const pool = await makePool({ members: [members[0]!] });
    const selected = await resolve(pool.id, "managed-mode-adoption", { requireExisting: true, existingGrantId: members[0]!.binding.grantId });
    const directBinding = { mode: "responsible_user" as const, provider: "openai" as const, method: "api_key" as const };
    const prepare = { companyId, agentId, responsibleUserId: "alice", adapterType: "paperclip_runner", config: selected.runtimeConfig };
    const before = await prepareManagedAiRuntime(db, { ...prepare, binding: directBinding });
    const after = await prepareManagedAiRuntime(db, { ...prepare, binding: selected.binding });
    try {
      expect(before.config.managedAiConnection.mode).toBe("responsible_user");
      expect(after.config.managedAiConnection.mode).toBe("delegated");
      expect(after.sessionIdentity).toBe(before.sessionIdentity);
      const common = { adapterType: "paperclip_runner", issueOverrides: null, workspaceConfig: {}, environment: {}, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [], agentConfigRevision: null };
      const previous = await buildEffectiveRunSessionConfigMetadata({ ...common, effectiveAdapterConfig: before.config, managedAiHome: before.home, agentRuntimeConfig: { aiConnection: directBinding } });
      const currentInput = { ...common, effectiveAdapterConfig: after.config, managedAiHome: after.home, agentRuntimeConfig: { aiConnection: { mode: "router", connectionId: pool.id } } };
      const current = await buildEffectiveRunSessionConfigMetadata(currentInput);
      const alternatives = aiConnectionSessionCompatibilityInputs({ ...currentInput, originalIssueOverrides: null, binding: selected.binding, router: true, storedIdentity: before.sessionIdentity, sessionIdentity: after.sessionIdentity, credentialIdentity: after.identity, revisions: [] });
      const compatibleConfigMetadata = await Promise.all(alternatives.map(candidate => buildEffectiveRunSessionConfigMetadata({ ...currentInput, ...candidate })));
      expect(resolveTaskSessionConfigFreshness({ hasTaskSession: true, configuredModel: String(selected.runtimeConfig.model), taskSessionParams: { __paperclipConfiguredModel: selected.runtimeConfig.model, __paperclipConfigFingerprint: previous.fingerprint, __paperclipConfigFingerprintVersion: previous.version, __paperclipConfigCategoryFingerprints: previous.categoryFingerprints }, configMetadata: current, compatibleConfigMetadata }).reset).toBe(false);
    } finally { await before.cleanup(); await after.cleanup(); }
  });
  it("admits a healthy pool member when the saved Grok connection is held", async () => {
    const original = await instanceSettingsService(db).getExperimental();
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true,
      enableNativeRunner: true, enableGrokBot: true, enablePublicMcp: true, enableWorktreeRunExecution: true });
    const pool = await makePool({ members: [members[0]!] });
    const bindingId = randomUUID();
    const workspace = path.join(home, "routed-grok-work");
    await mkdir(workspace);
    const [agent] = await db.insert(agents).values({ companyId, name: "Routed Grok fixture", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "grok_bot", externalBindingId: bindingId, cwd: workspace },
      runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false, wakeOnDemand: true } } }).returning();
    await db.insert(dotAgentBindings).values({ id: bindingId, companyId, agentId: agent.id,
      operatorId: "alice", providerKind: "grok_bot", status: "connected" });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[0]!.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    await db.insert(grokBotRoutines).values({ companyId, agentId: agent.id, bindingId, bindingGeneration: 1,
      botName: "Unused held Bot", secretId: ref.secretId, secretVersion: 1,
      recoveryRequiredAt: new Date(), recoveryReason: "work_session" });
    expect(await dotRunnerBroker(db).canStartNewWork(companyId, agent.id, bindingId)).toBe(false);
    const readiness = vi.spyOn(dotRunnerBroker(db), "canStartNewWork");
    const beforeNative = vi.fn(async () => {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agent.id));
      throw new Error("fixture stopped before provider start");
    });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {},
      beforeNativeRuntimeSelection: beforeNative,
      nativeSessionBackendFactory: () => { throw new Error("Unexpected provider start"); } });
    const [issue] = await db.insert(issues).values({ companyId, title: "Healthy routed task", status: "todo",
      assigneeAgentId: agent.id, responsibleUserId: "alice", createdByUserId: "alice" }).returning();
    try {
      const run = await heartbeat.wakeup(agent.id, { source: "assignment", reason: "issue_assigned", triggerDetail: "system",
        payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id, responsibleUserId: "alice" } });
      expect(run).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      const saved = await heartbeat.getRun(run!.id);
      expect(saved?.contextSnapshot?.aiRouterSelection).toMatchObject({ poolId: pool.id,
        memberId: members[0]!.id, runtimeConfig: { provider: "codex" } });
      expect(saved?.error).toContain("fixture stopped before provider start");
      expect(beforeNative).toHaveBeenCalledExactlyOnceWith(run!.id);
      expect(readiness).not.toHaveBeenCalled();
    } finally {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agent.id));
      await heartbeat.drainActiveRunExecutions();
      readiness.mockRestore();
      await instanceSettingsService(db).updateExperimental(original);
    }
  }, 30_000);

  it("keeps session identity and fingerprints stable on authenticated refresh, but changes them on manual replacement", async () => {
    const input = { companyId, agentId, responsibleUserId: "alice", adapterType: "paperclip_runner", binding: members[0]!.binding, config: { provider: "codex", model: "gpt-5.6-sol" } };
    const first = await prepareManagedAiRuntime(db, input);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, members[0]!.binding.grantId)); const ref = grant!.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!;
    try {
      await secretService(db).rotate(ref.secretId, { value: "fixture-new-token", preserveAiSessionEpoch: true }, { userId: "alice" });
      const refreshed = await prepareManagedAiRuntime(db, input);
      try { expect(refreshed.identity).not.toBe(first.identity); expect(refreshed.sessionIdentity).toBe(first.sessionIdentity); expect(managedAiSessionFingerprintConfig(refreshed.config, refreshed.home)).toEqual(managedAiSessionFingerprintConfig(first.config, first.home)); } finally { await refreshed.cleanup(); }
      await secretService(db).rotate(ref.secretId, { value: "fixture-replacement" }, { userId: "alice" });
      const replaced = await prepareManagedAiRuntime(db, input); try { expect(replaced.sessionIdentity).not.toBe(first.sessionIdentity); } finally { await replaced.cleanup(); }
      const [secret] = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, ref.secretId))); expect(secret!.aiSessionEpoch).toBeGreaterThan(0);
    } finally { await first.cleanup(); }
  });
});


enableRunFailureReporting();
