import { createToolGatewayService } from "../services/tool-gateway.js";
import { commitToolActionReview } from "../services/tool-action-review.js";
import { googleWorkspaceSelectedScopes, defaultGitHubReviewPolicy, SLACK_CHAT_BOT_SCOPES, SLACK_BOT_TOOL_SCOPES } from "@paperclipai/shared";
import { createHash, randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { createServer } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createDb, authUsers, activityLog, agentApiKeys, companies, companySecrets, companySecretVersions, chatConversations, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, toolPolicies, toolRateLimitCounters, connectionGrants, connectionGrantMembers, connectionGrantDelegations, toolAccessAuditEvents, toolOauthStates, issueThreadInteractions, connectionIntentDeliveries, agents, companyMemberships, heartbeatRuns, issues, principalPermissionGrants, projects, toolApplications, toolConnections, toolConnectionInstalls, aiConnectionPools, toolMcpGateways, toolMcpGatewayTokens, toolActionRequests, toolCatalogEntries, toolInvocations, toolCallEvents, toolProfileEntries, toolProfiles, toolProfileBindings, plugins, adapterAuthSessions, environments, routines, chatGitHubReviews } from "@paperclipai/db";
import { findSatisfiedToolConnection, satisfiedConnectionIntentService } from "../services/satisfied-connection-intents.js";
import { connectionManagementService, continuingConnectionManagement } from "../services/connection-management.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { redactRunnerApiPayloads } from "../services/native-runtime/runner-api-log-redaction.js";
import * as remoteEndpointGuard from "../services/remote-http-endpoint-guard.js";
import * as remoteHttpFetch from "../services/remote-http-fetch.js";
import * as runIdentity from "../services/run-identity.js";
import * as connectionManagementModule from "../services/connection-management.js";
import * as localBrowserLogin from "../services/local-ai-browser-login.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { agentService } from "../services/agents.js";
import { accessService } from "../services/access.js";
import { secretService } from "../services/secrets.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import type { AuthorizationActor } from "../services/authorization.js";
import type { ConnectionManagementResource } from "../services/connection-management-policy.js";

