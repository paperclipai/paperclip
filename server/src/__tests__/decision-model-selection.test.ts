import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { createDb, companies, companyMemberships, costEvents, decisionInvocations, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { DECISION_TEST_REQUEST } from "@paperclipai/shared";
import { aiConnectionService } from "../services/ai-connections.js";
import { decisionModelService, defineDecisionFeature, type DecisionContext } from "../services/decision-models.js";
import { decisionReceipt, type DecisionProviderOutcome } from "../services/decision-model-provider.js";
import { decisionModelRoutes } from "../routes/decision-models.js";
import { errorHandler } from "../middleware/index.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const background = defineDecisionFeature("test.selection", { background: true });
const outcome: DecisionProviderOutcome = { answers: { billing: { type: "boolean", probability: 0.9 } }, receipt: decisionReceipt("openai", { usage: { inputTokens: 10, outputTokens: 0 } }) };
const gatewayRouting = (protocol: "chat" | "messages") => ({ kind: "gateway" as const, protocol, baseUrl: "https://gateway.example/v1", auth: "bearer" as const, models: [] });
beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-decision-selection-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "decision-selection-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-decision-selection-db-");
  db = createDb(database.connectionString);
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
let sequence = 0;
async function fixture(fetchImpl?: typeof fetch) {
  const companyId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Decision selection", issuePrefix: `DS${++sequence}` });
  await db.insert(companyMemberships).values({ companyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "owner" });
  const connections = aiConnectionService(db);
  const save = (input: Record<string, unknown>) => connections.save(companyId, "alice", { method: "api_key", ownership: "shared", agentIds: [], allAgents: true, ...input } as never, String(input.apiKey));
  const openrouter = await save({ provider: "openrouter", name: "Router", apiKey: "router-key" });
  const chat = await save({ provider: "openai", name: "Gateway chat", apiKey: "chat-key", routing: gatewayRouting("chat") });
  const messages = await save({ provider: "anthropic", name: "Gateway messages", apiKey: "messages-key", routing: gatewayRouting("messages") });
  const provider = vi.fn().mockResolvedValue(structuredClone(outcome));
  const service = decisionModelService(db, { provider, fetch: fetchImpl });
  const actor = { type: "board" as const, userId: "alice", source: "session" as const, companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }] };
  return { companyId, openrouter, chat, messages, provider, service, actor };
}
describe("decision model selection", () => {
  it("stores a selected model, keeps it on later saves and resets it for another connection", async () => {
    const f = await fixture();
    expect((await f.service.configure(f.companyId, "alice", { ...f.openrouter, enabled: true })).model).toBe("typesafe/jev-1.13");
    expect((await f.service.configure(f.companyId, "alice", { ...f.openrouter, enabled: true, model: "vendor/other-1" })).model).toBe("vendor/other-1");
    expect((await f.service.configure(f.companyId, "alice", { ...f.openrouter, enabled: true, allowBackground: false })).model).toBe("vendor/other-1");
    expect((await f.service.configure(f.companyId, "alice", { ...f.openrouter, enabled: false })).model).toBe("vendor/other-1");
    expect((await f.service.configure(f.companyId, "alice", { ...f.openrouter, enabled: true, model: null })).model).toBe("typesafe/jev-1.13");
    await f.service.configure(f.companyId, "alice", { ...f.openrouter, enabled: true, allowBackground: true, model: "vendor/other-1" });
    expect(await f.service.decide({ companyId: f.companyId, feature: background, actor: { type: "system" } }, DECISION_TEST_REQUEST)).toMatchObject({ status: "succeeded" });
    expect(f.provider.mock.calls[0][0]).toMatchObject({ provider: "openrouter", model: "vendor/other-1", apiKey: "router-key" });
    const [invocation] = await db.select().from(decisionInvocations).where(eq(decisionInvocations.companyId, f.companyId));
    expect(invocation).toMatchObject({ provider: "openrouter", model: "vendor/other-1" });
    expect((await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId)))[0]).toMatchObject({ provider: "vendor", biller: "openrouter", model: "vendor/other-1" });
  });
  it("lists gateway connections and requires a model before enabling them", async () => {
    const f = await fixture();
    const choices = await f.service.choices(f.companyId, "alice");
    expect(choices.map(row => [row.name, row.decisionProtocol, row.decisionModel])).toEqual(expect.arrayContaining([
      ["Router", "decisions", "typesafe/jev-1.13"], ["Gateway chat", "chat", null], ["Gateway messages", "messages", null],
    ]));
    await expect(f.service.configure(f.companyId, "alice", { ...f.chat, enabled: true })).rejects.toMatchObject({ status: 422 });
    expect(await f.service.configure(f.companyId, "alice", { ...f.messages, enabled: true, model: "claude-x" })).toMatchObject({ provider: "gateway", model: "claude-x" });
    expect(await f.service.decide({ companyId: f.companyId, feature: background, actor: { type: "system" } }, DECISION_TEST_REQUEST)).toMatchObject({ status: "succeeded" });
    expect(f.provider.mock.calls[0][0]).toMatchObject({ provider: "gateway", model: "claude-x", apiKey: "messages-key",
      route: { protocol: "messages", baseUrl: "https://gateway.example/v1" } });
    expect((await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId)))[0]).toMatchObject({ provider: "gateway", biller: "gateway" });
  });
  it("applies per-call connection and model overrides only for compatible connections of the same company", async () => {
    const f = await fixture(), other = await fixture();
    await f.service.configure(f.companyId, "alice", { ...f.openrouter, enabled: true });
    const context: DecisionContext = { companyId: f.companyId, feature: background, actor: { type: "system" } };
    expect(await f.service.decide({ ...context, model: "vendor/override" }, DECISION_TEST_REQUEST)).toMatchObject({ status: "succeeded" });
    expect(f.provider.mock.calls[0][0]).toMatchObject({ provider: "openrouter", model: "vendor/override" });
    expect(await f.service.decide({ ...context, connectionId: f.chat.connectionId }, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable", reason: "incompatible_connection" });
    expect(await f.service.decide({ ...context, connectionId: f.chat.connectionId, model: "combo/fast" }, DECISION_TEST_REQUEST)).toMatchObject({ status: "succeeded" });
    expect(f.provider.mock.calls[1][0]).toMatchObject({ provider: "gateway", model: "combo/fast", apiKey: "chat-key", route: { protocol: "chat" } });
    expect((await db.select().from(decisionInvocations).where(eq(decisionInvocations.connectionId, f.chat.connectionId)))[0]).toMatchObject({ model: "combo/fast", provider: "gateway" });
    for (const connectionId of [other.chat.connectionId, randomUUID(), "not-a-uuid"])
      expect(await f.service.decide({ ...context, connectionId, model: "m" }, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable", reason: "incompatible_connection" });
    expect(await f.service.decide({ ...context, model: "bad model" }, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable", reason: "incompatible_connection" });
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.chat.connectionId));
    expect(await f.service.decide({ ...context, connectionId: f.chat.connectionId, model: "m" }, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable", reason: "incompatible_connection" });
    await f.service.configure(f.companyId, "alice", { ...f.openrouter, enabled: true, allowBackground: false });
    expect(await f.service.decide({ ...context, connectionId: f.messages.connectionId, model: "m" }, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable", reason: "background_disabled" });
    await f.service.configure(f.companyId, "alice", { ...f.openrouter, enabled: false, allowBackground: true });
    expect(await f.service.decide({ ...context, connectionId: f.messages.connectionId, model: "m" }, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable", reason: "disabled" });
    expect(f.provider).toHaveBeenCalledTimes(2);
  });
  it("reports the company default and compatible connections for plugins", async () => {
    const f = await fixture();
    expect((await f.service.connectionOptions(f.companyId)).companyDefault).toBeNull();
    await f.service.configure(f.companyId, "alice", { ...f.openrouter, enabled: true, model: "vendor/x" });
    const options = await f.service.connectionOptions(f.companyId);
    expect(options.companyDefault).toEqual({ connectionId: f.openrouter.connectionId, name: "Router", model: "vendor/x" });
    expect(options.connections).toEqual(expect.arrayContaining([
      { id: f.chat.connectionId, name: "Gateway chat", provider: "gateway", protocol: "chat" },
      { id: f.messages.connectionId, name: "Gateway messages", provider: "gateway", protocol: "messages" },
      { id: f.openrouter.connectionId, name: "Router", provider: "openrouter", protocol: "decisions" },
    ]));
    expect(JSON.stringify(options)).not.toContain("key");
    await db.update(toolConnections).set({ status: "archived", enabled: false }).where(eq(toolConnections.id, f.openrouter.connectionId));
    const archived = await f.service.connectionOptions(f.companyId);
    expect(archived.companyDefault).toBeNull();
    expect(archived.connections.map(c => c.id)).not.toContain(f.openrouter.connectionId);
  });
  it("lists models through the connection and the manager route", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: "combo/fast", name: "Fast" }] }));
    const f = await fixture(transport);
    const audit = { responsibleUserId: "alice", actorType: "user" as const, actorId: "alice" };
    expect(await f.service.models(f.companyId, f.chat.connectionId, audit)).toEqual({ models: [{ id: "combo/fast", name: "Fast" }] });
    expect(String(transport.mock.calls[0][0])).toBe("https://gateway.example/v1/models");
    expect(new Headers(transport.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer chat-key");
    expect(await f.service.models(f.companyId, randomUUID(), audit)).toEqual({ models: [], errorCode: "incompatible_connection" });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = f.actor as typeof req.actor; next(); });
    app.use("/api", decisionModelRoutes(db)); app.use(errorHandler);
    const url = `/api/companies/${f.companyId}/decision-model/models`;
    expect((await request(app).get(url)).status).toBe(400);
    expect((await request(app).get(`${url}?connectionId=${randomUUID()}`)).body).toEqual({ models: [], errorCode: "incompatible_connection" });
  });
});
