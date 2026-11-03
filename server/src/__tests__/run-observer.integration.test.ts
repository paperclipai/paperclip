import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, issueComments, runIdentityContexts } from "@paperclipai/db";
import { reserveSteeredIdentity } from "../services/run-identity.js";
import { agentService } from "../services/agents.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

describe("run observer capability", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    vi.stubEnv("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE", "shadow");
    vi.stubEnv("PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", "false");
    server = await startRunnerApiTestServer({ humanSessions: true, databaseUrl: process.env.PAPERCLIP_OBSERVER_TEST_DATABASE_URL });
  }, 90_000);
  afterAll(async () => { await server?.close(); vi.unstubAllEnvs(); });
  it("allows only its own active status and is revoked on stop", async () => {
    const f = await server.fixture({ connectionScenario: "fresh" });
    const other = await server.fixture({ connectionScenario: "fresh" });
    await server.db.insert(instanceUserRoles).values({ userId: f.responsibleUserId!, role: "instance_admin" });
    const cookie = await server.humanSession(f.responsibleUserId!);
    const issue = await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-token`, { method: "POST", headers: { cookie, origin: server.apiUrl } });
    expect(issue.status).toBe(201);
    expect(issue.headers.get("cache-control")).toBe("no-store");
    const { token } = await issue.json();
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(120);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const status = () => fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-status`, { headers });
    expect(await (await status()).json()).toEqual({ active: true });
    expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}`, { headers })).status).toBe(403);
    expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${other.runId}/observer-status`, { headers })).status).toBe(403);
    expect((await fetch(`${server.apiUrl}/api/companies/${f.companyId}/approvals`, { method: "POST", headers, body: "{}" })).status).toBe(403);
    expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-status`, { method: "HEAD", headers })).status).toBe(403);
    const agentToken = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId);
    expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-token`, { method: "POST", headers: { authorization: `Bearer ${agentToken}` } })).status).toBe(403);
    const messageId = randomUUID();
    await server.db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.responsibleUserId!, body: "Fictional pending steering" });
    const pending = await reserveSteeredIdentity(server.db, { companyId: f.companyId, agentId: f.agentId,
      runId: f.runId, issueId: f.issueId, messageId });
    expect(pending).toBeTruthy();
    expect((await status()).status).toBe(200);
    const [steering] = await server.db.select().from(runIdentityContexts).where(eq(runIdentityContexts.id, pending!.id));
    expect(steering.status).toBe("pending");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_TTL_SECONDS", "1");
    const shortToken = createLocalAgentJwt(f.agentId, f.companyId, "run_observer", f.runId, null, { kind: "run_status_observer" });
    vi.stubEnv("PAPERCLIP_AGENT_JWT_TTL_SECONDS", "172800");
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-status`, { headers: { authorization: `Bearer ${shortToken}` } })).status).toBe(401);
    const rejectedCreation = await fetch(`${server.apiUrl}/api/agents/${f.agentId}/keys`, { method: "POST",
      headers: { cookie, origin: server.apiUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "fictitious", scope: { kind: "run_status_observer" } }) });
    expect(rejectedCreation.status).toBe(400);
    // Existing malformed persistent keys must also be denied on ordinary routes.
    const persistent = await agentService(server.db).createApiKey(f.agentId, "fictitious", { kind: "run_status_observer" }, { responsibleUserId: f.responsibleUserId });
    const forbidden = await fetch(`${server.apiUrl}/api/agents/me`, { headers: { authorization: `Bearer ${persistent.token}` } });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: "Run observer capabilities require a run-scoped token" });
    await server.db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
    expect((await status()).status).toBe(403);
    await server.db.update(heartbeatRuns).set({ status: "cancelled", resultJson: null }).where(eq(heartbeatRuns.id, f.runId));
    expect((await status()).status).toBe(403);
  });
});
