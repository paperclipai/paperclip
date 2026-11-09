import { describe, expect, it, vi } from "vitest";
import { railwayCommandBudgetMs, createRailwayClient, discoverRailwayWorkspace, isRailwayConnection, isRailwayEndpoint, isRailwayToolBlocked, RAILWAY_API_URL, RAILWAY_MCP_URL, RAILWAY_QUERIES, RAILWAY_TOOLS, railwayRisk } from "../services/railway.js";
import { deploymentData, instanceId, target, targetData } from "./fixtures/railway/provider.js";

function fixture(responder?: (query: string) => Response | undefined) {
  const request = vi.fn(async (_url: string, init: RequestInit) => {
    const { query } = JSON.parse(String(init.body));
    return responder?.(query) ?? Response.json({ data: query === RAILWAY_QUERIES.target ? targetData : query === RAILWAY_QUERIES.deployment ? deploymentData : { deploymentRestart: true } });
  });
  const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }));
  const controller = new AbortController();
  return { request, runCommand, controller, client: createRailwayClient({ authorization: "Bearer railway-fixture-secret", request, runCommand, signal: controller.signal }) };
}

describe("Railway governed operations", () => {
  it("binds project listing and the access probe to an explicit workspace", async () => {
    const f = fixture(() => Response.json({ data: { projects: { edges: [] } } }));
    await expect(f.client.call("paperclip-railway-list-projects", {})).rejects.toMatchObject({ code: "railway_invalid_arguments" });
    expect(f.request).not.toHaveBeenCalled();
    await f.client.probe(target.projectId);
    await f.client.call("paperclip-railway-list-projects", { workspaceId: target.projectId, first: 5 });
    expect(f.request.mock.calls.map(([, init]) => JSON.parse(String(init.body)).variables)).toEqual([
      { workspaceId: target.projectId, first: 1 }, { workspaceId: target.projectId, first: 5 },
    ]);
    expect(RAILWAY_QUERIES.projects).toContain("projects(workspaceId:$workspaceId,");
  });

  it.each(["structured", "sse"])("discovers workspace access from the hosted %s response without account profile scopes", async (format) => {
    const data = { workspaces: [{ id: target.projectId }] };
    const payload = { jsonrpc: "2.0", id: "paperclip-railway-workspace-probe", result: format === "structured" ? { structuredContent: data } : { content: [{ type: "text", text: JSON.stringify(data) }] } };
    const request = vi.fn(async () => format === "structured" ? Response.json(payload) : new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    await expect(discoverRailwayWorkspace({ authorization: "Bearer fixture", request, signal: new AbortController().signal })).resolves.toBe(target.projectId);
    expect(request).toHaveBeenCalledWith(RAILWAY_MCP_URL, expect.objectContaining({ redirect: "error", body: expect.stringContaining('"name":"list-workspaces"') }));
  });

  it("keeps operations unavailable for empty or failed workspace discovery without exposing provider output", async () => {
    for (const result of [{ structuredContent: { workspaces: [] } }, { isError: true, content: [{ type: "text", text: "private provider details" }] }]) {
      const request = vi.fn(async () => Response.json({ result }));
      await expect(discoverRailwayWorkspace({ authorization: "Bearer fixture", request, signal: new AbortController().signal })).rejects.toThrow(/Railway/);
    }
  });

  it("recognizes Railway's HTTP 200 authorization errors without echoing provider details", async () => {
    const f = fixture(() => Response.json({ errors: [{ message: "Not Authorized", extensions: { code: "INTERNAL_SERVER_ERROR", private: "provider secret" } }], data: null }));
    await expect(f.client.probe(target.projectId)).rejects.toMatchObject({ code: "railway_api_authorization_required", status: 403, message: expect.stringContaining("workspace selected during consent") });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("requires exact provider identity and treats shell and remote agents as privileged", () => {
    expect(isRailwayEndpoint("https://mcp.railway.com/")).toBe(true);
    for (const url of ["https://mcp.railway.com/path", "https://mcp.railway.com?token=x", "https://mcp.railway.com.evil.test", "http://mcp.railway.com"]) expect(isRailwayEndpoint(url)).toBe(false);
    expect(isRailwayConnection({ transport: "mcp_remote", authKind: "oauth", credentialSource: "paperclip_vault", config: { url: "https://mcp.railway.com", sourceTemplateKey: "railway", connectionMethodKey: "mcp-oauth" } })).toBe(true);
    expect(railwayRisk("railwayAgent")).toBe("destructive");
    expect(isRailwayToolBlocked("accept_deploy")).toBe(true);
    expect(railwayRisk("paperclip-railway-run-command")).toBe("destructive");
    expect(railwayRisk("unfamiliar-tool")).toBe("write");
    expect(RAILWAY_TOOLS).toHaveLength(11);
    expect(RAILWAY_TOOLS.map((tool) => tool.name)).not.toContain("paperclip-railway-deploy-revision");
  });

  it("gives container commands time for target checks without exceeding the gateway limit", () => {
    expect(railwayCommandBudgetMs({})).toBe(40000);
    expect(railwayCommandBudgetMs({ timeoutSeconds: 1 })).toBe(11000);
    expect(railwayCommandBudgetMs({ timeoutSeconds: 60 })).toBe(60000);
    expect(railwayCommandBudgetMs({ timeoutSeconds: 999 })).toBe(60000);
  });

  it("checks full deployment membership before a single fixed mutation", async () => {
    const f = fixture();
    await expect(f.client.call("paperclip-railway-restart", target)).resolves.toEqual({ deploymentRestart: true, targetDeploymentId: target.deploymentId });
    expect(f.request.mock.calls.map(([, init]) => JSON.parse(String(init.body)).query)).toEqual([RAILWAY_QUERIES.target, RAILWAY_QUERIES.deployment, RAILWAY_QUERIES.restart]);
    for (const [url, init] of f.request.mock.calls) {
      expect(url).toBe(RAILWAY_API_URL);
      expect(init.redirect).toBe("error");
      expect(init.headers).toMatchObject({ Authorization: "Bearer railway-fixture-secret" });
    }
    expect(JSON.parse(String(f.request.mock.calls[2][1].body)).variables).toEqual({ deploymentId: target.deploymentId });
  });

  it.each(["project", "environment", "service", "deployment"])("denies a mismatched %s before mutation", async (field) => {
    const f = fixture((q) => {
      if (field === "deployment" && q === RAILWAY_QUERIES.deployment) return Response.json({ data: { deployment: { ...deploymentData.deployment, serviceId: instanceId } } });
      if (field !== "deployment" && q === RAILWAY_QUERIES.target) return Response.json({ data: { ...targetData, [field]: { ...targetData[field as keyof typeof targetData], id: instanceId } } });
    });
    await expect(f.client.call("paperclip-railway-restart", target)).rejects.toMatchObject({ code: "railway_target_mismatch" });
    expect(f.request.mock.calls.every(([, init]) => !JSON.parse(String(init.body)).query.startsWith("mutation"))).toBe(true);
  });

  it("bounds and redacts logs without selecting variables", async () => {
    const f = fixture((q) => q === RAILWAY_QUERIES.runtimeLogs ? Response.json({ data: { deploymentLogs: Array.from({ length: 20 }, () => ({ message: `railway-fixture-secret ${"x".repeat(9000)}`, severity: "INFO" })) } }) : undefined);
    const result = await f.client.call("paperclip-railway-read-logs", { ...target, limit: 10 });
    expect(JSON.stringify(result)).not.toContain("railway-fixture-secret");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(66000);
    expect(result).toMatchObject({ truncated: true });
    await expect(f.client.call("paperclip-railway-read-logs", { ...target, limit: 501 })).rejects.toMatchObject({ code: "railway_invalid_arguments" });
    expect(Object.values(RAILWAY_QUERIES).join(" ")).not.toMatch(/variableCollection|variables\s*\{/);
  });

  it("reports when a single long log line was cut", async () => {
    const f = fixture((q) => q === RAILWAY_QUERIES.runtimeLogs ? Response.json({ data: { deploymentLogs: [{ message: "x".repeat(20000) }] } }) : undefined);
    await expect(f.client.call("paperclip-railway-read-logs", target)).resolves.toMatchObject({ truncated: true, limitReached: false });
  });

  it.each([401, 403, 429, 500])("sanitizes HTTP %s without retries", async (status) => {
    const f = fixture(() => new Response("provider secret", { status }));
    await expect(f.client.probe(target.projectId)).rejects.toThrow(/Railway/);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("does not expose GraphQL error details or retry an ambiguous mutation", async () => {
    const f = fixture((q) => q === RAILWAY_QUERIES.restart ? Response.json({ errors: [{ message: "sensitive provider payload" }] }) : undefined);
    await expect(f.client.call("paperclip-railway-restart", target)).rejects.toMatchObject({ code: "railway_api_error" });
    expect(f.request).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["restart", { deploymentRestart: false }],
    ["rollback", { deploymentRollback: false }],
    ["redeploy", { deploymentRedeploy: null }],
    ["redeploy", { deploymentRedeploy: { id: "not-a-deployment-id" } }],
  ])("does not report an unconfirmed %s as successful", async (operation, data) => {
    const f = fixture((q) => q.startsWith("mutation") ? Response.json({ data }) : undefined);
    await expect(f.client.call(`paperclip-railway-${operation}`, target)).rejects.toMatchObject({ code: "railway_operation_unconfirmed" });
    expect(f.request).toHaveBeenCalledTimes(3);
  });

  it("rejects oversized responses, cancelled calls and GraphQL passthrough", async () => {
    const f = fixture(() => new Response("x".repeat(1024 * 1024 + 1)));
    await expect(f.client.probe(target.projectId)).rejects.toMatchObject({ code: "railway_output_limit" });
    await expect(f.client.call("paperclip-railway-list-projects", { query: "mutation Evil" })).rejects.toMatchObject({ code: "railway_invalid_arguments" });
    f.controller.abort();
    await expect(f.client.probe(target.projectId)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it.each(["paperclip-railway-deploy-revision", "paperclip_railway_deploy_revision", "paperclipRailwayDeployRevision"])("blocks %s before any repository preflight or deployment mutation", async (name) => {
    // Even a matching repository in the preflight can change before mutation.
    // Without an atomic provider binding, no upstream request is safe to send.
    const f = fixture();
    const { deploymentId: _, ...ids } = target;
    await expect(f.client.call(name, { ...ids, repository: "example/app", commitSha: "a".repeat(40) })).rejects.toMatchObject({ code: "railway_action_blocked", status: 403 });
    expect(f.request).not.toHaveBeenCalled();
    expect(isRailwayToolBlocked(name)).toBe(true);
    expect(railwayRisk(name)).toBe("destructive");
  });

  it("allows only an instance in the exact running deployment to reach SSH", async () => {
    const f = fixture();
    await expect(f.client.call("paperclip-railway-run-command", { ...target, deploymentInstanceId: target.serviceId, command: "true" })).rejects.toMatchObject({ code: "railway_target_mismatch" });
    expect(f.runCommand).not.toHaveBeenCalled();
    await f.client.call("paperclip-railway-run-command", { ...target, deploymentInstanceId: instanceId, command: "true" });
    expect(f.runCommand).toHaveBeenCalledWith({ deploymentInstanceId: instanceId, command: "true", timeoutSeconds: 30, signal: f.controller.signal });
  });
});
