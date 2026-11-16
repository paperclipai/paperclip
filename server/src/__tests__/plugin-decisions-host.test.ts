import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDb, companies, companyMemberships, costEvents, decisionInvocations, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { DECISION_TEST_REQUEST } from "@paperclipai/shared";
import { aiConnectionService } from "../services/ai-connections.js";
import { decisionModelService } from "../services/decision-models.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const reply = JSON.stringify({ answers: { billing: { probability: 0.9 }, team: { choice: "billing" }, severity: { score: 0 } } });
beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-decisions-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "plugin-decisions-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-plugin-decisions-db-");
  db = createDb(database.connectionString);
}, 90000);
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
let sequence = 0;
async function fixture() {
  const companyId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Plugin decisions", issuePrefix: `PD${++sequence}` });
  await db.insert(companyMemberships).values({ companyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "owner" });
  const connections = aiConnectionService(db);
  const routing = { kind: "gateway" as const, baseUrl: "https://gateway.example/v1", auth: "bearer" as const, models: [] };
  const chat = await connections.save(companyId, "alice", { provider: "openai", method: "api_key", name: "Gateway chat", ownership: "shared", apiKey: "chat-key",
    agentIds: [], allAgents: true, routing: { ...routing, protocol: "chat" } } as never, "chat-key");
  const messages = await connections.save(companyId, "alice", { provider: "anthropic", method: "api_key", name: "Gateway messages", ownership: "shared", apiKey: "messages-key",
    agentIds: [], allAgents: true, routing: { ...routing, protocol: "messages" } } as never, "messages-key");
  await decisionModelService(db).configure(companyId, "alice", { ...chat, enabled: true, model: "combo/default" });
  const transport = vi.fn<typeof fetch>(async input => String(input).endsWith("/models")
    ? Response.json({ data: [{ id: "combo/default" }] })
    : Response.json({ id: "chatcmpl", choices: [{ message: { content: reply } }], content: [{ type: "text", text: reply }], usage: { prompt_tokens: 5, completion_tokens: 2, input_tokens: 5, output_tokens: 2 } }));
  vi.stubGlobal("fetch", transport);
  const host = buildHostServices(db, randomUUID(), "acme.Triage Bot", createPluginEventBus());
  const handlers = (capabilities: string[]) => createHostClientHandlers({ pluginId: "acme.triage", capabilities: capabilities as never, services: host });
  return { companyId, chat, messages, host, handlers, transport, scope: { invocationScope: { companyId } } };
}
describe("plugin decisions.invoke", () => {
  it("requires the decisions.invoke capability for every decision method", async () => {
    const f = await fixture();
    try {
      const handlers = f.handlers(["issues.read"]);
      for (const method of ["decisions.connections", "decisions.models", "decisions.decide"] as const)
        await expect(handlers[method]({ companyId: f.companyId, connectionId: f.chat.connectionId, ...DECISION_TEST_REQUEST } as never, f.scope)).rejects.toThrow(/decisions\.invoke/);
      expect(f.transport).not.toHaveBeenCalled();
    } finally { f.host.dispose(); }
  });
  it("runs as a background plugin feature with the company default or a validated override", async () => {
    const f = await fixture();
    try {
      const handlers = f.handlers(["decisions.invoke"]);
      const listed = await handlers["decisions.connections"]({ companyId: f.companyId }, f.scope);
      expect(listed.companyDefault).toEqual({ connectionId: f.chat.connectionId, name: "Gateway chat", model: "combo/default" });
      expect(listed.connections.map(row => row.protocol).sort()).toEqual(["chat", "messages"]);
      expect(await handlers["decisions.models"]({ companyId: f.companyId, connectionId: f.chat.connectionId }, f.scope)).toEqual({ models: [{ id: "combo/default", name: "combo/default" }] });
      expect(await handlers["decisions.decide"]({ companyId: f.companyId, ...DECISION_TEST_REQUEST }, f.scope)).toMatchObject({ status: "succeeded", answers: { team: { choice: "billing" } } });
      expect(await handlers["decisions.decide"]({ companyId: f.companyId, connectionId: f.messages.connectionId, model: "claude-x", ...DECISION_TEST_REQUEST }, f.scope)).toMatchObject({ status: "succeeded" });
      const calls = f.transport.mock.calls.filter(([url]) => !String(url).endsWith("/models"));
      expect(calls.map(([url, init]) => [String(url), JSON.parse(String(init?.body)).model])).toEqual([
        ["https://gateway.example/v1/chat/completions", "combo/default"], ["https://gateway.example/v1/messages", "claude-x"],
      ]);
      const invocations = await db.select().from(decisionInvocations).where(eq(decisionInvocations.companyId, f.companyId));
      expect(invocations.map(row => [row.feature, row.actorType, row.responsibleUserId, row.model])).toEqual(expect.arrayContaining([
        ["plugin.acme.triage-bot", "system", null, "combo/default"], ["plugin.acme.triage-bot", "system", null, "claude-x"],
      ]));
      expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId))).toHaveLength(2);
      expect(await handlers["decisions.decide"]({ companyId: f.companyId, connectionId: randomUUID(), ...DECISION_TEST_REQUEST }, f.scope)).toEqual({ status: "unavailable", reason: "incompatible_connection" });
      const other = await fixture();
      try {
        expect(await handlers["decisions.decide"]({ companyId: f.companyId, connectionId: other.chat.connectionId, model: "m", ...DECISION_TEST_REQUEST }, f.scope)).toEqual({ status: "unavailable", reason: "incompatible_connection" });
        const [foreignIssue] = await db.insert(issues).values({ companyId: other.companyId, title: "Foreign" }).returning();
        expect(await handlers["decisions.decide"]({ companyId: f.companyId, issueId: foreignIssue.id, ...DECISION_TEST_REQUEST }, f.scope)).toEqual({ status: "unavailable", reason: "access_denied" });
      } finally { other.host.dispose(); }
      const [ownIssue] = await db.insert(issues).values({ companyId: f.companyId, title: "Own" }).returning();
      expect(await handlers["decisions.decide"]({ companyId: f.companyId, issueId: ownIssue.id, ...DECISION_TEST_REQUEST }, f.scope)).toMatchObject({ status: "succeeded" });
      await expect(handlers["decisions.decide"]({ companyId: f.companyId, state: "x".repeat(33_000), questions: DECISION_TEST_REQUEST.questions }, f.scope)).rejects.toThrow();
    } finally { f.host.dispose(); }
  });
  it("needs company sponsorship and enabled decisions even with an override", async () => {
    const f = await fixture();
    try {
      const handlers = f.handlers(["decisions.invoke"]);
      const service = decisionModelService(db);
      await service.configure(f.companyId, "alice", { ...f.chat, enabled: true, allowBackground: false });
      expect(await handlers["decisions.decide"]({ companyId: f.companyId, connectionId: f.messages.connectionId, model: "claude-x", ...DECISION_TEST_REQUEST }, f.scope)).toEqual({ status: "unavailable", reason: "background_disabled" });
      await service.configure(f.companyId, "alice", { ...f.chat, enabled: false, allowBackground: true });
      expect(await handlers["decisions.decide"]({ companyId: f.companyId, connectionId: f.messages.connectionId, model: "claude-x", ...DECISION_TEST_REQUEST }, f.scope)).toEqual({ status: "unavailable", reason: "disabled" });
      expect((await handlers["decisions.connections"]({ companyId: f.companyId }, f.scope)).companyDefault).toBeNull();
      expect(f.transport).not.toHaveBeenCalled();
    } finally { f.host.dispose(); }
  });
});
