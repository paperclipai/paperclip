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
describe("connection management delegated test policy and approval continuation", () => {
  let server!: ConnectionManagementServer;
  let lifecycle!: ConnectionManagementLifecycle;
  let provider: ConnectionManagementProviderHandler | null = null;
  const harness = createConnectionManagementHarness(() => provider);
  beforeAll(() => {
    server = harness.server;
    lifecycle = harness.lifecycle;
  });
  const fixture = () => harness.fixture();

  it.each(["none", "other-agent", "other-agent-no-access", "other-agent-allow-policy", "other-agent-explicit-grant", "other-agent-caller-ask", "other-agent-new-rate", "other-agent-new-shared-rate", "other-agent-new-rate-target-block", "other-agent-caller-rate", "other-agent-shared-rate", "other-agent-credential", "other-agent-credential-none", "other-agent-caller-revoked", "private-status", "agent", "user", "cancelled", "project-block", "rate-limit", "agent-rate-approval", "authorized-policy-edit"] as const)("keeps delegated test policy and approval continuation bounded (%s)", async revocation => {
    const f = await fixture();
    let targetAgentId = f.agentId;
    if (revocation.startsWith("other-agent")) {
      const cookie = await server.humanSession(f.userId);
      const created = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/agents`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test target", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }) });
      const target = await created.json();
      expect(created.status, JSON.stringify(target)).toBe(201);
      targetAgentId = target.id;
      await lifecycle.process(targetAgentId);
      await vi.waitFor(async () => expect((await agentService(server.db).getById(targetAgentId))?.status).toBe("idle"));
    }
    const allowed = revocation === "none" || revocation === "other-agent" || revocation === "other-agent-caller-ask" || ["other-agent-new-rate", "other-agent-new-shared-rate"].includes(revocation);
    let calls = 0;
    const remote = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      let result: unknown;
      if (request.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Fixture", version: "1" } };
      else if (request.method === "tools/call") { calls++; result = { content: [{ type: "text", text: "Fixture result" }] }; }
      else { res.writeHead(req.method === "DELETE" ? 204 : request.method === "notifications/initialized" ? 202 : 405); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
    await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not listen");
    const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
    const freezeRateClock = revocation.startsWith("other-agent-new-") || ["other-agent-caller-rate", "other-agent-shared-rate", "rate-limit", "agent-rate-approval"].includes(revocation);
    if (freezeRateClock) vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const created = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Governed test", transport: "mcp_remote", authKind: "none", transportConfig: { url: mcpUrl } });
      await server.db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, created.body.id));
      const [entry] = await server.db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId: created.body.applicationId, connectionId: created.body.id,
        entryKind: "tool", name: "Fixture probe", toolName: "fixture_probe", inputSchema: { type: "object", properties: {} }, riskLevel: "read", isReadOnly: true, status: "active", versionHash: "fixture-v1" }).returning();
      expect(await f.request("POST", `/companies/${f.companyId}/tools/apps/${created.body.id}/finish`, { enabledCatalogEntryIds: [entry.id], access: { agentIds: revocation.startsWith("other-agent") && !["other-agent-no-access", "other-agent-allow-policy", "other-agent-explicit-grant"].includes(revocation) ? [f.agentId, targetAgentId] : [targetAgentId] } })).toMatchObject({ status: 200 });
      const path = `/tool-connections/${created.body.id}/test-calls`;
      const body = { agentId: targetAgentId, runContext: { heartbeatRunId: randomUUID(), issueId: randomUUID(), projectId: randomUUID() }, toolName: "fixture_probe", parameters: {} };
      if (revocation === "other-agent-no-access") {
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Caller cannot use this tool", policyType: "block", selectors: { connectionId: created.body.id, agentId: f.agentId }, priority: 0 });
        for (const token of [f.key.token, f.jwt]) expect(await f.request("POST", path, body, token)).toMatchObject({ status: 200, body: { decision: "off", error: { reasonCode: "deny_policy_block" } } });
        expect(calls).toBe(0);
        return;
      }
      if (revocation === "other-agent-allow-policy" || revocation === "other-agent-explicit-grant") {
        if (revocation === "other-agent-allow-policy") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Caller authorized by policy", policyType: "allow", selectors: { connectionId: created.body.id, agentId: f.agentId }, priority: 0 });
        else await server.db.update(principalPermissionGrants).set({ scope: { connectionId: created.body.id } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:use")));
        const result = await f.request("POST", path, body, f.jwt);
        expect(result, JSON.stringify(result)).toMatchObject({ status: 200, body: { decision: "allowed", result: { content: "Fixture result" } } });
        expect(calls).toBe(1);
        return;
      }
      if (revocation === "other-agent-credential" || revocation === "other-agent-credential-none") {
        await server.db.update(toolConnections).set({ authKind: revocation === "other-agent-credential-none" ? "none" : "api_key", credentialPolicy: "per_agent" }).where(eq(toolConnections.id, created.body.id));
        await server.db.insert(connectionGrants).values([f.agentId, targetAgentId].map(subjectAgentId => ({ companyId: f.companyId, connectionId: created.body.id, kind: "agent" as const, subjectAgentId, status: "active" as const })));
        expect(await f.request("POST", path, body, f.jwt)).toMatchObject({ status: 403, body: { reasonCode: "test_credential_identity_mismatch" } });
        expect(calls).toBe(0);
        return;
      }
      if (revocation === "other-agent-caller-rate" || revocation === "other-agent-shared-rate") {
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Caller rate", policyType: "rate_limit", selectors: { connectionId: created.body.id, ...(revocation === "other-agent-caller-rate" ? { agentId: f.agentId } : {}) }, config: { limit: 1, windowSeconds: 60, keyBy: revocation === "other-agent-caller-rate" ? ["agent", "tool"] : ["company", "tool"] } });
        const admitted = await f.request("POST", path, body, f.jwt);
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ status: 200, body: { decision: "allowed", result: { content: "Fixture result" } } });
        expect(calls).toBe(1);
        expect(await f.request("POST", path, body, f.jwt)).toMatchObject({ status: 200, body: { decision: "off", error: { reasonCode: "rate_limited" } } });
        expect(calls).toBe(1);
        return;
      }
      for (const selectors of [{ connectionId: created.body.id, projectId: f.projectId }, { connectionId: created.body.id, issueId: f.issueId }]) {
        const [block] = await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Scoped test block", policyType: "block", selectors, priority: 1 }).returning();
        expect(await f.request("POST", path, body, f.jwt)).toMatchObject({ status: 200, body: { decision: "off" } });
        expect(calls).toBe(0);
        await server.db.delete(toolPolicies).where(eq(toolPolicies.id, block.id));
      }
      if (revocation === "rate-limit") {
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "One test per minute", policyType: "rate_limit", selectors: { connectionId: created.body.id }, config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] } });
        expect(await f.request("POST", path, body, f.jwt)).toMatchObject({ status: 200, body: { decision: "allowed", result: { content: "Fixture result" } } });
        expect(calls).toBe(1);
        expect(await f.request("POST", path, body, f.jwt)).toMatchObject({ status: 200, body: { decision: "off", error: { reasonCode: "rate_limited" } } });
        expect(calls).toBe(1);
        return;
      }
      if (revocation === "agent-rate-approval") {
        await server.db.insert(toolPolicies).values([
          { companyId: f.companyId, name: "One admitted call", policyType: "rate_limit", selectors: { connectionId: created.body.id }, priority: 0, config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] } },
          { companyId: f.companyId, name: "Approve admitted call", policyType: "require_approval", selectors: { connectionId: created.body.id }, priority: 1 },
        ]);
        const session = await f.request("POST", "/tool-gateway/sessions", {}, f.jwt);
        expect(session, JSON.stringify(session)).toMatchObject({ status: 201 });
        const gatewayRequest = async (path: string, parameters?: unknown) => {
          const response = await fetch(server.apiUrl + "/api" + path, { method: parameters === undefined ? "GET" : "POST", headers: { "x-paperclip-tool-gateway-token": session.body.token, "Content-Type": "application/json" }, ...(parameters === undefined ? {} : { body: JSON.stringify(parameters) }) });
          return { status: response.status, body: await response.json() };
        };
        const listed = await gatewayRequest("/tool-gateway/tools");
        expect(listed).toMatchObject({ status: 200 });
        const tool = listed.body.find((item: { catalogEntryId: string }) => item.catalogEntryId === entry.id);
        expect(tool, JSON.stringify(listed.body)).toBeTruthy();
        const requested = await gatewayRequest("/tool-gateway/tools/call", { tool: tool.name, parameters: {}, idempotencyKey: "rate-approval" });
        expect(requested, JSON.stringify(requested)).toMatchObject({ status: 409, body: { reasonCode: "approval_required" } });
        expect(calls).toBe(0);
        expect(await f.request("POST", `/tool-gateway/action-requests/${requested.body.actionRequestId}/approve`, { companyId: f.companyId }, f.jwt)).toMatchObject({ status: 403 });
        const cookie = await server.humanSession(f.userId);
        const response = await fetch(`${server.apiUrl}/api/tool-gateway/action-requests/${requested.body.actionRequestId}/approve`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify({ companyId: f.companyId }) });
        expect(response.status, JSON.stringify(await response.json())).toBe(200);
        expect((await server.db.select().from(toolInvocations).where(eq(toolInvocations.id, requested.body.invocationId)))[0].status).toBe("succeeded");
        expect(calls).toBe(1);
        expect(await gatewayRequest("/tool-gateway/tools/call", { tool: tool.name, parameters: { anotherCall: true }, idempotencyKey: "next-rate-approval" })).toMatchObject({ status: 429, body: { reasonCode: "rate_limited" } });
        expect(calls).toBe(1);
        return;
      }
      await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Scoped test approval", policyType: "require_approval", selectors: { connectionId: created.body.id, issueId: f.issueId, ...(revocation === "other-agent-caller-ask" ? { agentId: f.agentId } : {}) }, priority: 1 });
      const pending = await f.request("POST", path, body, f.jwt);
      expect(pending, JSON.stringify(pending)).toMatchObject({ status: 200, body: { decision: "ask_first" } });
      const [saved] = await server.db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.body.invocationId));
      expect(saved).toMatchObject({ runId: f.runId, issueId: f.issueId, actorType: "agent", actorId: f.agentId, agentId: targetAgentId });
      expect(calls).toBe(0);
      if (revocation === "private-status") {
        const statusPath = `${path}/${pending.body.actionRequestId}`;
        expect(await f.request("GET", statusPath)).toMatchObject({ status: 200 });
        const [hidden] = await server.db.insert(issues).values({ companyId: f.companyId, title: "Private test task", visibility: "private", status: "in_progress", responsibleUserId: randomUUID() }).returning();
        await server.db.update(toolInvocations).set({ issueId: hidden.id }).where(eq(toolInvocations.id, saved.id));
        for (const token of [f.key.token, f.jwt]) expect(await f.request("GET", statusPath, undefined, token)).toMatchObject({ status: 403 });
        expect(calls).toBe(0);
        return;
      }
      const approvalPath = `/tool-gateway/action-requests/${pending.body.actionRequestId}/approve`;
      expect(await f.request("POST", approvalPath, { companyId: f.companyId }, f.jwt)).toMatchObject({ status: 403 });
      if (revocation === "authorized-policy-edit") {
        const policiesPath = `/companies/${f.companyId}/tools/policies`;
        const policy = await f.request("POST", policiesPath, { name: "Requested self-targeted access", policyType: "allow", priority: 0,
          selectors: { agentId: f.agentId, connectionId: created.body.id } }, f.jwt);
        expect(policy, JSON.stringify(policy)).toMatchObject({ status: 201 });
        expect(await f.request("POST", path, body, f.jwt)).toMatchObject({ status: 200, body: { decision: "allowed" } });
        expect(calls).toBe(1);
        expect(await f.request("POST", approvalPath, { companyId: f.companyId }, f.jwt)).toMatchObject({ status: 403 });
        await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_profiles")));
        expect(await f.request("PATCH", `${policiesPath}/${policy.body.id}`, { enabled: false }, f.jwt)).toMatchObject({ status: 403 });
        return;
      }
      await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
      if (revocation === "agent") await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:use")));
      if (revocation === "user") for (const permission of ["tools:use", "tools:manage_connections"]) await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, f.companyId), eq(principalPermissionGrants.principalId, f.userId), eq(principalPermissionGrants.permissionKey, permission)));
      if (revocation === "cancelled") await server.db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
      if (revocation === "other-agent-caller-revoked") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Caller access revoked", policyType: "block", selectors: { connectionId: created.body.id, agentId: f.agentId }, priority: 0 });
      if (revocation === "project-block") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New project block", policyType: "block", selectors: { connectionId: created.body.id, projectId: f.projectId }, priority: 0 });
      if (revocation.startsWith("other-agent-new-")) {
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New delegated test admission", policyType: "rate_limit",
          selectors: { connectionId: created.body.id, ...(revocation === "other-agent-new-shared-rate" ? {} : { agentId: f.agentId }) },
          priority: -2, config: { limit: 1, windowSeconds: 60, keyBy: revocation === "other-agent-new-shared-rate" ? ["company", "tool"] : ["agent", "tool"] } });
        if (revocation === "other-agent-new-rate") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New test target admission", policyType: "rate_limit",
          selectors: { connectionId: created.body.id, agentId: targetAgentId }, priority: -2,
          config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] } });
        if (revocation === "other-agent-new-rate-target-block") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New test target block", policyType: "block",
          selectors: { connectionId: created.body.id, agentId: targetAgentId }, priority: -1 });
      }
      const cookie = await server.humanSession(f.userId);
      const approve = () => fetch(server.apiUrl + "/api" + approvalPath, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify({ companyId: f.companyId }) });
      const response = await approve();
      expect(response.status, JSON.stringify(await response.json())).toBe(revocation === "cancelled" ? 409 : 200);
      const [settled] = await server.db.select().from(toolInvocations).where(eq(toolInvocations.id, saved.id));
      if (revocation === "cancelled") expect(settled.status).not.toBe("succeeded");
      else expect(settled, JSON.stringify(settled)).toMatchObject({ status: allowed ? "succeeded" : "failed" });
      expect(calls).toBe(allowed ? 1 : 0);
      if (allowed) { expect((await approve()).status).toBe(200); expect(calls).toBe(1); }
      if (revocation.startsWith("other-agent-new-")) {
        const counters = await server.db.select().from(toolRateLimitCounters).where(eq(toolRateLimitCounters.companyId, f.companyId));
        expect(counters).toHaveLength(allowed ? revocation === "other-agent-new-shared-rate" ? 1 : 2 : 0);
        expect(counters.every(counter => counter.remaining === 0)).toBe(true);
        if (allowed) {
          expect(settled.policyExplanation?.consumedRateAdmissions).toHaveLength(1);
          expect(settled.policyExplanation?.delegatedCallerConsumedRateAdmissions).toHaveLength(1);
          const [nextRun] = await server.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
            status: "running", responsibleUserId: f.userId, contextSnapshot: { issueId: f.issueId } }).returning();
          const nextJwt = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", nextRun.id, f.userId)!;
          expect(await f.request("POST", path, body, nextJwt)).toMatchObject({ status: 200, body: { decision: "off", error: { reasonCode: "rate_limited" } } });
          expect(calls).toBe(1);
        }
      }
    } finally { if (freezeRateClock) vi.useRealTimers(); remote.closeAllConnections(); await new Promise<void>((resolve, reject) => remote.close(error => error ? reject(error) : resolve())); }
  });

});
