import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  agents, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, companies,
  companyMemberships, createDb, heartbeatRuns, issues, toolApplications, toolConnections,
} from "@paperclipai/db";
import type { ToolCredentialSecretRef } from "@paperclipai/shared";
import { createChatCredentials } from "../services/chat-channels/credentials.js";
import { createSlackTaskAuthorityRegistration } from "../services/chat-channels/slack/task-authority.js";
import { resolveSlackTaskAuthority } from "../services/connectors/slack-authority.js";
import { slackAssignedResource } from "../services/connectors/slack.js";
import { slackToolsForSession, syncSlackBotTools } from "../services/connectors/slack-catalog.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

describeDatabase("Slack tool preparation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-slack-preparation-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
  });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Slack preparation", issuePrefix: randomUUID().slice(0, 8).toUpperCase() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Slack agent" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Briefing", assigneeAgentId: agentId, responsibleUserId: userId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: userId, contextSnapshot: { issueId, source: "routine" } });
    await initializeRunIdentity(db, { companyId, agentId, issueId, runId, responsibleUserId: userId, cause: "routine" });
    const refs: ToolCredentialSecretRef[] = [];
    const endpoints: Array<typeof chatEndpoints.$inferSelect> = [];
    const links: Array<typeof chatIdentityLinks.$inferSelect> = [];
    for (let i = 0; i < 2; i++) {
      const [application] = await db.insert(toolApplications).values({ companyId, name: `Slack ${i}`, type: "mcp_http" }).returning();
      const credentialSecretRefs = ["botToken", "signingSecret", "appToken"].map(key => ({ secretId: randomUUID(), configPath: `credentials.${key}`, versionSelector: "latest" as const, required: true }));
      refs.push(...credentialSecretRefs);
      const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: `Slack ${i}`, uid: randomUUID(), transport: "mcp_remote", credentialSecretRefs }).returning();
      const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection.id, assignedAgentId: agentId, provider: "slack", publicId: randomUUID(), providerAccountId: `T${i}`, status: "active" }).returning();
      endpoints.push(endpoint);
      const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "slack", providerAccountId: `T${i}`, externalId: `U${i}`, isBot: false }).returning();
      const [link] = await db.insert(chatIdentityLinks).values({ companyId, endpointId: endpoint.id, principalId: principal.id, paperclipUserId: userId, status: "linked" }).returning();
      links.push(link);
      await db.transaction(tx => syncSlackBotTools(tx, endpoint, userId, true));
    }
    const token = "current-bot-token";
    const resolveSecretValue = vi.fn(async (_companyId: string, secretId: string) => {
      const ref = refs.find(ref => ref.secretId === secretId)!;
      return ref.configPath === "credentials.botToken" ? token : "webhook-secret";
    });
    const credentials = createChatCredentials(db, { secrets: { resolveSecretValue } } as unknown as Parameters<typeof createChatCredentials>[1]);
    const registration = createSlackTaskAuthorityRegistration(db, {
      resolveCredentials: credentials.resolveCredentials,
      authorizeInboundWakeup: async () => { throw new Error("This is an ordinary task"); },
    });
    return { binding: { companyId, agentId, issueId, runId }, endpoints, links, refs, resolveSecretValue,
      ...registration };
  }

  const paths = {
    assignments: async (binding: { companyId: string; agentId: string; runId: string; issueId: string }) =>
      (await slackAssignedResource(db, binding)).map(resource => resource.id),
    tools: async (binding: { companyId: string; agentId: string; runId: string; issueId: string }) =>
      [...new Set((await slackToolsForSession(db, binding)).map(tool => String(tool.providerMetadata?.endpointId)))],
  };

  it("does not compute an unused revision when preparing the session catalog", async () => {
    const f = await fixture();
    const queries: string[] = [];
    const measured = drizzle(db.$client, { logger: { logQuery: query => queries.push(query) } }) as typeof db;
    const registration = createSlackTaskAuthorityRegistration(measured, {
      resolveCredentials: createChatCredentials(measured, { secrets: { resolveSecretValue: f.resolveSecretValue } } as unknown as Parameters<typeof createChatCredentials>[1]).resolveCredentials,
      authorizeInboundWakeup: async () => { throw new Error("This is an ordinary task"); },
    });
    try {
      const tools = await slackToolsForSession(measured, f.binding);
      expect([...new Set(tools.map(tool => tool.providerMetadata?.endpointId))].sort()).toEqual(f.endpoints.map(endpoint => endpoint.id).sort());
      expect(queries.filter(query => query.includes("row_to_json(revision_row)"))).toHaveLength(0);
      queries.length = 0;
      const authority = await resolveSlackTaskAuthority(measured, { ...f.binding, endpointId: f.endpoints[1].id });
      expect(authority.revision).toMatch(/^[0-9a-f]{64}$/);
      expect(queries.filter(query => query.includes("row_to_json(revision_row)"))).toHaveLength(1);
      await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.id, f.links[0].id));
      queries.length = 0;
      f.resolveSecretValue.mockClear();
      expect([...new Set((await slackToolsForSession(measured, f.binding)).map(tool => tool.providerMetadata?.endpointId))]).toEqual([f.endpoints[1].id]);
      expect(f.resolveSecretValue).toHaveBeenCalledTimes(1);
      expect(queries.filter(query => query.includes("row_to_json(revision_row)"))).toHaveLength(0);
    } finally {
      registration.unregisterSlackTaskAuthority();
      f.unregisterSlackTaskAuthority();
    }
  });

  it.each(Object.entries(paths))("overlaps two independent endpoint checks for %s", async (_name, prepare) => {
    const f = await fixture();
    const gate = deferred();
    let active = 0, peak = 0;
    f.resolveSecretValue.mockImplementation(async (_companyId, secretId) => {
      if (f.refs.find(ref => ref.secretId === secretId)!.configPath === "credentials.botToken") {
        active++; peak = Math.max(peak, active);
        await gate.promise;
        active--;
      }
      return "credential";
    });
    const pending = prepare(f.binding);
    try {
      await vi.waitFor(() => expect(peak).toBe(2), { timeout: 1000, interval: 10 });
    } finally {
      gate.resolve();
      await pending;
      f.unregisterSlackTaskAuthority();
    }
    expect((await pending).sort()).toEqual(f.endpoints.map(endpoint => endpoint.id).sort());
  });

  it("resolves only current bot credentials and observes rotation without a cache", async () => {
    const f = await fixture();
    f.resolveSecretValue.mockImplementation(async (_companyId, secretId) => {
      const ref = f.refs.find(ref => ref.secretId === secretId)!;
      if (ref.configPath !== "credentials.botToken") throw new Error("Webhook credential is unavailable");
      return f.resolveSecretValue.mock.calls.length === 1 ? "old-bot-token" : "rotated-bot-token";
    });
    try {
      const binding = { ...f.binding, endpointId: f.endpoints[0].id };
      const before = await resolveSlackTaskAuthority(db, binding);
      const after = await resolveSlackTaskAuthority(db, binding);
      expect(before.botToken).toBe("old-bot-token");
      expect(after.botToken).toBe("rotated-bot-token");
      expect(after.revision).not.toBe(before.revision);
      expect(f.resolveSecretValue).toHaveBeenCalledTimes(2);
    } finally { f.unregisterSlackTaskAuthority(); }
  });

  it("preserves a failed or missing bot credential", async () => {
    const f = await fixture();
    const binding = { ...f.binding, endpointId: f.endpoints[0].id };
    try {
      const error = new Error("Bot credential is revoked");
      f.resolveSecretValue.mockRejectedValueOnce(error);
      await expect(resolveSlackTaskAuthority(db, binding)).rejects.toBe(error);
      f.resolveSecretValue.mockResolvedValueOnce("");
      await expect(resolveSlackTaskAuthority(db, binding)).rejects.toMatchObject({ status: 403 });
    } finally { f.unregisterSlackTaskAuthority(); }
  });

  it.each(Object.entries(paths))("rechecks bot credential availability for %s", async (_name, prepare) => {
    const f = await fixture();
    try {
      expect((await prepare(f.binding)).sort()).toEqual(f.endpoints.map(endpoint => endpoint.id).sort());
      const error = new Error("Bot credential is revoked");
      f.resolveSecretValue.mockClear();
      f.resolveSecretValue.mockRejectedValue(error);
      await expect(prepare(f.binding)).rejects.toBe(error);
      expect(f.resolveSecretValue).toHaveBeenCalledTimes(2);
      f.resolveSecretValue.mockClear();
      f.resolveSecretValue.mockResolvedValue("");
      expect(await prepare(f.binding)).toEqual([]);
      expect(f.resolveSecretValue).toHaveBeenCalledTimes(2);
    } finally { f.unregisterSlackTaskAuthority(); }
  });

  it.each(Object.entries(paths))("rechecks identity revocation for %s without touching another company", async (_name, prepare) => {
    const f = await fixture();
    const foreign = await fixture();
    foreign.unregisterSlackTaskAuthority();
    const registration = createSlackTaskAuthorityRegistration(db, {
      resolveCredentials: createChatCredentials(db, { secrets: { resolveSecretValue: f.resolveSecretValue } } as unknown as Parameters<typeof createChatCredentials>[1]).resolveCredentials,
      authorizeInboundWakeup: async () => { throw new Error("This is an ordinary task"); },
    });
    try {
      expect((await prepare(f.binding)).sort()).toEqual(f.endpoints.map(endpoint => endpoint.id).sort());
      await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.id, f.links[0].id));
      f.resolveSecretValue.mockClear();
      expect(await prepare(f.binding)).toEqual([f.endpoints[1].id]);
      expect(f.resolveSecretValue).toHaveBeenCalledTimes(1);
      expect(f.resolveSecretValue.mock.calls[0][0]).toBe(f.binding.companyId);
    } finally { registration.unregisterSlackTaskAuthority(); }
  });
});
