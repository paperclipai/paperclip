import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { readFile, realpath, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import { enableTaskWorkspaceView, savedTaskWorkspace } from "./runtime-workspaces.js";
import { runtimeDefinition, runtimeObservation, observeRuntime } from "./runtime-support.js";
import type { WorkspaceRuntimeService } from "../../../packages/shared/src/types/workspace-runtime.js";
import type { WorkspaceOperation } from "../../../packages/shared/src/types/workspace-operation.js";
import type { IssueWorkProduct } from "../../../packages/shared/src/types/work-product.js";
interface PreviewWorkspace extends Entity { cwd: string; config: Record<string, unknown>; runtimeServices?: WorkspaceRuntimeService[] }
export function gradePreview(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("actual-preview-lifecycle-evidence", !!o, "Actual service identity, HTTP content, source output and subsequent startup failure must be independently observed."); if (!o) return c.result();
  const service = o.state.healthyService as WorkspaceRuntimeService | undefined; const workspace = o.state.workspace as PreviewWorkspace;
  const products = o.state.previewProducts as IssueWorkProduct[] | undefined;
  c.add("real-ready-service-correct-workspace", !!service && service.executionWorkspaceId === workspace.id && service.companyId === o.companyId
    && service.status === "running" && service.healthStatus === "healthy" && service.serviceName === "Website preview"
    && o.state.initialHttpStatus === 200 && o.state.initialHttpBody === o.state.websiteBytes
    && typeof o.state.initialHttpBody === "string" && o.state.initialHttpBody.includes(String(o.state.marker)) && o.state.browserPreviewVisible === true,
  "A real managed Website preview serves the actual provider-written website bytes in the intended workspace and is usable in the browser.");
  c.add("accessible-registered-preview", !!service?.url && Array.isArray(products) && products.some(row => row.executionWorkspaceId === workspace.id
    && row.runtimeServiceId === service.id && row.url === service.url && ["preview_url", "runtime_service"].includes(row.type)
    && o.runs.some(run => run.id === row.createdByRunId && run.agentId === o.leadId))
    && (o.state.queryLinks as string[] | undefined)?.includes(service.url) === true,
  "The actual canonical reply exposes the ready endpoint and its run-attributed work product is tied to this exact workspace/service.");
  const failure = o.state.failureOperation as WorkspaceOperation | undefined; const reply = String(o.state.failureReply ?? "");
  c.add("startup-failure-exposed-actionably", !!failure && failure.status === "failed" && failure.executionWorkspaceId === workspace.id
    && (o.state.failureRunIds as string[] | undefined)?.includes(failure.heartbeatRunId ?? "") === true
    && o.state.failedHttpReachable === false && /fail|error|could not|couldn't|did not start|not running/i.test(reply)
    && /start|process|server|preview|exit/i.test(reply) && !/preview (?:is|has) (?:now )?(?:ready|running)|successfully restart/i.test(reply),
  "A separate explicit restart really fails under the fixture's process-start fault; its own answer preserves the failure and repair context.");
  c.add("no-unrelated-work-or-publication", o.tasks.length === 1 && o.tasks[0]?.id === (o.state.task as Entity).id
    && o.runs.length === 3 && o.runs.every(run => run.status === "succeeded"),
  "The prepared website plus two explicit controller turns are the only native work; no remote deployment or extra task is substituted.");
  return c.result();
}
export const runtimePreviewCases = [runtimeDefinition("workspaces.preview-service", async ctx => {
  if (ctx.input.execution.environment.id !== "local") throw new Error("Owned loopback website preview fixture requires the actual local target");
  await enableTaskWorkspaceView(ctx);
  const state = await savedTaskWorkspace(ctx, { html: true }); const cwd = await realpath(state.workspaceBefore.workspace.cwd);
  const root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!root || !cwd.startsWith(`${await realpath(root)}${path.sep}`)) throw new Error("Preview fixture escaped the isolated task directory");
  const websiteBytes = await readFile(path.join(cwd, "index.html"), "utf8");
  if (!/<html|<!doctype html/i.test(websiteBytes) || !websiteBytes.includes(state.marker)) throw new Error("Actual native website prerequisite is not present");
  const failureFlag = path.join(cwd, "preview-start-failure.fixture"); const script = path.join(cwd, "preview-server.cjs");
  await writeFile(script, `const fs=require('node:fs');const http=require('node:http');const path=require('node:path');if(fs.existsSync(path.join(__dirname,'preview-start-failure.fixture'))){console.error('Owned preview startup fixture failed with exit 17');process.exit(17)}const body=fs.readFileSync(path.join(__dirname,'index.html'));http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(body)}).listen(Number(process.argv[2]),'127.0.0.1');`, "utf8");
  const workspace = await ctx.input.api.get<PreviewWorkspace>(`/api/execution-workspaces/${state.workspaceBefore.workspace.id}`);
  await ctx.input.api.patch(`/api/execution-workspaces/${workspace.id}`, { config: { ...workspace.config, desiredState: "stopped", workspaceRuntime: { services: [{
    name: "Website preview", command: "node preview-server.cjs {{port}}", cwd: ".", port: { type: "auto" }, lifecycle: "shared", stopPolicy: { type: "manual" },
    readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 100 },
    expose: { type: "url", urlTemplate: "http://127.0.0.1:{{port}}" },
  }] } } });
  const saved = await ctx.input.api.get<PreviewWorkspace>(`/api/execution-workspaces/${workspace.id}`);
  if (saved.runtimeServices?.some(row => row.status === "running")) throw new Error("Preview setup must not start the target service");
  return { ...state, workspace: saved, websiteBytes, failureFlag };
}, gradePreview, {
  sourceFiles: ["chat-catalog-domains/runtime-preview.ts", "chat-catalog-domains/runtime-workspaces.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/workspaces.yaml"],
  expectedHumanMessageCount: 2, expectedRunCount: 3, attemptTimeoutMs: 720_000,
  async act(ctx, state) {
    await pollUntil({ label: "Actual canonical preview service readiness", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns(), workspace: await ctx.input.api.get<PreviewWorkspace>(`/api/execution-workspaces/${(state.workspace as Entity).id}`) }; },
      accept: value => chatCatalogNativePhaseIsTimely(ctx) && value.source?.conversationState === "waiting" && value.runs.length === 2 && value.runs.every(run => run.status === "succeeded")
        && value.workspace.runtimeServices?.some(service => service.status === "running" && service.healthStatus === "healthy") === true });
    const ws = await ctx.input.api.get<PreviewWorkspace>(`/api/execution-workspaces/${(state.workspace as Entity).id}`);
    const service = ws.runtimeServices?.find(row => row.serviceName === "Website preview" && row.status === "running")!;
    if (!service?.url) throw new Error("A created service record without an accessible ready endpoint is not a preview");
    const url = new URL(service.url); if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port) !== service.port) throw new Error("Preview endpoint escaped its owned loopback service");
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    state.initialHttpStatus = response.status; state.initialHttpBody = await response.text(); state.healthyService = service;
    const o = await observeRuntime(ctx, state); state.queryLinks = o.links;
    const products = [];
    for (const id of [(state.task as Entity).id, ctx.issue()!.id]) products.push(...await ctx.input.api.get<IssueWorkProduct[]>(`/api/issues/${id}/work-products`));
    state.previewProducts = products;
    const source = ctx.input.page.url(); await ctx.input.page.goto(service.url, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: String(state.marker), exact: true })).toBeVisible(); state.browserPreviewVisible = true;
    await ctx.input.capture("real-website-preview", "The actual provider-written website is served by the ready managed service", "runtime-website-preview.png");
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    const beforeRuns = (await ctx.allRuns()).map(run => run.id);
    const beforeOperations = (await ctx.input.api.get<WorkspaceOperation[]>(`/api/execution-workspaces/${ws.id}/workspace-operations`)).map(row => row.id);
    await writeFile(String(state.failureFlag), "Deliberate bounded owned process-start failure fixture", "utf8");
    await sendChatMessage(ctx.input.page, "Restart that same website preview now and tell me whether it actually comes back. If startup fails, keep that failure visible and explain the next repair step; do not claim a working preview.", chatCatalogNativePhaseRemainingBudget(ctx));
    const settled = await pollUntil({ label: "Explicit preview restart reports its genuine startup failure", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns(), operations: await ctx.input.api.get<WorkspaceOperation[]>(`/api/execution-workspaces/${ws.id}/workspace-operations`) }; },
      accept: value => chatCatalogNativePhaseIsTimely(ctx) && value.source?.conversationState === "waiting" && value.runs.length === 3 && value.runs.every(run => run.status === "succeeded")
        && value.operations.some(row => !beforeOperations.includes(row.id) && row.status === "failed") });
    const ids = settled.runs.filter(run => !beforeRuns.includes(run.id)).map(run => run.id); state.failureRunIds = ids;
    state.failureOperation = settled.operations.find(row => !beforeOperations.includes(row.id) && row.status === "failed" && ids.includes(row.heartbeatRunId ?? ""));
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
    state.failureReply = comments.filter(row => ids.includes(row.createdByRunId ?? "") && row.authorAgentId === ctx.input.fixtures.agent.id).map(row => row.body ?? "").join("\n");
    state.failedHttpReachable = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) }).then(async res => { await res.body?.cancel(); return res.ok; }, () => false);
  },
  observe: observeRuntime,
  async verifyResult(ctx, state) {
    const source = ctx.input.page.url(); const ws = state.workspace as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/execution-workspaces/${ws.id}`, { waitUntil: "domcontentloaded" });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: ws.name!, exact: true }).first()).toBeVisible();
    await expect(ctx.input.page.getByText(/failed|exit 17|startup/i).first()).toBeVisible();
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async cleanup(ctx, state) {
    try { if (state.workspace) await ctx.input.api.post(`/api/execution-workspaces/${(state.workspace as Entity).id}/runtime-services/stop`, {}); }
    finally { if (state.failureFlag) await unlink(String(state.failureFlag)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  },
})];
