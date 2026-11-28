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
describe("connection management gateway issuer and target rules", () => {
  let server!: ConnectionManagementServer;
  let lifecycle!: ConnectionManagementLifecycle;
  let provider: ConnectionManagementProviderHandler | null = null;
  const harness = createConnectionManagementHarness(() => provider);
  beforeAll(() => {
    server = harness.server;
    lifecycle = harness.lifecycle;
  });
  const fixture = () => harness.fixture();

  async function legacyAgentIssuedGatewayToken(f: Awaited<ReturnType<typeof fixture>>, gatewayId: string, name: string) {
    const id = randomUUID(), token = `pcgw_${id}.${randomBytes(32).toString("base64url")}`;
    const [row] = await server.db.insert(toolMcpGatewayTokens).values({ id, companyId: f.companyId, gatewayId, name, tokenHash: createHash("sha256").update(token).digest("hex"),
      tokenPrefix: `pcgw_${id.slice(0, 8)}`, subjectType: "gateway_client", clientLabel: "fixture", allowedActions: ["tools/list", "tools/call", "resources/list", "resources/read", "prompts/list", "prompts/get"],
      responsibleUserId: f.userId, createdByAgentId: f.agentId }).returning();
    return { status: 201, body: { ...row, token } };
  }

  it.each(["block", "ask", "ask-board", "ask-revoked", "ask-rate", "ask-new-rate", "ask-new-shared-rate", "ask-new-rate-target-block", "ask-token-revoked", "ask-token-deleted", "ask-token-scope", "ask-grant-revoked", "ask-one-connection", "ask-one-connection-recovery", "ask-one-connection-revoked", "rate", "shared-rate", "target-block", "credential"] as const)("intersects gateway issuer and target rules (%s)", async mode => {
    const f = await fixture();
    const cookie = await server.humanSession(f.userId);
    const createdTarget = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/agents`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Gateway target", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }) });
    const target = await createdTarget.json();
    expect(createdTarget.status).toBe(201);
    await lifecycle.process(target.id);
    await vi.waitFor(async () => expect((await agentService(server.db).getById(target.id))?.status).toBe("idle"));
    let calls = 0;
    const remote = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body || "{}");
      let result: unknown;
      if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Fixture", version: "1" } };
      else if (rpc.method === "tools/list") result = { tools: [{ name: "fixture_probe", inputSchema: { type: "object" } }] };
      else if (rpc.method === "tools/call") { calls++; result = { content: [{ type: "text", text: "Fixture gateway result" }] }; }
      else { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    try {
      const connection = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Gateway policy fixture", transport: "mcp_remote", authKind: "none", transportConfig: { url: `http://127.0.0.1:${address.port}/mcp` } });
      expect(connection.status).toBe(201);
      await server.db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, connection.body.id));
      const [entry] = await server.db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId: connection.body.applicationId, connectionId: connection.body.id,
        entryKind: "tool", name: "Fixture probe", toolName: "fixture_probe", inputSchema: { type: "object" }, riskLevel: "read", isReadOnly: true, status: "active", versionHash: "fixture-v1" }).returning();
      expect(await f.request("POST", `/companies/${f.companyId}/tools/apps/${connection.body.id}/finish`, { enabledCatalogEntryIds: [entry.id], access: { agentIds: [f.agentId, target.id] } })).toMatchObject({ status: 200 });
      const profile = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "gateway-rules", name: "Gateway rules", entries: [{ selectorType: "connection", connectionId: connection.body.id }] });
      const gateway = await f.request("POST", `/companies/${f.companyId}/tools/gateways`, { name: "Cross-agent gateway", slug: "cross-agent", profileId: profile.body.id, agentId: target.id, issueId: f.issueId, projectId: f.projectId });
      expect(gateway, JSON.stringify(gateway)).toMatchObject({ status: 201 });
      const tokenBody = { companyId: f.companyId, name: "Issuer client", clientLabel: "fixture" };
      const token = mode === "ask-board" ? await (async () => {
        const response = await fetch(`${server.apiUrl}/api/tool-gateway/gateways/${gateway.body.id}/tokens`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify(tokenBody) });
        return { status: response.status, body: await response.json() };
      })() : await legacyAgentIssuedGatewayToken(f, gateway.body.id, tokenBody.name);
      expect(token, JSON.stringify(token)).toMatchObject({ status: 201 });
      const path = `/mcp/gateways/${gateway.body.gatewayPublicId}`;
      const rpc = (method: string, params?: unknown) => f.request("POST", path, { jsonrpc: "2.0", id: randomUUID(), method, ...(params ? { params } : {}) }, token.body.token);
      const listed = await rpc("tools/list");
      const tool = listed.body.result?.tools?.find((tool: { name: string }) => tool.name.includes("fixture-probe"));
      expect(tool, JSON.stringify(listed)).toBeTruthy();
      vi.useFakeTimers({ toFake: ["Date"] });
      const isRate = mode === "rate" || mode === "shared-rate";
      await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Gateway caller control", policyType: isRate ? "rate_limit" : mode.startsWith("ask") ? "require_approval" : mode === "credential" ? "allow" : "block",
        selectors: { connectionId: connection.body.id, ...(mode === "shared-rate" ? {} : { agentId: mode === "target-block" || mode === "ask-board" ? target.id : f.agentId }) }, priority: 0,
        ...(isRate ? { config: { limit: 1, windowSeconds: 60, keyBy: mode === "shared-rate" ? ["company", "tool"] : ["agent", "tool"] } } : {}) });
      if (mode === "ask-rate") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "One issuer admission", policyType: "rate_limit", selectors: { connectionId: connection.body.id, agentId: f.agentId }, priority: -1, config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] } });
      if (mode === "credential") {
        await server.db.update(toolConnections).set({ credentialPolicy: "per_agent" }).where(eq(toolConnections.id, connection.body.id));
        await server.db.insert(connectionGrants).values([f.agentId, target.id].map(subjectAgentId => ({ companyId: f.companyId, connectionId: connection.body.id, kind: "agent" as const, subjectAgentId, status: "active" as const })));
      }
      const called = await rpc("tools/call", { name: tool.name, arguments: {} });
      if (isRate) {
        expect(calls, JSON.stringify(called)).toBe(1);
        await rpc("tools/call", { name: tool.name, arguments: { another: true } });
        expect(calls).toBe(1);
        return;
      }
      expect(calls, JSON.stringify(called)).toBe(0);
      if (mode === "credential") {
        expect(JSON.stringify(called.body)).toContain("gateway_credential_identity_mismatch");
        return;
      }
      const [invocation] = await server.db.select().from(toolInvocations).where(eq(toolInvocations.gatewayId, gateway.body.id));
      expect(invocation).toMatchObject({ gatewayTokenId: token.body.id, actorId: mode === "ask-board" ? token.body.id : f.agentId, agentId: target.id, policyDecision: mode.startsWith("ask") ? "require_approval" : "deny" });
      if (!mode.startsWith("ask")) return;
      const [action] = await server.db.select().from(toolActionRequests).where(eq(toolActionRequests.invocationId, invocation.id));
      expect(action.requestedByAgentId).toBe(mode === "ask-board" ? null : f.agentId);
      if (mode.startsWith("ask-new-")) {
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New admission after review", policyType: "rate_limit",
          selectors: { connectionId: connection.body.id, ...(mode === "ask-new-shared-rate" ? {} : { agentId: f.agentId }) },
          priority: -2, config: { limit: 1, windowSeconds: 60, keyBy: mode === "ask-new-shared-rate" ? ["company", "tool"] : ["agent", "tool"] } });
        if (mode === "ask-new-rate") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New target admission", policyType: "rate_limit",
          selectors: { connectionId: connection.body.id, agentId: target.id }, priority: -1,
          config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] } });
        if (mode === "ask-new-rate-target-block") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New target block", policyType: "block",
          selectors: { connectionId: connection.body.id, agentId: target.id }, priority: -1 });
      }
      if (mode === "ask-revoked") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Issuer blocked after review", policyType: "block", selectors: { connectionId: connection.body.id, agentId: f.agentId }, priority: -1 });
      if (mode === "ask-token-revoked") await server.db.update(toolMcpGatewayTokens).set({ revokedAt: new Date() }).where(eq(toolMcpGatewayTokens.id, token.body.id));
      if (mode === "ask-token-deleted") await server.db.delete(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, token.body.id));
      if (mode === "ask-token-scope") await server.db.update(toolMcpGatewayTokens).set({ allowedActions: ["tools/list"] }).where(eq(toolMcpGatewayTokens.id, token.body.id));
      if (mode === "ask-grant-revoked" || mode === "ask-one-connection-revoked") await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
      const approvalDenied = ["ask-revoked", "ask-new-rate-target-block", "ask-token-revoked", "ask-token-deleted", "ask-token-scope", "ask-grant-revoked", "ask-one-connection-revoked"].includes(mode);
      if (mode.startsWith("ask-one-connection")) {
        const limited = createDb(server.databaseUrl, { maxConnections: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
        const service = createToolGatewayService(limited);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let attempt: Promise<unknown> | undefined;
        try {
          if (mode === "ask-one-connection-recovery") await commitToolActionReview(server.db, {
            companyId: f.companyId, actionRequestId: action.id, decision: "approved", actor: { userId: f.userId },
          });
          attempt = mode === "ask-one-connection-recovery" ? service.recoverApprovedActionReviews(f.companyId)
            : service.approveActionRequest({ companyId: f.companyId, actionRequestId: action.id, actor: { userId: f.userId } });
          void attempt.catch(() => undefined);
          const completed = Promise.race([attempt, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Single-connection gateway approval did not settle")), 5000);
          })]);
          if (approvalDenied) await expect(completed).rejects.toMatchObject({ status: 403 });
          else await completed;
          expect((await limited.execute(sql`select 1 as available`))[0].available).toBe(1);
        } finally {
          clearTimeout(timer); await limited.$client.end({ timeout: 1 }); await attempt?.catch(() => undefined);
        }
      } else {
        const response = await fetch(`${server.apiUrl}/api/tool-gateway/action-requests/${action.id}/approve`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify({ companyId: f.companyId }) });
        expect(response.status, JSON.stringify(await response.json())).toBe(approvalDenied ? 403 : 200);
      }
      expect(calls).toBe(approvalDenied ? 0 : 1);
      if (mode.startsWith("ask-new-")) {
        const counters = await server.db.select().from(toolRateLimitCounters).where(eq(toolRateLimitCounters.companyId, f.companyId));
        expect(counters).toHaveLength(approvalDenied ? 0 : mode === "ask-new-shared-rate" ? 1 : 2);
        expect(counters.every(counter => counter.remaining === 0)).toBe(true);
        if (!approvalDenied) {
          const [settled] = await server.db.select().from(toolInvocations).where(eq(toolInvocations.id, invocation.id));
          expect(settled.policyExplanation?.consumedRateAdmissions).toHaveLength(1);
          expect(settled.policyExplanation?.delegatedCallerConsumedRateAdmissions).toHaveLength(1);
        }
      }
      if (["ask-rate", "ask-new-rate", "ask-new-shared-rate"].includes(mode)) {
        await rpc("tools/call", { name: tool.name, arguments: { another: true } });
        expect(calls).toBe(1);
      }
    } finally { vi.useRealTimers(); await new Promise<void>((resolve, reject) => remote.close(error => error ? reject(error) : resolve())); }
  });

});
