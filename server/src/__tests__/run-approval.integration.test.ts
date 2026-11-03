import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, heartbeatRuns, instanceUserRoles } from "@paperclipai/db";
import { agentService } from "../services/agents.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

describe("run-scoped approval API", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    vi.stubEnv("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE", "shadow");
    vi.stubEnv("PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", "false");
    vi.stubEnv("PAPERCLIP_REQUIRE_RUN_SCOPED_APPROVALS", "true");
    server = await startRunnerApiTestServer({ humanSessions: true, databaseUrl: process.env.PAPERCLIP_RUN_APPROVAL_TEST_DATABASE_URL });
  }, 90_000);
  afterAll(async () => { await server?.close(); vi.unstubAllEnvs(); });
  it("binds an approval to the signed run and rejects a mismatched header and cancelled run", async () => {
    const f = await server.fixture();
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId);
    expect(token).toBeTruthy();
    const create = (headerRunId?: string) => fetch(`${server.apiUrl}/api/companies/${f.companyId}/approvals`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(headerRunId ? { "x-paperclip-run-id": headerRunId } : {}) },
      body: JSON.stringify({ type: "request_board_approval", payload: { summary: "Fictitious approval" } }),
    });
    const approved = await create();
    expect(approved.status).toBe(201);
    expect(await approved.json()).toMatchObject({ originRunId: f.runId, requestedByAgentId: f.agentId, status: "pending" });
    expect((await create(randomUUID())).status).toBe(422);
    const key = await agentService(server.db).createApiKey(f.agentId, "fictitious", { kind: "standard" });
    const forged = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/approvals`, {
      method: "POST", headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json", "x-paperclip-run-id": f.runId },
      body: JSON.stringify({ type: "request_board_approval", payload: { summary: "Fictitious approval" } }),
    });
    expect(forged.status).toBe(403);
    await server.db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    expect((await create()).status).toBe(403);
  });
  it("cancels the signed run's pending approval through the public API", async () => {
    const f = await server.fixture({ connectionScenario: "fresh" });
    await server.db.insert(instanceUserRoles).values({ userId: f.responsibleUserId!, role: "instance_admin" });
    await server.db.update(heartbeatRuns).set({ runtimeMode: "legacy", runtimeModeResolvedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId);
    const created = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/approvals`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "request_board_approval", payload: { summary: "Fictitious approval" } }),
    });
    expect(created.status).toBe(201);
    const approval = await created.json();
    const cookie = await server.humanSession(f.responsibleUserId!);
    const stopped = await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/cancel`, {
      method: "POST", headers: { cookie, origin: server.apiUrl, "content-type": "application/json" }, body: "{}",
    });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ status: "cancelled" });
    const [result] = await server.db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(result.status).toBe("cancelled");
  });

});
