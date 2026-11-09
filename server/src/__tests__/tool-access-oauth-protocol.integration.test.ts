import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, approvals, companies, companyMemberships, createDb, connectionGrants, heartbeatRuns, issues, toolActionRequests, toolCatalogEntries, toolConnections, toolOauthStates, toolPolicies } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { toolAccessService } from "../services/tool-access.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { secretService } from "../services/secrets.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerToolReviewRecoveryWork } from "../services/tool-review-recovery-work.js";
import { writeToolConnectionHealthChange } from "../services/tool-connection-health-notifications.js";
import { readSignedToolArgumentsPayload } from "../services/tool-content-guards.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("tool OAuth over local HTTP", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let keyDir: string;

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "tool-oauth-protocol-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "http://127.0.0.1:3100");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_ID", "");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET", "");
    fixture = await startEmbeddedPostgresTestDatabase("tool-oauth-protocol-");
    db = createDb(fixture.connectionString);
  });

  afterAll(async () => {
    await fixture?.cleanup();
    vi.unstubAllEnvs();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  it.each([
    { authMethod: "none", grantKind: "organization", scopeMode: "omitted_initial" },
    { authMethod: "client_secret_basic", grantKind: "organization", scopeMode: "omitted_refresh" },
    { authMethod: "none", grantKind: "user", scopeMode: "omitted_initial" },
    { authMethod: "client_secret_basic", grantKind: "user", scopeMode: "explicit" },
  ] as const)("approves a $grantKind $authMethod OAuth action after refresh and delayed review ($scopeMode)", async ({ authMethod, grantKind, scopeMode }) => {
    const userId = `oauth-user-${randomUUID()}`;
    const [company] = await db.insert(companies).values({
      name: "OAuth protocol fixture", issuePrefix: `O${randomUUID().slice(0, 5)}`,
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId,
      status: "active", membershipRole: "admin",
    });
    const calls: Array<{ path: string; authorization?: string; body: string }> = [];
    let origin: string;
    let currentAccessToken = "fixture-access";
    let currentRefreshToken = "fixture-refresh";
    let rejectRefresh = false;
    const provider = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const path = new URL(req.url!, origin).pathname;
      calls.push({ path, authorization: req.headers.authorization, body });
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: origin, authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [authMethod],
          scopes_supported: ["tools.write", "offline_access"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        });
      }
      if (path === "/register") {
        return json({ ...JSON.parse(body), client_id: "fixture-client",
          ...(authMethod === "client_secret_basic" ? { client_secret: "fixture-secret" } : {}),
        });
      }
      if (path === "/token") {
        const refreshing = new URLSearchParams(body).get("grant_type") === "refresh_token";
        if (refreshing) {
          if (rejectRefresh) return json({ error: "invalid_grant" }, 400);
          if (new URLSearchParams(body).get("refresh_token") !== currentRefreshToken) {
            return json({ error: "invalid_grant" }, 400);
          }
          currentAccessToken = "fixture-access-rotated";
          currentRefreshToken = "fixture-refresh-rotated";
        }
        return json({ access_token: currentAccessToken, refresh_token: currentRefreshToken,
          expires_in: 3600, token_type: "Bearer",
          ...((scopeMode === "omitted_initial" && !refreshing) || (scopeMode === "omitted_refresh" && refreshing)
            ? {} : { scope: "tools.write offline_access" }) });
      }
      if (path === "/mcp") {
        if (req.headers.authorization !== `Bearer ${currentAccessToken}`) {
          res.setHeader("www-authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
          return json({}, 401);
        }
        const rpc = JSON.parse(body);
        if (rpc.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        if (rpc.method === "tools/call") {
          return json({ jsonrpc: "2.0", id: rpc.id,
            result: { content: [{ type: "text", text: "Reviewed action completed" }] } });
        }
        return json({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
          : { tools: [{ name: "create_fixture", description: "Create fixture page", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } }] },
        });
      }
      json({}, 404);
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    try {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = { type: "board", userId, source: "local_implicit", isInstanceAdmin: true };
        next();
      });
      app.use("/api", toolAccessRoutes(db, { deploymentMode: "local_trusted", deploymentExposure: "private", paperclipCloudConnector: null }));
      app.use(errorHandler);

      const connected = await request(app).post(`/api/companies/${company.id}/tools/apps/connect`)
        .send({ link: `${origin}/mcp`, name: "Local OAuth", grantKind }).expect(201);
      const authorization = new URL(connected.body.auth.startUrl);
      expect(authorization.origin).toBe(origin);
      expect(authorization.searchParams.get("client_id")).toBe("fixture-client");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.searchParams.get("resource")).toBe(`${origin}/mcp`);
      const state = authorization.searchParams.get("state")!;
      const [pending] = await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state));
      expect(pending.companyId).toBe(company.id);

      const completed = await request(app).get("/api/tools/oauth/callback")
        .query({ state, code: "fixture-code", iss: origin }).expect(200);
      expect(completed.body.catalog).toEqual([expect.objectContaining({ toolName: "create_fixture", riskLevel: "write" })]);
      if (grantKind === "user") {
        await request(app).post(`/api/companies/${company.id}/tools/apps/${connected.body.connectionId}/finalize-oauth-access`)
          .send({ grantKind }).expect(200);
      }
      await request(app).post(`/api/companies/${company.id}/tools/apps/${connected.body.connectionId}/finish`)
        .send({ enabledCatalogEntryIds: completed.body.catalog.map((entry: { id: string }) => entry.id), askFirstCatalogEntryIds: [], access: "all_agents" }).expect(200);

      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.body.connectionId));
      expect(connection).toMatchObject({ companyId: company.id, status: "active", enabled: true, ownership: "dcr" });
      expect(connection.config.oauth).toMatchObject({ clientId: "fixture-client", clientTokenEndpointAuthMethod: authMethod, clientIssuer: origin });
      expect(JSON.stringify(connection.config)).not.toMatch(/fixture-(access|refresh|secret)/);
      if (grantKind === "organization") expect(connection.credentialSecretRefs.map((ref) => ref.configPath))
        .toEqual(expect.arrayContaining(["oauth.access_token", "oauth.refresh_token"]));
      expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connection.id)))
        .toEqual([expect.objectContaining({ toolName: "create_fixture", status: "active", reviewedByUserId: userId })]);
      const tokenCall = calls.find((call) => call.path === "/token")!;
      const tokenBody = new URLSearchParams(tokenCall.body);
      expect(tokenBody.get("code")).toBe("fixture-code");
      expect(tokenBody.get("code_verifier")).toBe(pending.codeVerifier);
      expect(tokenBody.get("resource")).toBe(`${origin}/mcp`);
      expect(tokenCall.authorization).toBe(authMethod === "client_secret_basic"
        ? `Basic ${Buffer.from("fixture-client:fixture-secret").toString("base64")}` : undefined);
      expect(tokenBody.has("client_secret")).toBe(false);
      expect(calls.some((call) => call.path === "/mcp" && call.authorization === "Bearer fixture-access")).toBe(true);
      expect(calls.filter((call) => call.path === "/register")).toHaveLength(1);

      const [grant] = await db.select().from(connectionGrants).where(and(
        eq(connectionGrants.connectionId, connection.id), eq(connectionGrants.kind, grantKind)));
      const consentedAt = grant.providerTenant?.oauth?.consentedAt;
      expect(consentedAt).toEqual(expect.any(String));
      expect(Number.isFinite(Date.parse(consentedAt!))).toBe(true);
      const [agent] = await db.insert(agents).values({ companyId: company.id, name: "OAuth approval agent",
        role: "engineer", adapterType: "process" }).returning();
      const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Delayed OAuth approval",
        status: "in_progress", assigneeAgentId: agent.id }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
        invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue.id } }).returning();
      await initializeRunIdentity(db, { companyId: company.id, runId: run.id, issueId: issue.id,
        responsibleUserId: userId, cause: "instruction" });
      await db.insert(toolPolicies).values({ companyId: company.id, name: "Review OAuth actions",
        policyType: "require_approval", selectors: { connectionId: connection.id } });
      const options = { deploymentMode: "local_trusted" as const, deploymentExposure: "private" as const, paperclipCloudConnector: null };
      const first = toolAccessService(db, options);
      const second = toolAccessService(db, options);
      const signingSecret = "oauth-protocol-approval-signing-secret";
      const gatewayOptions = { toolActionSigningSecret: signingSecret,
        oauthGrantRefresher: first.refreshOAuthGrantCredentials };
      const gateway = createToolGatewayService(db, gatewayOptions);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const tool = (await gateway.listToolsForSession(session.token)).find(entry => entry.connectionId === connection.id)!;
      expect(tool).toBeDefined();
      const reviewActions = ["after refresh", "tomorrow", "connection repair", "changed authorization", "withdrawn formal approval", "expired authorization"];
      for (const action of reviewActions) {
        await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name,
          parameters: { action, sharingPolicy: { mode: "domain", domain: "paperclip.ing" } } })).rejects.toMatchObject({ reasonCode: "approval_required" });
      }
      const savedActions = await db.select().from(toolActionRequests).where(eq(toolActionRequests.issueId, issue.id));
      expect(savedActions).toHaveLength(reviewActions.length);
      const pendingActions = reviewActions.map(action => savedActions.find(saved => {
        const payload = readSignedToolArgumentsPayload({ signedArguments: saved.signedArguments,
          invocationId: saved.invocationId, toolName: tool.name, signingSecret });
        return (payload?.arguments as { action: string })?.action === action;
      })!);
      await db.update(connectionGrants).set({ providerTenant: {
        ...grant.providerTenant,
        oauth: { ...grant.providerTenant?.oauth, accessTokenExpiresAt: new Date(0).toISOString() },
      } }).where(eq(connectionGrants.id, grant.id));
      const refreshInput = { companyId: company.id, connectionId: connection.id, grantId: grant.id, actor: { actorType: "user" as const, actorId: userId } };
      const refreshed = await Promise.all([
        first.refreshOAuthGrantCredentials(refreshInput),
        second.refreshOAuthGrantCredentials(refreshInput),
      ]);
      expect(refreshed.map(row => row.id)).toEqual([grant.id, grant.id]);
      const exchanges = calls.filter(call => call.path === "/token");
      expect(exchanges).toHaveLength(2);
      const refreshBody = new URLSearchParams(exchanges[1].body);
      expect(refreshBody.get("grant_type")).toBe("refresh_token");
      expect(refreshBody.get("refresh_token")).toBe("fixture-refresh");
      expect(refreshBody.get("resource")).toBe(`${origin}/mcp`);
      expect(exchanges[1].authorization).toBe(tokenCall.authorization);
      const [persistedGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id));
      expect(persistedGrant.providerTenant?.oauth).not.toHaveProperty("refreshLease");
      expect(persistedGrant.providerTenant?.oauth?.consentedAt).toBe(consentedAt);
      expect(Date.parse(persistedGrant.providerTenant!.oauth!.accessTokenExpiresAt!)).toBeGreaterThan(Date.now());
      expect(JSON.stringify(persistedGrant)).not.toMatch(/fixture-(access|refresh|secret)/);
      await first.checkHealth(connection.id, { actorType: "user", actorId: userId });
      expect(calls.some(call => call.path === "/mcp" && call.authorization === "Bearer fixture-access-rotated")).toBe(true);
      await db.update(connectionGrants).set({ providerTenant: {
        ...persistedGrant.providerTenant,
        oauth: { ...persistedGrant.providerTenant?.oauth, accessTokenExpiresAt: new Date(0).toISOString() },
      } }).where(eq(connectionGrants.id, grant.id));
      await second.refreshOAuthGrantCredentials(refreshInput);
      const allExchanges = calls.filter(call => call.path === "/token");
      expect(allExchanges).toHaveLength(3);
      expect(new URLSearchParams(allExchanges[2].body).get("refresh_token")).toBe("fixture-refresh-rotated");
      expect(calls.filter(call => call.path === "/register")).toHaveLength(1);
      // Rebuild the gateway after the requesting run ends. The durable request,
      // rather than the original session or its old tokens, owns execution.
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
      const restarted = createToolGatewayService(db, gatewayOptions);
      const approve = (id: string) => restarted.approveActionRequest({ companyId: company.id,
        actionRequestId: id, actor: { userId } });
      const [currentGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id));
      const catalog = completed.body.catalog[0];
      for (const change of ["tool", "destination", "scopes", "consent"]) {
        try {
          if (change === "tool") await db.update(toolCatalogEntries).set({ versionHash: "new tool definition" })
            .where(eq(toolCatalogEntries.id, catalog.id));
          else if (change === "destination") await db.update(toolConnections).set({
            config: { ...connection.config, url: `${origin}/different-target` },
          }).where(eq(toolConnections.id, connection.id));
          else await db.update(connectionGrants).set({ providerTenant: { ...currentGrant.providerTenant,
            oauth: { ...currentGrant.providerTenant?.oauth,
              ...(change === "scopes" ? { scopes: ["tools.admin"] } : { consentedAt: "2026-11-10T00:00:00Z" }) },
          } }).where(eq(connectionGrants.id, grant.id));
          await expect(approve(pendingActions[3].id)).rejects.toMatchObject({ reasonCode: "approved_tool_target_changed" });
          expect(calls.filter(call => call.path === "/mcp" && JSON.parse(call.body).method === "tools/call")).toHaveLength(0);
        } finally {
          await db.update(toolCatalogEntries).set({ versionHash: catalog.versionHash }).where(eq(toolCatalogEntries.id, catalog.id));
          await db.update(toolConnections).set({ config: connection.config }).where(eq(toolConnections.id, connection.id));
          await db.update(connectionGrants).set({ providerTenant: currentGrant.providerTenant }).where(eq(connectionGrants.id, grant.id));
        }
      }
      await expect(approve(pendingActions[0].id)).resolves.toMatchObject({ status: "executed" });
      await expect(approve(pendingActions[0].id)).resolves.toMatchObject({ status: "executed" });
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
        await expect(approve(pendingActions[1].id)).resolves.toMatchObject({ status: "executed" });
      } finally { vi.useRealTimers(); }
      await db.update(connectionGrants).set({ status: "needs_reauthorization", updatedAt: new Date() })
        .where(eq(connectionGrants.id, grant.id));
      await expect(approve(pendingActions[2].id)).resolves.toMatchObject({ status: "approved" });
      const [formal] = await db.insert(approvals).values({ companyId: company.id,
        type: "request_board_approval", status: "approved", payload: {} }).returning();
      await db.update(toolActionRequests).set({ approvalId: formal.id }).where(eq(toolActionRequests.id, pendingActions[4].id));
      await expect(approve(pendingActions[4].id)).resolves.toMatchObject({ status: "approved" });
      await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.id, formal.id));
      await restarted.recoverApprovedActionReviews(company.id);
      expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pendingActions[4].id)))[0].status)
        .toBe("cancelled");
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
        canReconcile: () => true, onError: error => { throw error; } });
      try {
        await registerToolReviewRecoveryWork(coordinator, restarted, () => true).ready;
        await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 5000 });
        await expect(restarted.recoverApprovedActionReviews(company.id)).resolves.toMatchObject({ retry: false });
        // The supported connection writer wakes recovery after commit. No
        // second approval or agent run is needed for the same authorization.
        await writeToolConnectionHealthChange(db, { companyId: company.id, id: connection.id }, async tx => {
          await tx.update(connectionGrants).set({ status: "active", updatedAt: new Date(Date.now() + 1) })
            .where(eq(connectionGrants.id, grant.id));
        });
        await vi.waitFor(async () => {
          expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pendingActions[2].id)))[0].status)
            .toBe("executed");
        }, { timeout: 5000, interval: 25 });
      } finally { await coordinator.stop(); }
      // A production refresh failure is a pre-dispatch sign-in wait, even
      // when the grant looked active when the person clicked Approve.
      const [beforeReauthConnection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id));
      const [beforeReauthGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id));
      rejectRefresh = true;
      await db.update(connectionGrants).set({ providerTenant: { ...beforeReauthGrant.providerTenant,
        oauth: { ...beforeReauthGrant.providerTenant?.oauth, accessTokenExpiresAt: new Date(0).toISOString() },
      } }).where(eq(connectionGrants.id, grant.id));
      await expect(approve(pendingActions[5].id)).resolves.toMatchObject({ status: "approved" });
      await restarted.recoverApprovedActionReviews(company.id);
      expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pendingActions[5].id)))[0].status)
        .toBe("approved");
      const deadline = new Date(Date.now() - 1);
      await db.update(toolActionRequests).set({ expiresAt: deadline }).where(eq(toolActionRequests.id, pendingActions[5].id));
      expect(await restarted.nextActionReviewExpiryAt()).toBe(deadline.getTime());
      await restarted.sweepExpiredActionReviews();
      expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pendingActions[5].id)))[0].status)
        .toBe("expired");
      rejectRefresh = false;
      // Restore this fixture's original authorization metadata to exercise
      // manual replacement separately. The recovery worker is already stopped.
      await db.update(toolConnections).set({ status: beforeReauthConnection.status,
        enabled: beforeReauthConnection.enabled, credentialRefs: beforeReauthConnection.credentialRefs,
        credentialSecretRefs: beforeReauthConnection.credentialSecretRefs,
      }).where(eq(toolConnections.id, connection.id));
      await db.update(connectionGrants).set({ status: "active", credentialSecretRefs: beforeReauthGrant.credentialSecretRefs,
        providerTenant: beforeReauthGrant.providerTenant }).where(eq(connectionGrants.id, grant.id));
      const accessRef = currentGrant.credentialSecretRefs.find(ref => ref.configPath === "oauth.access_token")!;
      await secretService(db).rotate(accessRef.secretId, { value: "manually-replaced-token" }, { userId });
      await expect(approve(pendingActions[3].id)).rejects.toMatchObject({ reasonCode: "approved_tool_target_changed" });
      const executions = calls.filter(call => call.path === "/mcp" && JSON.parse(call.body).method === "tools/call");
      expect(executions).toHaveLength(3);
      expect(executions.map(call => JSON.parse(call.body).params.arguments.action).sort())
        .toEqual(["after refresh", "connection repair", "tomorrow"]);
      for (const execution of executions) expect(JSON.parse(execution.body).params.arguments.sharingPolicy)
        .toEqual({ mode: "domain", domain: "paperclip.ing" });
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    }
  });
});
