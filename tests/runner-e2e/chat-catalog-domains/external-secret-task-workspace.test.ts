import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const handlers = vi.hoisted(() => [] as Array<(request: unknown, response: unknown) => Promise<void>>);
vi.mock("node:http", () => ({ createServer: (handler: (request: unknown, response: unknown) => Promise<void>) => { handlers.push(handler); return { close: (done: () => void) => done() }; } }));
vi.mock("../../e2e/fetch-allowed-port.js", () => ({ listenOnFetchAllowedPort: async () => 40001 }));
import { readSecretEndpointConsumerRun, readSecretEndpointTaskBinding, secretTestEndpoint } from "./external-secret-endpoint.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); handlers.length = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "secret-task-cwd-")); roots.push(root); vi.stubEnv("PAPERCLIP_RUNNER_E2E_TEMP_ROOT", root);
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "synthetic-jwt-secret-for-unit-test"); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "unit");
  const cwd = path.join(await realpath(root), "task"); await mkdir(cwd);
  const runId = "11111111-1111-1111-1111-111111111111";
  const run = { id: runId, companyId: "company", agentId: "morgan", status: "running", startedAt: "2026-10-28T01:00:00Z", responsibleUserId: "user", contextSnapshot: { issueId: "task" } };
  const runs = [{ id: runId, agentId: "morgan", status: "running" }, { id: "22222222-2222-2222-2222-222222222222", agentId: "morgan", status: "succeeded" }];
  const task = { id: "task", companyId: "company", assigneeAgentId: "morgan", parentId: null as string | null, originIssueId: "source", executionWorkspaceId: "workspace" };
  const workspace = { id: "workspace", companyId: "company", cwd };
  const agent = { id: "morgan", companyId: "company", adapterType: "paperclip_runner" };
  const privateSecrets: string[] = [];
  const get = async (url: string) => url.startsWith("/api/companies/company/heartbeat-runs") ? runs : url.startsWith("/api/heartbeat-runs/") ? run : url === "/api/agents/morgan" ? agent : url.endsWith("/workspace") ? { workspace } : task;
  const ctx = { scenario: { id: "secrets.least-scope-delivery" }, input: { nonce: "owned-test", execution: { environment: { id: "local" } }, fixtures: { company: { id: "company" } }, privateSecrets, api: { baseURL: "http://fixture.invalid", get } }, issue: () => ({ id: "source" }) } as unknown as ChatCatalogContext;
  return { ctx, cwd, root, run, runs, task, workspace, privateSecrets };
}
it("binds only the actual active Morgan run, delegated task and its persisted owned workspace", async () => {
  const f = await fixture();
  await expect(readSecretEndpointTaskBinding(f.ctx, "morgan", f.run.id, "task")).resolves.toEqual({ taskId: "task", workspaceId: "workspace", taskWorkspaceMatched: true });
  await expect(readSecretEndpointConsumerRun(f.ctx, "morgan")).resolves.toMatchObject({ run: { id: f.run.id }, taskId: "task", workspaceId: "workspace", taskWorkspaceMatched: true });
});
it.each(["CEO", "wrong task", "wrong origin chat", "workspace outside attempt", "foreign company", "wrong workspace", "unstarted", "settled"])("rejects %s before endpoint success", async invalid => {
  const f = await fixture();
  if (invalid === "CEO") f.run.agentId = "ceo";
  if (invalid === "wrong task") f.run.contextSnapshot.issueId = "other";
  if (invalid === "wrong origin chat") f.task.originIssueId = "other";
  if (invalid === "workspace outside attempt") f.workspace.cwd = tmpdir();
  if (invalid === "foreign company") f.workspace.companyId = "foreign";
  if (invalid === "wrong workspace") f.task.executionWorkspaceId = "other";
  if (invalid === "unstarted") f.run.startedAt = "invalid";
  if (invalid === "settled") f.run.status = "succeeded";
  await expect(readSecretEndpointTaskBinding(f.ctx, "morgan", f.run.id, "task")).rejects.toThrow();
});
it.each(["none", "two"])("rejects a consumer with %s running runs", async count => {
  const f = await fixture();
  f.runs[1]!.status = count === "two" ? "running" : "succeeded";
  if (count === "none") f.runs[0]!.status = "succeeded";
  await expect(readSecretEndpointConsumerRun(f.ctx, "morgan")).rejects.toThrow();
});
it("actual inline helper needs only the bound credential and emits sanitized status, never credential bytes", async () => {
  const f = await fixture(), endpoint = await secretTestEndpoint(f.ctx, "morgan", "synthetic-deployment-value", "DEPLOYMENT_API_KEY", { boundSecretId: "bound", unrelatedCompanyKey: "unrelated-company-key", instanceKey: "custody_probe" }, { taskBound: true });
  try {
    expect(endpoint.scriptPath).toBe(""); expect(endpoint.command).not.toContain(f.cwd); expect(endpoint.command).not.toContain("synthetic-deployment-value");
    expect(endpoint.command).not.toMatch(/PAPERCLIP_|x-paperclip/);
    const code = endpoint.command.slice("node --input-type=module -e '".length, -1).replace(/'\\''/g, "'");
    const output: string[] = [], requests: Array<{ headers: Record<string, string> }> = [];
    // A native runner shell: only the configured credential, no Paperclip run identity.
    const fakeProcess = { env: { DEPLOYMENT_API_KEY: "synthetic-deployment-value" }, cwd: () => f.cwd, stdout: { write: (text: string) => output.push(text) }, exitCode: 0 };
    const execute = new (Object.getPrototypeOf(async () => {}).constructor)("process", "fetch", code);
    await execute(fakeProcess, async (_url: string, options: { headers: Record<string, string>; redirect: string }) => { expect(options.redirect).toBe("error"); requests.push(options); return { ok: true, status: 200, json: async () => ({ ok: true, privateData: "synthetic-deployment-value" }) }; });
    expect(requests[0]!.headers).toEqual({ authorization: "Bearer synthetic-deployment-value" });
    expect(output).toEqual([JSON.stringify({ ok: true, status: 200, check: "publishing endpoint" })]); expect(fakeProcess.exitCode).toBe(0);
    expect(JSON.stringify({ command: endpoint.command, calls: endpoint.calls, receipts: endpoint.scopeReceipts, output })).not.toContain("synthetic-deployment-value");
  } finally { await endpoint.close(); }
});
it("actual endpoint binds the server's running Morgan run, probes with its own authority and rejects unauthorized scope", async () => {
  const f = await fixture(), endpoint = await secretTestEndpoint(f.ctx, "morgan", "synthetic-deployment-value", "DEPLOYMENT_API_KEY", { boundSecretId: "bound", unrelatedCompanyKey: "unrelated-company-key", instanceKey: "custody_probe" }, { taskBound: true });
  const statuses: number[] = [], output: string[] = [], bearers: string[] = [];
  let deniedStatus = 200;
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init: { headers: Record<string, string> }) => { bearers.push(init.headers.authorization); return new Response(JSON.stringify(url.pathname === "/api/agents/me" ? { id: "morgan", companyId: "company" } : url.pathname === "/api/agents/me/secrets" ? { secrets: [{ key: "openrouter_api_key", secretRef: "provider" }, { key: "deployment-api-key", secretRef: "bound" }] } : {}), { status: url.pathname.endsWith("/value") ? deniedStatus : 200 }); }));
  const invoke = (authorization: string) => handlers[0]!({ headers: { authorization }, method: "GET", url: "/publishing-check" }, { writeHead: (status: number) => statuses.push(status), end: (text: string) => output.push(text) });
  try {
    await invoke("Bearer synthetic-deployment-value"); expect(statuses.at(-1)).toBe(403);
    deniedStatus = 403;
    await invoke("Bearer wrong-value"); expect(statuses.at(-1)).toBe(403);
    f.run.status = "succeeded"; await invoke("Bearer synthetic-deployment-value"); expect(statuses.at(-1)).toBe(403); f.run.status = "running";
    await invoke("Bearer synthetic-deployment-value"); expect(statuses.at(-1)).toBe(200);
    expect(endpoint.scopeReceipts.at(-1)).toMatchObject({ runId: f.run.id, agentId: "morgan", tokenRunMatched: true, taskId: "task", workspaceId: "workspace", taskWorkspaceMatched: true, catalogKeys: ["openrouter_api_key", "deployment-api-key"], companyDeniedStatus: 403, instanceDeniedStatus: 403 });
    expect(endpoint.calls.filter(call => call.authorized)).toHaveLength(3);
    const token = bearers.at(-1)!.slice("Bearer ".length);
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    expect(claims).toMatchObject({ sub: "morgan", company_id: "company", run_id: f.run.id, adapter_type: "paperclip_runner", responsible_user_id: "user" });
    expect(f.privateSecrets).toContain(token);
    expect(JSON.stringify({ calls: endpoint.calls, receipts: endpoint.scopeReceipts, output })).not.toContain(token);
    expect(JSON.stringify({ calls: endpoint.calls, receipts: endpoint.scopeReceipts, output })).not.toContain("synthetic-deployment-value");
  } finally { await endpoint.close(); }
});
it("active-run consumer mode attributes the bound credential to the server's one running run, without shell identity headers", async () => {
  const f = await fixture(); vi.stubEnv("PAPERCLIP_HOME", path.join(await realpath(f.root), "home"));
  f.ctx.scenario.id = "secrets.vault-reference";
  const endpoint = await secretTestEndpoint(f.ctx, "morgan", "synthetic-deployment-value", "DEPLOYMENT_API_KEY", undefined, { forbidAwsRuntimeAuthority: true, activeRunConsumer: true });
  const statuses: number[] = [];
  const invoke = (authorization: string, headers: Record<string, string> = {}) => handlers[0]!({ headers: { authorization, "x-paperclip-no-aws": "true", ...headers }, method: "GET", url: "/publishing-check" }, { writeHead: (status: number) => statuses.push(status), end: () => {} });
  try {
    expect(endpoint.command).not.toContain("synthetic-deployment-value");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(endpoint.scriptPath, "utf8")).not.toMatch(/PAPERCLIP_AGENT_ID|PAPERCLIP_RUN_ID|x-paperclip-agent|x-paperclip-run/);
    await invoke("Bearer synthetic-deployment-value"); expect(statuses.at(-1)).toBe(200);
    expect(endpoint.calls.at(-1)).toMatchObject({ authorized: true, agentId: "morgan", runId: f.run.id, awsAuthorityAbsent: true });
    // Forged shell headers are ignored: identity comes from the server.
    await invoke("Bearer synthetic-deployment-value", { "x-paperclip-agent": "ceo", "x-paperclip-run": "33333333-3333-3333-3333-333333333333" });
    expect(endpoint.calls.at(-1)).toMatchObject({ agentId: "morgan", runId: f.run.id });
    await invoke("Bearer wrong-value"); expect(statuses.at(-1)).toBe(403);
    await invoke("Bearer synthetic-deployment-value", { "x-paperclip-no-aws": "false" }); expect(statuses.at(-1)).toBe(403);
    f.runs[0]!.status = "succeeded"; await invoke("Bearer synthetic-deployment-value"); expect(statuses.at(-1)).toBe(403);
    f.runs[0]!.status = "running"; f.runs[1]!.status = "running"; await invoke("Bearer synthetic-deployment-value"); expect(statuses.at(-1)).toBe(403);
    f.runs[1]!.status = "succeeded"; f.run.agentId = "ceo"; await invoke("Bearer synthetic-deployment-value"); expect(statuses.at(-1)).toBe(403);
  } finally { await endpoint.close(); }
});