vi.mock("../services/agent-lifecycle-driver.js", () => ({
  createLifecycleDriver: () => ({ requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" }),
}));

vi.mock("../services/chat-channels/github/webhook-recovery-work.js", async importOriginal => {
  const original = await importOriginal<typeof import("../services/chat-channels/github/webhook-recovery-work.js")>();
  return { ...original, registerGitHubWebhookRecoveryWork: (...args: Parameters<typeof original.registerGitHubWebhookRecoveryWork>) =>
    original.registerGitHubWebhookRecoveryWork(args[0], args[1], () => false) };
});

import { createConnectionManagementHarness, type ConnectionManagementLifecycle, type ConnectionManagementProviderHandler, type ConnectionManagementServer } from "./helpers/connection-management-harness.js";

// All requests traverse the assembled server and production bearer middleware.
// No req.actor injection or special permission grants establish access.
describe("connection management Slack, GitHub, email, activity, and local-login providers", () => {
  let server!: ConnectionManagementServer;
  let lifecycle!: ConnectionManagementLifecycle;
  let provider: ConnectionManagementProviderHandler | null = null;
  const harness = createConnectionManagementHarness(() => provider);
  beforeAll(() => {
    server = harness.server;
    lifecycle = harness.lifecycle;
  });
  const fixture = () => harness.fixture();

  it("persists meaningful Slack and GitHub endpoint configuration for the responsible user", async () => {
    const f = await fixture();
    for (const provider of ["slack", "github"]) {
      const result = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider, assignedAgentId: f.agentId, name: `${provider} fixture`, ...(provider === "slack" ? { slackSetupMethod: "manual" } : {}) });
      expect(result, JSON.stringify(result)).toMatchObject({ status: 201 });
      if (provider === "slack") {
        const patch = { requireAtMention: true, allowDirectMessages: false };
        const updated = await f.request("PATCH", `/chat-endpoints/${result.body.id}`, patch);
        expect(updated, JSON.stringify(updated)).toMatchObject({ status: 200, body: patch });
      } else {
        const current = await f.request("GET", `/chat-endpoints/${result.body.id}/github/configuration`);
        expect(current, JSON.stringify(current)).toMatchObject({ status: 200 });
        const body = { expectedRevision: current.body.revision, configuration: { ...current.body.configuration, memberAccess: "selected" } };
        const updated = await f.request("PUT", `/chat-endpoints/${result.body.id}/github/configuration`, body);
        expect(updated, JSON.stringify(updated)).toMatchObject({ status: 200, body: { revision: 1, configuration: { memberAccess: "selected" } } });
        expect(await f.request("PUT", `/chat-endpoints/${result.body.id}/github/configuration`, body)).toMatchObject({ status: 409 });
        const otherUserId = randomUUID();
        await accessService(server.db).ensureMembership(f.companyId, "user", otherUserId, "operator", "active");
        for (const token of [f.key.token, f.jwt]) {
          for (const field of ["responsible", "guest"]) {
            const configuration = structuredClone(updated.body.configuration);
            if (field === "responsible") configuration.responsibleUserId = otherUserId;
            else configuration.people.push({ kind: "guest", githubUserId: "42", login: "guest", sponsorUserId: otherUserId, permissionProfile: "restricted" });
            const denied = await f.request("PUT", `/chat-endpoints/${result.body.id}/github/configuration`, { expectedRevision: 1, configuration }, token);
            expect(denied, JSON.stringify(denied)).toMatchObject({ status: 403 });
            expect(JSON.stringify(denied.body)).toContain("task sponsor");
          }
        }
        expect((await f.request("GET", `/chat-endpoints/${result.body.id}/github/configuration`)).body).toMatchObject({ revision: 1, configuration: updated.body.configuration });
        const handoff = await f.request("POST", `/chat-endpoints/${result.body.id}/github/identity/start`, {});
        expect(handoff).toMatchObject({ status: 200, body: { requiredUserAction: { userId: f.userId, resource: { id: result.body.id } } } });
      }
      expect((await f.request("GET", `/chat-endpoints/${result.body.id}`)).body.sponsorUserId).toBe(f.userId);
    }
  });

  it("configures Slack against provider fixtures and subjects test messages to the normal action policy", async () => {
    const f = await fixture();
    const botId = `U${f.agentId.replaceAll("-", "").toUpperCase()}`;
    const scopes = [...SLACK_CHAT_BOT_SCOPES, ...SLACK_BOT_TOOL_SCOPES];
    let sent = 0;
    let revokeDuringAuth = false;
    provider = async (url, init) => {
      if (url.endsWith("auth.test")) {
        if (revokeDuringAuth) await accessService(server.db).ensureMembership(f.companyId, "user", f.userId, "operator", "suspended");
        return Response.json({ ok: true, team_id: "TFIXTURE", team: "Fixture workspace", user_id: botId, user: "fixture-bot" }, { headers: { "x-oauth-scopes": scopes.join(",") } });
      }
      if (url.includes("conversations.list")) return Response.json({ ok: true, channels: [], response_metadata: { next_cursor: "" } });
      if (url.endsWith("users.info")) return Response.json({ ok: true, user: { id: new URLSearchParams(String(init?.body)).get("user") ?? "UHUMAN", team_id: "TFIXTURE", name: "Fixture user", is_bot: false, deleted: false } });
      if (url.endsWith("chat.postMessage")) { sent++; return Response.json({ ok: true, channel: "DTEST", ts: "1.000001" }); }
      if (url.endsWith("agents.sessions.setStatus")) return Response.json({ ok: true });
      throw new Error(`Unexpected Slack fixture operation: ${new URL(url).pathname}`);
    };
    try {
      const created = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "slack", assignedAgentId: f.agentId, slackSetupMethod: "manual" });
      const setupPath = `/chat-endpoints/${created.body.id}/setup`;
      const cookie = await server.humanSession(f.userId);
      const configuredResponse = await fetch(server.apiUrl + "/api" + setupPath, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "configure", credentials: { botToken: "xoxb-fixture-token", signingSecret: "fixture-signing-secret" } }) });
      const configured = { status: configuredResponse.status, body: await configuredResponse.json() };
      expect(configured, JSON.stringify(configured)).toMatchObject({ status: 200 });
      expect(JSON.stringify(configured.body)).not.toContain("xoxb-fixture-token");
      const [configuredEndpoint] = await server.db.select().from(chatEndpoints).where(eq(chatEndpoints.id, created.body.id));
      await server.db.update(chatEndpoints).set({ status: "active", setup: { ...configuredEndpoint.setup, step: "complete", webhookVerifiedAt: new Date().toISOString() } }).where(eq(chatEndpoints.id, created.body.id));
      const [before] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      const botTokenRef = before.credentialSecretRefs.find(ref => ref.configPath === "credentials.botToken")!;
      const rebound = before.credentialSecretRefs.map(ref => ref.configPath === "credentials.signingSecret" ? { ...ref, secretId: botTokenRef.secretId } : ref);
      expect(await f.request("PATCH", `/tool-connections/${created.body.connectionId}`, { credentialSecretRefs: rebound }, f.jwt))
        .toMatchObject({ status: 403, body: { code: "chat_endpoint_credentials_require_setup" } });
      let credentialIntentId: string | undefined;
      for (const action of ["reconnect", "configure"] as const) for (const token of [f.key.token, f.jwt]) {
        const chosen = "agent-chosen-webhook-key";
        const handoff = await f.request("POST", setupPath, { action, credentials: { signingSecret: chosen } }, token);
        expect(handoff, JSON.stringify(handoff)).toMatchObject({ status: 200, body: { status: "needs_user_action", endpointId: created.body.id,
          requiredUserAction: { kind: "enter_credentials", userId: f.userId, resource: { id: created.body.id } } } });
        expect(JSON.stringify(handoff.body)).not.toContain(chosen);
        expect(handoff.body.requiredUserAction.setupPath).toContain("stage=credentials&reconnect=1");
        const entryLink = new URL(handoff.body.requiredUserAction.setupPath, server.apiUrl);
        expect.soft(entryLink.searchParams.get("credentialFields")).toBe("signingSecret");
        expect.soft(entryLink.searchParams.get("credentialMode")).toBe("all");
        if (token === f.jwt) {
          if (credentialIntentId) expect(handoff.body.interactionId).toBe(credentialIntentId);
          credentialIntentId = handoff.body.interactionId;
        }
        const [after] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
        expect(after.credentialSecretRefs).toEqual(before.credentialSecretRefs);
        const signing = after.credentialSecretRefs.find(ref => ref.configPath === "credentials.signingSecret")!;
        expect(await secretService(server.db).resolveSecretValue(f.companyId, signing.secretId, "latest", {
          accessContext: { consumerType: "system", consumerId: "integration-fixture", actorType: "system" },
        })).toBe("fixture-signing-secret");
      }
      const [credentialIntent] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, credentialIntentId!));
      const [task] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
      const entryProof = (credentialIntent.payload as { savedSetup: { credentialEntry: { previousGenerations: Record<string, string>; requireAll: boolean } } }).savedSetup.credentialEntry;
      expect(entryProof).toEqual({ previousGenerations: { signingSecret: expect.any(String) }, requireAll: true });
      expect(await findSatisfiedToolConnection(server.db, task, credentialIntent)).toBeNull();
      await satisfiedConnectionIntentService(server.db).sweepPending();
      expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, credentialIntentId!)))[0].status).toBe("pending");
      // Ordinary write-only bot-token repair remains delegated under current authority.
      expect(await f.request("POST", setupPath, { action: "reconnect", credentials: { botToken: "xoxb-fixture-token" } }, f.jwt)).toMatchObject({ status: 200, body: { id: created.body.id } });
      const healthy = async () => {
        await server.db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, created.body.id));
        await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
      };
      await healthy();
      expect(await findSatisfiedToolConnection(server.db, task, credentialIntent)).toBeNull();
      const humanReconnect = async (signingSecret: string) => {
        const response = await fetch(server.apiUrl + "/api" + setupPath, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reconnect", credentials: { signingSecret, botToken: "xoxb-fixture-token" } }) });
        expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200 });
      };
      await humanReconnect("fixture-signing-secret");
      await healthy();
      expect(await findSatisfiedToolConnection(server.db, task, credentialIntent)).toBeNull();
      await humanReconnect("human-replacement-signing-secret");
      expect(await findSatisfiedToolConnection(server.db, task, credentialIntent)).toBeNull();
      const resumedRequest = await f.request("POST", setupPath, { action: "reconnect", credentials: { signingSecret: "agent-chosen-webhook-key" } }, f.jwt);
      expect(resumedRequest.body.interactionId).toBe(credentialIntentId);
      expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, credentialIntentId!)))[0].payload)
        .toMatchObject({ savedSetup: { credentialEntry: entryProof } });
      await healthy();
      expect(await findSatisfiedToolConnection(server.db, task, credentialIntent)).toBeNull();
      const [repaired] = await server.db.select().from(chatEndpoints).where(eq(chatEndpoints.id, created.body.id));
      await server.db.update(chatEndpoints).set({ setup: { ...repaired.setup, webhookVerifiedAt: new Date().toISOString() } }).where(eq(chatEndpoints.id, created.body.id));
      expect((await findSatisfiedToolConnection(server.db, task, credentialIntent))?.id).toBe(created.body.connectionId);
      expect(await findSatisfiedToolConnection(server.db, { ...task, status: "cancelled" }, credentialIntent)).toBeNull();
      await accessService(server.db).ensureMembership(f.companyId, "user", f.userId, "operator", "suspended");
      expect(await findSatisfiedToolConnection(server.db, task, credentialIntent)).toBeNull();
      await accessService(server.db).ensureMembership(f.companyId, "user", f.userId, "operator", "active");
      await satisfiedConnectionIntentService(server.db).sweepPending();
      expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, credentialIntentId!)))[0].status).toBe("expired");
      // Replacing complete credentials repairs unavailable old vault material.
      for (const state of ["disabled", "deleted", "unreadable"] as const) {
        const [connection] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
        const signing = connection.credentialSecretRefs.find(ref => ref.configPath === "credentials.signingSecret")!;
        if (state === "unreadable") {
          await server.db.update(companySecrets).set({ status: "active" }).where(eq(companySecrets.id, signing.secretId));
          await server.db.update(companySecretVersions).set({ material: {} }).where(eq(companySecretVersions.secretId, signing.secretId));
        } else {
          await server.db.update(companySecrets).set({ status: state }).where(eq(companySecrets.id, signing.secretId));
        }
        const response = await fetch(server.apiUrl + "/api" + setupPath, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reconnect", credentials: { signingSecret: `human-repair-${state}`, botToken: "xoxb-fixture-token" } }) });
        expect.soft({ status: response.status, body: await response.json() }, `repair ${state} signing secret`).toMatchObject({ status: 200 });
        if (response.status === 200) {
          const [current] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
          const replacement = current.credentialSecretRefs.find(ref => ref.configPath === "credentials.signingSecret")!;
          expect(replacement.secretId).not.toBe(signing.secretId);
          expect(await secretService(server.db).resolveSecretValue(f.companyId, replacement.secretId, "latest", {
            accessContext: { consumerType: "system", consumerId: "integration-fixture", actorType: "system" },
          })).toBe(`human-repair-${state}`);
        }
      }
      // Unexpected resolver failures must abort before writing new references.
      const [beforeFault] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      const resolverFault = vi.spyOn(localEncryptedProvider, "resolveVersion").mockRejectedValue(new Error("Unexpected secret resolution failure"));
      try {
        const response = await fetch(server.apiUrl + "/api" + setupPath, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reconnect", credentials: { signingSecret: "human-repair-unexpected", botToken: "xoxb-fixture-token" } }) });
        expect(response.status).toBe(500);
        expect((await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId)))[0].credentialSecretRefs).toEqual(beforeFault.credentialSecretRefs);
      } finally { resolverFault.mockRestore(); }
      // Identity is a provider fixture; production HTTP admission and policy remain real.
      const [principal] = await server.db.insert(chatExternalPrincipals).values({ companyId: f.companyId, provider: "slack", providerAccountId: "TFIXTURE", externalId: "UHUMAN", isBot: false }).returning();
      await server.db.insert(chatIdentityLinks).values({ companyId: f.companyId, endpointId: created.body.id, principalId: principal.id, paperclipUserId: f.userId, status: "linked", confirmedAt: new Date() });
      await server.db.update(chatEndpoints).set({ status: "active", allowDirectMessages: true }).where(eq(chatEndpoints.id, created.body.id));
      const [deny] = await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Test messages off", policyType: "block", selectors: { connectionId: created.body.connectionId }, priority: 1 }).returning();
      const testPath = `/chat-endpoints/${created.body.id}/slack/test-message`;
      const denied = await f.request("POST", testPath, { requestId: randomUUID() });
      expect(denied, JSON.stringify(denied)).toMatchObject({ status: 403 });
      expect(sent).toBe(0);
      await server.db.update(toolPolicies).set({ policyType: "allow" }).where(eq(toolPolicies.id, deny.id));
      vi.useFakeTimers({ toFake: ["Date"] });
      await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "One Slack setup send", policyType: "rate_limit", selectors: { connectionId: created.body.connectionId }, priority: 0, config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] } });
      const requestId = randomUUID();
      const tested = await f.request("POST", testPath, { requestId });
      expect(tested, JSON.stringify(tested)).toMatchObject({ status: 200, body: { status: "sent" } });
      expect(await f.request("POST", testPath, { requestId })).toMatchObject({ status: 200 });
      expect(await f.request("POST", testPath, { requestId: randomUUID() })).toMatchObject({ status: 403, body: { details: { reasonCode: "rate_limited" } } });
      expect(await f.request("POST", testPath, { requestId: randomUUID(), slackUserId: "UOTHER" })).toMatchObject({ status: 403 });
      expect(sent).toBe(1);
      vi.useRealTimers();
      const [beforeRevocation] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      revokeDuringAuth = true;
      expect(await f.request("POST", setupPath, { action: "reconnect", credentials: { botToken: "xoxb-fixture-token" } }, f.jwt)).toMatchObject({ status: 403 });
      expect((await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId)))[0].credentialSecretRefs)
        .toEqual(beforeRevocation.credentialSecretRefs);
    } finally { vi.useRealTimers(); provider = null; }
  });

  it.each(["linked", "invitation"] as const)("checks caller and target policy for delegated Slack %s sends", async recipient => {
    for (const mode of ["caller-block", "caller-ask", "caller-rate", "target-block", "target-rate", "shared-rate"] as const) {
      const f = await fixture();
      const cookie = await server.humanSession(f.userId);
      const targetResponse = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/agents`, {
        method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Slack target", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" },
          permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }),
      });
      const target = await targetResponse.json();
      expect(targetResponse.status, JSON.stringify(target)).toBe(201);
      await lifecycle.process(target.id);
      await vi.waitFor(async () => expect((await agentService(server.db).getById(target.id))?.status).toBe("idle"));
      let sends = 0;
      const workspaceId = `T${f.companyId.replaceAll("-", "").toUpperCase()}`;
      const scopes = [...SLACK_CHAT_BOT_SCOPES, ...SLACK_BOT_TOOL_SCOPES];
      provider = async (url, init) => {
        if (url.endsWith("auth.test")) return Response.json({ ok: true, team_id: workspaceId, team: "Delegated fixture", user_id: `U${target.id.replaceAll("-", "").toUpperCase()}`, user: "fixture-bot" }, { headers: { "x-oauth-scopes": scopes.join(",") } });
        if (url.includes("conversations.list")) return Response.json({ ok: true, channels: [], response_metadata: { next_cursor: "" } });
        if (url.endsWith("users.info")) return Response.json({ ok: true, user: { id: new URLSearchParams(String(init?.body)).get("user"), team_id: workspaceId, name: "Fixture user", is_bot: false, deleted: false } });
        if (url.endsWith("chat.postMessage")) { sends++; return Response.json({ ok: true, channel: "DTEST", ts: "1.000001" }); }
        if (url.endsWith("agents.sessions.setStatus")) return Response.json({ ok: true });
        throw new Error(`Unexpected Slack fixture operation: ${new URL(url).pathname}`);
      };
      try {
        const created = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "slack", assignedAgentId: target.id, slackSetupMethod: "manual" });
        expect(created, JSON.stringify(created)).toMatchObject({ status: 201 });
        const configured = await fetch(`${server.apiUrl}/api/chat-endpoints/${created.body.id}/setup`, {
          method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "configure", credentials: { botToken: `xoxb-${target.id}`, signingSecret: "fixture-signing-secret" } }),
        });
        expect({ status: configured.status, body: await configured.json() }).toMatchObject({ status: 200 });
        await server.db.update(chatEndpoints).set({ status: "active", allowDirectMessages: true }).where(eq(chatEndpoints.id, created.body.id));
        await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
        if (recipient === "linked") {
          const [principal] = await server.db.insert(chatExternalPrincipals).values({ companyId: f.companyId, provider: "slack", providerAccountId: workspaceId, externalId: "UHUMAN", isBot: false }).returning();
          await server.db.insert(chatIdentityLinks).values({ companyId: f.companyId, endpointId: created.body.id, principalId: principal.id, paperclipUserId: f.userId, status: "linked", confirmedAt: new Date() });
        }
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Slack fixture access", policyType: "allow", selectors: { connectionId: created.body.connectionId }, priority: 2 });
        const rate = mode.endsWith("rate");
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: mode, policyType: rate ? "rate_limit" : mode === "caller-ask" ? "require_approval" : "block",
          selectors: { connectionId: created.body.connectionId, ...(mode === "shared-rate" ? {} : { agentId: mode.startsWith("caller") ? f.agentId : target.id }) }, priority: 0,
          ...(rate ? { config: { limit: 1, windowSeconds: 60, keyBy: mode === "shared-rate" ? ["company", "tool"] : ["agent", "tool"] } } : {}),
        });
        const path = `/chat-endpoints/${created.body.id}/slack/test-message`;
        if (rate) {
          // Keep both calls in one rate window even when CI crosses a minute boundary.
          vi.useFakeTimers({ toFake: ["Date"] });
          // Shared buckets admit one actual send, while each principal's own
          // limit also prevents the next send. Neither may consume twice.
          expect(await f.request("POST", path, { requestId: randomUUID(), slackUserId: "UHUMAN" }, f.jwt), mode)
            .toMatchObject({ status: 200, body: { status: recipient === "linked" ? "sent" : "connection_pending" } });
          expect(sends, mode).toBe(1);
        }
        for (const token of [f.key.token, f.jwt]) {
          const denied = await f.request("POST", path, { requestId: randomUUID(), slackUserId: "UHUMAN" }, token);
          expect(denied, `${mode}: ${JSON.stringify(denied)}`).toMatchObject({ status: 403, body: { details: { reasonCode: rate ? "rate_limited" : mode === "caller-ask" ? "requires_approval_policy" : "deny_policy_block" } } });
          if (mode === "caller-ask") expect(denied.body.details.requiredUserAction).toMatchObject({ kind: "approve" });
        }
        expect(sends, mode).toBe(rate ? 1 : 0);
        const audit = await server.db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.companyId));
        expect(audit.some(event => event.details.agentId === f.agentId && event.actorId === f.agentId), mode).toBe(true);
      } finally { vi.useRealTimers(); provider = null; }
    }
  }, 90_000);

  it("imports a GitHub App and discovers repositories against provider fixtures", async () => {
    const f = await fixture();
    const permissions = { contents: "read", issues: "write", metadata: "read", pull_requests: "write" };
    const appId = 100000 + Number.parseInt(f.agentId.slice(0, 6), 16);
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    provider = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/login/oauth/access_token") return Response.json({ access_token: "fixture-personal-token" });
      if (path === "/user") return Response.json({ id: 1357, login: "fixture-person" });
      if (path === "/user/installations") return Response.json({ installations: [{ id: 2468, app_id: appId }] });
      if (path === "/app") return Response.json({ id: appId, slug: `fixture-${f.agentId.slice(0, 8)}`, name: "Fixture App", owner: { login: "fixture" }, permissions,
        events: ["pull_request", "github_app_authorization", "installation", "installation_repositories", "issue_comment", "pull_request_review_comment"] });
      if (path === "/app/hook/config") return Response.json(init?.body ? JSON.parse(String(init.body)) : { url: "https://paperclip.fixture.invalid", content_type: "json", insecure_ssl: "0" });
      if (path === "/app/installations") return Response.json([{ id: 2468, account: { id: 1357, login: "fixture", type: "Organization" }, permissions, suspended_at: null }]);
      if (path === "/app/installations/2468") return Response.json({ permissions, suspended_at: null });
      if (path === "/app/installations/2468/access_tokens") return Response.json({ token: "fixture-installation-token" }, { status: 201 });
      if (path === "/installation/repositories") return Response.json({ repositories: [{ id: 42, name: "repo", full_name: "fixture/repo", private: true, owner: { login: "fixture" }, html_url: "https://github.com/fixture/repo" }] });
      throw new Error(`Unexpected GitHub fixture operation: ${path}`);
    };
    try {
      const created = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "github", assignedAgentId: f.agentId });
      expect(await f.request("POST", `/chat-endpoints/${created.body.id}/github/registration`, { name: `fixture-${f.agentId.slice(0, 8)}` })).toMatchObject({ status: 200 });
      const cookie = await server.humanSession(f.userId);
      const humanRequest = (path: string, method = "GET", body?: unknown, session = cookie) => fetch(server.apiUrl + path, {
        method, redirect: "manual", headers: { cookie: session, "Content-Type": "application/json", origin: server.apiUrl },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const appCredentials = { appId: String(appId), privateKey, webhookSecret: "fixture-webhook-secret", clientId: "fixture-client", clientSecret: "fixture-secret" };
      expect(await f.request("POST", `/chat-endpoints/${created.body.id}/github/app`, appCredentials)).toMatchObject({ status: 200, body: { status: "needs_user_action" } });
      const importHandoff = await f.request("POST", `/chat-endpoints/${created.body.id}/github/app`, {}, f.jwt);
      expect(importHandoff).toMatchObject({ status: 200, body: { requiredUserAction: { kind: "enter_credentials", userId: f.userId } } });
      expect.soft(importHandoff.body.requiredUserAction.setupPath).toContain("stage=credentials");
      expect.soft(importHandoff.body.requiredUserAction.setupPath).not.toContain("reconnect=1");
      const privateKeyHandoff = await f.request("POST", `/chat-endpoints/${created.body.id}/setup`, { action: "configure", credentials: { privateKey } }, f.jwt);
      expect.soft(privateKeyHandoff, JSON.stringify(privateKeyHandoff)).toMatchObject({ status: 200, body: { requiredUserAction: { kind: "enter_credentials" } } });
      if (privateKeyHandoff.status === 200) {
        const entryLink = new URL(privateKeyHandoff.body.requiredUserAction.setupPath, server.apiUrl);
        expect.soft(entryLink.searchParams.get("credentialFields")).toBe("privateKey");
        expect.soft(entryLink.searchParams.get("credentialMode")).toBe("all");
        expect(privateKeyHandoff.body.interactionId).not.toBe(importHandoff.body.interactionId);
        const retry = await f.request("POST", `/chat-endpoints/${created.body.id}/setup`, { action: "configure", credentials: { privateKey } }, f.jwt);
        expect(retry.body.interactionId).toBe(privateKeyHandoff.body.interactionId);
      }
      expect((await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId)))[0].credentialSecretRefs).toEqual([]);
      const imported = await humanRequest(`/api/chat-endpoints/${created.body.id}/github/app`, "POST", appCredentials);
      expect(imported.status).toBe(200);
      expect(JSON.stringify(await imported.json())).not.toContain("PRIVATE KEY");
      const refreshed = await f.request("POST", `/chat-endpoints/${created.body.id}/github/repositories/refresh`, {});
      expect(refreshed, JSON.stringify(refreshed)).toMatchObject({ status: 200 });
      expect(JSON.stringify(refreshed.body)).toContain("fixture/repo");
      expect(await f.request("POST", `/chat-endpoints/${created.body.id}/github/verify`, {})).toMatchObject({ status: 200 });
      await server.db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, created.body.id));
      await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
      const identityHandoff = await f.request("POST", `/chat-endpoints/${created.body.id}/github/identity/start`, {}, f.jwt);
      expect(identityHandoff).toMatchObject({ status: 200, body: { requiredUserAction: { kind: "confirm_identity" } } });
      const [identityIntent] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, identityHandoff.body.interactionId));
      const [identityTask] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(await findSatisfiedToolConnection(server.db, identityTask, identityIntent)).toBeNull();
      const start = await humanRequest(`/api/chat-endpoints/${created.body.id}/github/identity/start`, "POST", {});
      const started = await start.json();
      expect(started, JSON.stringify(started)).toHaveProperty("authorizationUrl");
      const state = new URL(started.authorizationUrl).searchParams.get("state")!;
      const callback = `/api/chat-github/identity/callback?state=${encodeURIComponent(state)}&code=fixture-code`;
      const other = await fixture();
      const otherCookie = await server.humanSession(other.userId);
      expect((await humanRequest(callback, "GET", undefined, otherCookie)).status).toBe(403);
      expect((await humanRequest(callback)).status).toBe(303);
      expect((await humanRequest(callback)).status).toBe(403);
      expect(await findSatisfiedToolConnection(server.db, identityTask, identityIntent)).toBeNull();
      const confirmed = await humanRequest(`/api/chat-endpoints/${created.body.id}/github/identity/confirm`, "POST", { githubUserId: "1357" });
      expect(confirmed.status, JSON.stringify(await confirmed.json())).toBe(200);
      const [endpoint] = await server.db.select().from(chatEndpoints).where(eq(chatEndpoints.id, created.body.id));
      await server.db.update(chatEndpoints).set({ status: "active", setup: { ...endpoint.setup, webhookVerifiedAt: new Date().toISOString() } }).where(eq(chatEndpoints.id, endpoint.id));
      await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
      expect((await findSatisfiedToolConnection(server.db, identityTask, identityIntent))?.id).toBe(created.body.connectionId);
      const credentialHandoff = await f.request("POST", `/chat-endpoints/${created.body.id}/setup`, { action: "reconnect", credentials: { webhookSecret: "agent-chosen-key" } }, f.jwt);
      expect(credentialHandoff).toMatchObject({ status: 200, body: { requiredUserAction: { kind: "enter_credentials" } } });
      const entryLink = new URL(credentialHandoff.body.requiredUserAction.setupPath, server.apiUrl);
      expect(entryLink.searchParams.get("reconnect")).toBe("1");
      expect.soft(entryLink.searchParams.get("credentialFields")).toBe("webhookSecret");
      expect.soft(entryLink.searchParams.get("credentialMode")).toBe("all");
      const entryOptionsResponse = await humanRequest(`/api/connection-intents/${credentialHandoff.body.interactionId}/setup-options`);
      const entryOptions = await entryOptionsResponse.json();
      expect.soft(entryOptions.chatSetup.path).toBe(credentialHandoff.body.requiredUserAction.setupPath);
      const [entryIntent] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, credentialHandoff.body.interactionId));
      const [entryTask] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(await findSatisfiedToolConnection(server.db, entryTask, entryIntent)).toBeNull();
      const repairedResponse = await humanRequest(`/api/chat-endpoints/${created.body.id}/setup`, "POST", { action: "reconnect", credentials: { webhookSecret: "human-replacement-webhook" } });
      expect(repairedResponse.status).toBe(200);
      const [repairedConnection] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      for (const [field, value] of [["privateKey", privateKey], ["clientSecret", "fixture-secret"], ["webhookSecret", "human-replacement-webhook"]]) {
        const ref = repairedConnection.credentialSecretRefs.find(ref => ref.configPath === `credentials.${field}`)!;
        expect(await secretService(server.db).resolveSecretValue(f.companyId, ref.secretId, "latest", {
          accessContext: { consumerType: "system", consumerId: "integration-fixture", actorType: "system" },
        })).toBe(value);
      }
      expect(await findSatisfiedToolConnection(server.db, entryTask, entryIntent)).toBeNull();
      const [repairedEndpoint] = await server.db.select().from(chatEndpoints).where(eq(chatEndpoints.id, created.body.id));
      expect(repairedEndpoint.setup.webhookVerifiedAt).toBeNull();
      await server.db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, created.body.id));
      await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
      expect(await findSatisfiedToolConnection(server.db, entryTask, entryIntent)).toBeNull();
      await server.db.update(chatEndpoints).set({ setup: { ...repairedEndpoint.setup, webhookVerifiedAt: new Date().toISOString() } }).where(eq(chatEndpoints.id, created.body.id));
      expect((await findSatisfiedToolConnection(server.db, entryTask, entryIntent))?.id).toBe(created.body.connectionId);
      const [beforeRotation] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      let rotationIntentId = "";
      for (const token of [f.key.token, f.jwt, f.jwt]) {
        const rotation = await f.request("POST", `/chat-endpoints/${created.body.id}/setup-secret`, {}, token);
        expect(rotation, JSON.stringify(rotation)).toMatchObject({ status: 200, body: { status: "needs_user_action", endpointId: created.body.id,
          requiredUserAction: { kind: "enter_credentials", userId: f.userId } } });
        expect(rotation.body).not.toHaveProperty("webhookSecret");
        expect(rotation.body.requiredUserAction.setupPath).toContain("stage=credentials&reconnect=1&rotateSecret=1");
        if (token === f.jwt) {
          if (rotationIntentId) expect(rotation.body.interactionId).toBe(rotationIntentId);
          rotationIntentId = rotation.body.interactionId;
        }
      }
      expect(rotationIntentId).not.toBe(importHandoff.body.interactionId);
      const [afterRotation] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      expect(afterRotation.credentialSecretRefs).toEqual(beforeRotation.credentialSecretRefs);
      const [rotationIntent] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, rotationIntentId));
      const [task] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
      const setupOptions = await humanRequest(`/api/connection-intents/${rotationIntentId}/setup-options`);
      expect(setupOptions.status).toBe(200);
      expect((await setupOptions.json()).chatSetup.path).toContain("stage=credentials&reconnect=1&rotateSecret=1");
      expect(await findSatisfiedToolConnection(server.db, task, rotationIntent)).toBeNull();
      await satisfiedConnectionIntentService(server.db).sweepPending();
      expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, rotationIntentId)))[0].status).toBe("pending");
      const humanRotation = await humanRequest(`/api/chat-endpoints/${created.body.id}/setup-secret`, "POST", {});
      expect(humanRotation.status).toBe(201);
      const generatedRotation = await humanRotation.json();
      expect(generatedRotation).toMatchObject({ webhookSecret: expect.stringMatching(/^[a-f0-9]{64}$/), credentialRotationId: expect.any(String) });
      const [humanRotated] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      expect(humanRotated.credentialSecretRefs).not.toEqual(beforeRotation.credentialSecretRefs);
      const rotationState = await f.request("GET", `/chat-endpoints/${endpoint.id}`);
      expect(rotationState.body.setup).toMatchObject({ credentialRotationId: expect.any(String), webhookVerifiedAt: null });
      expect(rotationState.body.setup.credentialRotationId).toBe(generatedRotation.credentialRotationId);
      const nextRotation = await f.request("POST", `/chat-endpoints/${endpoint.id}/setup-secret`, {});
      expect(nextRotation.body.requiredUserAction.setupPath).toContain(`afterRotationId=${rotationState.body.setup.credentialRotationId}`);
      expect(await findSatisfiedToolConnection(server.db, task, rotationIntent)).toBeNull();
      // Provider-fixture states separate restored health from new webhook verification.
      const [rotatedEndpoint] = await server.db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id));
      await server.db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, endpoint.id));
      await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
      expect(await findSatisfiedToolConnection(server.db, task, rotationIntent)).toBeNull();
      await server.db.update(chatEndpoints).set({ setup: { ...rotatedEndpoint.setup, webhookVerifiedAt: new Date().toISOString() } }).where(eq(chatEndpoints.id, endpoint.id));
      expect((await findSatisfiedToolConnection(server.db, task, rotationIntent))?.id).toBe(created.body.connectionId);
    } finally { provider = null; }
  });

  it("creates an email account through the API without exposing its write-only credential and reuses retries", async () => {
    const f = await fixture();
    provider = async url => {
      if (new URL(url).pathname === "/v0/auth/me") return Response.json({ scope_type: "organization", organization_id: "fixture-org" });
      throw new Error(`Unexpected AgentMail fixture operation: ${new URL(url).pathname}`);
    };
    try {
      const body = { apiKey: "fixture-agentmail-secret", grantKind: "user", agentIds: [f.agentId], allAgents: false, idempotencyKey: randomUUID() };
      const created = await f.request("POST", `/companies/${f.companyId}/email/connections`, body);
      expect(created, JSON.stringify(created)).toMatchObject({ status: 201 });
      expect(JSON.stringify(created.body)).not.toContain(body.apiKey);
      expect(await f.request("POST", `/companies/${f.companyId}/email/connections`, body)).toMatchObject({ status: 201, body: { id: created.body.id } });
      expect((await f.request("GET", `/companies/${f.companyId}/email/connections`)).body).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.body.id })]));
      const [saved] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.id));
      expect(saved.createdByUserId).toBe(f.userId);
      const other = await f.request("POST", `/companies/${f.companyId}/email/connections`, { ...body, apiKey: "other-agentmail-secret", grantKind: "organization", idempotencyKey: randomUUID() });
      expect(other).toMatchObject({ status: 201 });
      await server.db.update(principalPermissionGrants).set({ scope: { connectionIds: [created.body.id] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
      for (const token of [f.key.token, f.jwt]) {
        const listed = await f.request("GET", `/companies/${f.companyId}/email/connections?connectionId=${created.body.id}`, undefined, token);
        expect(listed, JSON.stringify(listed)).toMatchObject({ status: 200 });
        expect(listed.body.map((account: { id: string }) => account.id)).toEqual([created.body.id]);
      }
    } finally { provider = null; }
  });

  it("shares tool-activity authorization by task and reuses run identity within one page", async () => {
    const f = await fixture();
    const connection = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Activity page", transport: "mcp_remote", authKind: "none", transportConfig: { url: "https://1.1.1.1/mcp" } });
    expect(connection).toMatchObject({ status: 201 });
    const [hidden] = await server.db.insert(issues).values({ companyId: f.companyId, title: "Private activity task", visibility: "private", status: "in_progress", responsibleUserId: randomUUID() }).returning();
    await server.db.insert(toolCallEvents).values(Array.from({ length: 100 }, (_, index) => ({ companyId: f.companyId, connectionId: connection.body.id,
      eventType: "policy_decision" as const, actorType: "agent", actorId: f.agentId, issueId: index % 2 ? f.issueId : hidden.id, toolName: index % 2 ? "visible" : "private_activity" })));
    const original = connectionManagementModule.connectionManagementService;
    const checked: string[] = [];
    const authorization = vi.spyOn(connectionManagementModule, "connectionManagementService").mockImplementation((db) => {
      const service = original(db);
      return { ...service, capability: async (...args: Parameters<typeof service.capability>) => {
        if (args[1] === "connections:audit") checked.push(args[2].issueId ?? "unbound");
        return service.capability(...args);
      } };
    });
    const capture = vi.spyOn(runIdentity, "captureRunIdentity");
    try {
      const path = `/tool-connections/${connection.body.id}/activity?limit=100`;
      const result = await f.request("GET", path, undefined, f.jwt);
      expect(result, JSON.stringify(result)).toMatchObject({ status: 200 });
      expect(result.body.events).toHaveLength(50);
      expect(JSON.stringify(result.body)).not.toContain("private_activity");
      expect(checked, JSON.stringify({ checks: checked.length, captures: capture.mock.calls.length })).toHaveLength(2);
      expect(capture.mock.calls.length).toBeGreaterThan(0);
      expect(capture.mock.calls.length).toBeLessThanOrEqual(2);
      await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:view_audit")));
      expect(await f.request("GET", path, undefined, f.jwt)).toMatchObject({ status: 403 });
    } finally { authorization.mockRestore(); capture.mockRestore(); }
  });

  it("bounds activity authorization to the requested page rather than endpoint history", async () => {
    const f = await fixture();
    const endpoint = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "github", assignedAgentId: f.agentId });
    expect(endpoint).toMatchObject({ status: 201 });
    const conversations = await server.db.insert(chatConversations).values(Array.from({ length: 200 }, (_, index) => ({
      companyId: f.companyId, endpointId: endpoint.body.id, issueId: f.issueId,
      externalConversationId: `history-${index}`, externalLabel: `History ${index}`,
    }))).returning();
    const [delivery] = await server.db.insert(chatDeliveries).values({ companyId: f.companyId, endpointId: endpoint.body.id,
      conversationId: conversations[0].id, providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "mention", state: "processed", normalizedEvent: {} }).returning();
    const original = connectionManagementModule.connectionManagementService;
    const checked: string[] = [];
    const authorization = vi.spyOn(connectionManagementModule, "connectionManagementService").mockImplementation((db) => {
      const service = original(db);
      return { ...service, capability: async (...args: Parameters<typeof service.capability>) => {
        if (args[1] === "connections:audit") checked.push(args[2].issueId ?? "unbound");
        return service.capability(...args);
      } };
    });
    try {
      const result = await f.request("GET", `/chat-endpoints/${endpoint.body.id}/activity?limit=1`, undefined, f.jwt);
      expect(result, JSON.stringify(result)).toMatchObject({ status: 200, body: { items: [expect.objectContaining({ id: delivery.id })] } });
      expect(checked).toEqual([f.issueId]);
    } finally { authorization.mockRestore(); }
  });

  it("continues activity pagination through private-only windows", async () => {
    const f = await fixture();
    const endpoint = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "github", assignedAgentId: f.agentId });
    const [hidden] = await server.db.insert(issues).values({ companyId: f.companyId, title: "Private history", visibility: "private", status: "in_progress", responsibleUserId: randomUUID() }).returning();
    const conversations = await server.db.insert(chatConversations).values([f.issueId, hidden.id].map(issueId => ({ companyId: f.companyId, endpointId: endpoint.body.id, issueId,
      externalConversationId: randomUUID(), externalLabel: "History" }))).returning();
    const rows = Array.from({ length: 30 }, (_, index) => ({ id: `${f.agentId.slice(0, 24)}${index.toString(16).padStart(12, "0")}`,
      companyId: f.companyId, endpointId: endpoint.body.id, conversationId: conversations[index < 3 ? 0 : 1].id,
      providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "message" as const, state: "processed" as const, redactedError: index < 3 ? null : "private_history", normalizedEvent: {}, createdAt: new Date("2026-10-25T12:00:00.000Z") }));
    await server.db.insert(chatDeliveries).values(rows);
    const path = `/chat-endpoints/${endpoint.body.id}/activity?limit=25`;
    const first = await f.request("GET", path, undefined, f.jwt);
    expect(first).toMatchObject({ status: 200, body: { items: [], nextCursor: expect.any(String) } });
    expect(JSON.stringify(first.body)).not.toContain("private_history");
    const second = await f.request("GET", `${path}&cursor=${encodeURIComponent(first.body.nextCursor)}`, undefined, f.jwt);
    expect(second).toMatchObject({ status: 200, body: { items: rows.slice(0, 3).reverse().map(row => expect.objectContaining({ id: row.id })), nextCursor: null } });
    expect(JSON.stringify(second.body)).not.toContain("private_history");
  });

  it("saves delegated Arcade discovery for the responsible user and shares its inventory with that user", async () => {
    const f = await fixture();
    const transport = vi.spyOn(remoteHttpFetch, "guardedRemoteHttpFetch").mockImplementation(async (url, init) => provider!(String(url), init));
    provider = async (url, init) => {
      const path = new URL(url).pathname;
      const rpc = init?.body ? JSON.parse(String(init.body)) : null;
      if (rpc?.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
      if (rpc?.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc?.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "Notion.ListPages", inputSchema: { type: "object" } }] } });
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-arcade-discovery");
      if (path === "/v1/tools") return Response.json({ items: [{ qualified_name: "Notion.ListPages", toolkit: { name: "Notion" }, requirements: { met: true, authorization: { provider_id: "notion", token_status: "completed" } } }] });
      if (path === "/v1/admin/user_connections") return Response.json({ items: [{ id: "arcade-work", provider_id: "notion", user_id: "arcade-user", connection_status: "active" }] });
      throw new Error(`Unexpected Arcade fixture operation: ${path}`);
    };
    try {
      const created = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Arcade fixture", transport: "mcp_remote", authKind: "none", credentialPolicy: "shared", status: "active", enabled: true, config: { sourceTemplateKey: "arcade", url: "https://api.arcade.dev/mcp/test" } });
      expect(created, JSON.stringify(created)).toMatchObject({ status: 201 });
      const configured = await f.request("PUT", `/tool-connections/${created.body.id}/aggregator/discovery`, { apiKey: "fixture-arcade-discovery", userId: "arcade-user" }, f.jwt);
      expect(configured, JSON.stringify(configured)).toMatchObject({ status: 200 });
      const [saved] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.id));
      const discovery = saved.config.aggregatorDiscovery as Record<string, { secretId: string }>;
      expect(discovery[f.agentId]).toBeUndefined();
      expect(discovery[f.userId]).toMatchObject({ userId: "arcade-user", secretId: expect.any(String) });
      const [secret] = await server.db.select().from(companySecrets).where(eq(companySecrets.id, discovery[f.userId].secretId));
      expect(secret.ownerUserId).toBe(f.userId);
      const events = await server.db.select().from(activityLog).where(eq(activityLog.entityId, saved.id));
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ action: "tool_connection.account_sync_configured", actorType: "agent", actorId: f.agentId, responsibleUserId: f.userId })]));
      const cookie = await server.humanSession(f.userId);
      await vi.waitFor(async () => {
        const response = await fetch(`${server.apiUrl}/api/tool-connections/${saved.id}/aggregator/apps`, { headers: { cookie } });
        const result = await response.json();
        expect(result.discovery).toMatchObject({ availability: "available" });
        expect(result.apps).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "arcade", appSlug: "notion" })]));
      }, { timeout: 10_000 });
    } finally { transport.mockRestore(); provider = null; }
  });

  it("encrypts native local-login checks and replays without exposing device codes in receipts or assets", async () => {
    const f = await fixture();
    const priorHome = process.env.PAPERCLIP_HOME;
    vi.stubEnv("PAPERCLIP_HOME", join(server.root, "local-login-receipt"));
    const authorizationUrl = "https://fixture.invalid/device?private_handoff=disposable-login";
    const code = "DISPOSABLE-DEVICE-CODE";
    const browser = vi.spyOn(localBrowserLogin, "startLocalBrowserLogin").mockReturnValue({ authorizationUrl, code, abort: vi.fn() });
    const intent = { provider: "openai", method: "subscription", ownership: "personal", name: "Local receipt fixture", agentIds: [], allAgents: false };
    let sessionId: string | undefined;
    try {
      const started = await f.request("POST", `/companies/${f.companyId}/ai-connections/local/attempts`, intent, f.jwt);
      expect(started, JSON.stringify(started)).toMatchObject({ status: 201, body: { sessionId: expect.any(String) } });
      sessionId = started.body.sessionId;
      const call = { tool: "call_api", callId: "local-login-private-check", arguments: {
        operationId: "POST /api/companies/{companyId}/ai-connections/local/check", body: { ...intent, localSessionId: sessionId },
      } };
      const result = await f.authority.execute(call);
      expect(result).toMatchObject({ ok: true, status: 200, data: { status: "sign_in_required", authorizationUrl, code } });
      expect(result).not.toHaveProperty("artifact");
      expect(await f.authority.execute(call)).toEqual(result);
      const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const receipts = (run.resultJson as { apiToolReceipts: Record<string, { operationId: string }> }).apiToolReceipts;
      expect(Object.values(receipts).find(receipt => receipt.operationId === call.arguments.operationId)).toHaveProperty("encryptedResult");
      for (const secret of [authorizationUrl, code]) {
        expect(JSON.stringify(run.resultJson)).not.toContain(secret);
        expect(JSON.stringify(redactRunnerApiPayloads(result))).not.toContain(secret);
      }
      expect((await f.snapshot()).assets.filter(asset => asset.objectKey.includes("/runner-api/"))).toEqual([]);
    } finally {
      if (sessionId) await f.request("DELETE", `/companies/${f.companyId}/ai-connections/local/attempts/${sessionId}`, undefined, f.jwt);
      browser.mockRestore();
      if (priorHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = priorHome;
    }
  });

  // Tokens issued by agents before client-token minting became person-only
  // remain valid until revoked, so runtime enforcement still covers them.
});
