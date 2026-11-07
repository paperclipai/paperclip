import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const handlers = vi.hoisted(() => [] as Array<(request: unknown, response: unknown) => Promise<void>>);
vi.mock("node:http", () => ({ createServer: (handler: (request: unknown, response: unknown) => Promise<void>) => { handlers.push(handler); return { close: (done: () => void) => done() }; } }));
vi.mock("../../e2e/fetch-allowed-port.js", () => ({ listenOnFetchAllowedPort: async () => 40001 }));
import { readSecretEndpointTaskBinding, secretTestEndpoint } from "./external-secret-endpoint.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); handlers.length = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "secret-task-cwd-")); roots.push(root); vi.stubEnv("PAPERCLIP_RUNNER_E2E_TEMP_ROOT", root);
  const cwd = path.join(await realpath(root), "task"); await mkdir(cwd);
  const runId = "11111111-1111-1111-1111-111111111111";
  const run = { id: runId, companyId: "company", agentId: "morgan", status: "running", startedAt: "2026-10-28T01:00:00Z", contextSnapshot: { issueId: "task" } };
  const task = { id: "task", companyId: "company", assigneeAgentId: "morgan", parentId: "source", executionWorkspaceId: "workspace" };
  const workspace = { id: "workspace", companyId: "company", cwd };
  const privateSecrets: string[] = [];
  const ctx = { scenario: { id: "secrets.least-scope-delivery" }, input: { nonce: "owned-test", execution: { environment: { id: "local" } }, fixtures: { company: { id: "company" } }, privateSecrets, api: { baseURL: "http://fixture.invalid", get: async (url: string) => url.startsWith("/api/heartbeat-runs/") ? run : url.endsWith("/workspace") ? { workspace } : task } }, issue: () => ({ id: "source" }) } as unknown as ChatCatalogContext;
  return { ctx, cwd, run, task, workspace, privateSecrets };
}
it("binds only the actual active Morgan run, delegated task and its persisted owned workspace", async () => {
  const f = await fixture();
  await expect(readSecretEndpointTaskBinding(f.ctx, "morgan", f.run.id, "task", f.cwd)).resolves.toEqual({ taskId: "task", workspaceId: "workspace", taskWorkspaceMatched: true });
});
it.each(["CEO", "wrong task", "wrong parent", "wrong cwd", "foreign company", "wrong workspace", "unstarted", "settled"])("rejects %s before endpoint success", async invalid => {
  const f = await fixture(); let cwd = f.cwd;
  if (invalid === "CEO") f.run.agentId = "ceo";
  if (invalid === "wrong task") f.run.contextSnapshot.issueId = "other";
  if (invalid === "wrong parent") f.task.parentId = "other";
  if (invalid === "wrong cwd") cwd = path.dirname(f.cwd);
  if (invalid === "foreign company") f.workspace.companyId = "foreign";
  if (invalid === "wrong workspace") f.task.executionWorkspaceId = "other";
  if (invalid === "unstarted") f.run.startedAt = "invalid";
  if (invalid === "settled") f.run.status = "succeeded";
  await expect(readSecretEndpointTaskBinding(f.ctx, "morgan", f.run.id, "task", cwd)).rejects.toThrow();
});
it("actual inline helper sends only runtime identities and emits sanitized status, never supplied credential bytes", async () => {
  const f = await fixture(), endpoint = await secretTestEndpoint(f.ctx, "morgan", "synthetic-deployment-value", "DEPLOYMENT_API_KEY", { boundSecretId: "bound", unrelatedCompanyKey: "unrelated-company-key", instanceKey: "custody_probe" }, { taskBound: true });
  try {
    expect(endpoint.scriptPath).toBe(""); expect(endpoint.command).not.toContain(f.cwd); expect(endpoint.command).not.toContain("synthetic-deployment-value");
    const code = endpoint.command.slice("node --input-type=module -e '".length, -1).replace(/'\\''/g, "'");
    const output: string[] = [], requests: Array<{ headers: Record<string, string> }> = [];
    const fakeProcess = { env: { DEPLOYMENT_API_KEY: "synthetic-deployment-value", PAPERCLIP_AGENT_ID: "morgan", PAPERCLIP_RUN_ID: f.run.id, PAPERCLIP_TASK_ID: "task", PAPERCLIP_API_KEY: "synthetic-runtime-token" }, cwd: () => f.cwd, stdout: { write: (text: string) => output.push(text) }, exitCode: 0 };
    const execute = new (Object.getPrototypeOf(async () => {}).constructor)("process", "fetch", code);
    await execute(fakeProcess, async (_url: string, options: { headers: Record<string, string>; redirect: string }) => { expect(options.redirect).toBe("error"); requests.push(options); return { ok: true, status: 200, json: async () => ({ ok: true, privateData: "synthetic-deployment-value" }) }; });
    expect(requests[0]!.headers).toMatchObject({ "x-paperclip-agent": "morgan", "x-paperclip-run": f.run.id, "x-paperclip-task": "task", "x-paperclip-cwd": f.cwd });
    expect(output).toEqual([JSON.stringify({ ok: true, status: 200, check: "publishing endpoint" })]); expect(fakeProcess.exitCode).toBe(0);
    expect(JSON.stringify({ command: endpoint.command, calls: endpoint.calls, receipts: endpoint.scopeReceipts, output })).not.toContain("synthetic-deployment-value");
  } finally { await endpoint.close(); }
});
it("actual endpoint rejects unauthorized scope and wrong cwd without emitting a successful receipt", async () => {
  const f = await fixture(), endpoint = await secretTestEndpoint(f.ctx, "morgan", "synthetic-deployment-value", "DEPLOYMENT_API_KEY", { boundSecretId: "bound", unrelatedCompanyKey: "unrelated-company-key", instanceKey: "custody_probe" }, { taskBound: true });
  const token = `synthetic.${Buffer.from(JSON.stringify({ sub: "morgan", company_id: "company", run_id: f.run.id })).toString("base64url")}.fixture`;
  const statuses: number[] = [], output: string[] = [];
  let deniedStatus = 200;
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => new Response(JSON.stringify(url.pathname === "/api/agents/me" ? { id: "morgan", companyId: "company" } : url.pathname === "/api/agents/me/secrets" ? { secrets: [{ key: "deployment-api-key", secretRef: "bound" }] } : {}), { status: url.pathname.endsWith("/value") ? deniedStatus : 200 })));
  const invoke = (cwd: string) => handlers[0]!({ headers: { authorization: "Bearer synthetic-deployment-value", "x-paperclip-agent": "morgan", "x-paperclip-run": f.run.id, "x-paperclip-task": "task", "x-paperclip-cwd": cwd, "x-paperclip-runtime": token }, method: "GET", url: "/publishing-check" }, { writeHead: (status: number) => statuses.push(status), end: (text: string) => output.push(text) });
  try {
    await invoke(f.cwd); expect(statuses.at(-1)).toBe(403);
    deniedStatus = 403; await invoke(path.dirname(f.cwd)); expect(statuses.at(-1)).toBe(403);
    await invoke(f.cwd); expect(statuses.at(-1)).toBe(200);
    expect(endpoint.scopeReceipts.at(-1)).toMatchObject({ taskId: "task", workspaceId: "workspace", taskWorkspaceMatched: true, companyDeniedStatus: 403, instanceDeniedStatus: 403 });
    expect(f.privateSecrets).toContain(token);
    expect(JSON.stringify({ calls: endpoint.calls, receipts: endpoint.scopeReceipts, output })).not.toContain(token);
    expect(JSON.stringify({ calls: endpoint.calls, receipts: endpoint.scopeReceipts, output })).not.toContain("synthetic-deployment-value");
  } finally { await endpoint.close(); }
});
