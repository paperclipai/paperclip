import { expect } from "@playwright/test";
import { pollUntil } from "../api.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { checks, sameTask, type Entity } from "./internal-support.js";
import { runtimeDefinition, runtimeWorker, runtimeObservation, observeRuntime } from "./runtime-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
interface WorkspaceView { workspace: { id: string; companyId: string; projectId?: string | null; name: string; cwd: string }; repositories: unknown[] }
export async function enableTaskWorkspaceView(ctx: ChatCatalogContext) {
  await ctx.input.api.patch("/api/instance/settings/experimental", { enableIsolatedWorkspaces: true });
  const settings = await ctx.input.api.get<{ enableIsolatedWorkspaces: boolean }>("/api/instance/settings/experimental");
  if (settings.enableIsolatedWorkspaces !== true) throw new Error("The supported workspace view is not enabled");
}
export async function savedTaskWorkspace(ctx: ChatCatalogContext, options: { artifact?: boolean; workerName?: string; html?: boolean } = {}) {
  const { execution, fixtures, workspacePath, nonce, api } = ctx.input;
  const base = execution.profile.buildAgent({ environmentId: fixtures.environment.id, environmentFixtureId: execution.environment.id,
    workspacePath, secretRefs: fixtures.secretRefs, executionId: nonce });
  const { cwd: _cwd, ...taskConfig } = base.adapterConfig as Record<string, unknown>;
  const worker = await runtimeWorker(ctx, options.workerName ?? "Morgan", { adapterConfig: taskConfig });
  const company = `/api/companies/${fixtures.company.id}`;
  for (const scope of [{ scopeType: "company", scopeId: fixtures.company.id }, { scopeType: "agent", scopeId: worker.id }])
    await api.post(`${company}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
  const marker = `Saved website prerequisite ${nonce}`;
  const previousRuns = await ctx.allRuns();
  const task = await api.post<Entity>(`${company}/issues`, { title: "Website task", status: "todo", assigneeAgentId: worker.id,
    description: `Create a local file website-fixture.txt containing exactly ${JSON.stringify(marker)} in your admitted task workspace. ${options.html ? `Also save index.html as a semantic HTML page with that same visible reference in an h1 and a short Acorn product paragraph. Do not start any preview server yet.` : ""} Save a brief task document as evidence, ${options.artifact ? "register the actual website-fixture.txt file as a downloadable artifact work product titled website-fixture.txt," : ""} then complete this fixture task normally. Do not create a project, repository, another task, or remote side effect.` });
  await pollUntil({ label: "Real projectless website fixture completion", deadlineAt: Date.now() + 180_000,
    load: async () => ({ task: await api.get<Entity>(`/api/issues/${task.id}`), runs: (await ctx.allRuns()).filter(run => !previousRuns.some(prior => prior.id === run.id)) }),
    accept: value => value.task.status === "done" && value.runs.length === 1 && value.runs.every(run => run.status === "succeeded"),
    reject: value => value.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Projectless prerequisite provider run failed" : undefined });
  const view = await api.get<WorkspaceView>(`/api/issues/${task.id}/workspace`);
  const file = await api.get<{ resource?: { workspaceKind?: string }; content?: { data?: string } }>(`/api/issues/${task.id}/file-resources/content?workspace=execution&path=website-fixture.txt`);
  if (view.workspace.projectId || file.resource?.workspaceKind !== "execution_workspace" || file.content?.data?.trim() !== marker)
    throw new Error("Projectless fixture has no actual task-bound saved file");
  const fixtureRunId = (await ctx.allRuns()).find(run => !previousRuns.some(prior => prior.id === run.id))!.id;
  const [artifact] = options.artifact ? await readRegisteredArtifacts(api, task.id, fixtureRunId, ["website-fixture.txt"]) : [];
  return { worker, task: await api.get<Entity>(`/api/issues/${task.id}`), workspaceBefore: view, marker, artifact,
    fileBefore: file.content.data, fixtureRunId };
}
export function gradeLocateFiles(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("actual-task-workspace-evidence", !!o, "The actual admitted binding, file bytes and setup run identity are independently required."); if (!o) return c.result();
  const before = o.state.workspaceBefore as WorkspaceView | undefined; const after = o.state.workspaceAfter as WorkspaceView | undefined;
  const task = o.state.task as Entity | undefined;
  c.add("same-projectless-task-binding", !!before?.workspace?.id && !!after && before.workspace.id === after.workspace.id
    && before.workspace.cwd === after.workspace.cwd && after.workspace.companyId === o.companyId && after.workspace.projectId == null
    && !!task && sameTask(task, o.tasks.find(row => row.id === task.id)), "The correct projectless binding persists without reassigning or changing the task.");
  c.add("concrete-authorized-location", !!after && (o.reply.includes(after.workspace.cwd) || o.reply.includes(after.workspace.id)),
    "The answer identifies the actual bound workspace rather than inferring an agent default or project directory.");
  c.add("actual-saved-files-retained", o.state.fileAfter === o.state.fileBefore && typeof o.state.fileBefore === "string"
    && o.state.fileBefore.trim() === o.state.marker && o.runs.some(run => run.id === o.state.fixtureRunId && run.agentId === (o.state.worker as Entity).id
      && run.status === "succeeded"), "A genuine worker created the prerequisite file and it remains unchanged.");
  const resultLinks = workspaceResultLinks(o.reply, o.links);
  c.add("supported-workspace-view-guidance", (/workspace|files? (?:view|tab|panel)/i.test(o.reply)
    || !!after && resultLinks.some(href => workspaceLink(o.origin, href, after.workspace.id, String(o.state.companyPrefix))))
    && !!after && resultLinks.filter(href => { try { return new URL(href, o.origin).pathname.includes("/execution-workspaces/"); } catch { return false; } })
      .every(href => workspaceLink(o.origin, href, after.workspace.id, String(o.state.companyPrefix))),
    "The response points to the supported workspace view; any workspace link it does give must identify the actual bound workspace.");
  return c.result();
}
export function workspaceResultLinks(reply: string, rendered: string[]) {
  return [...new Set([...rendered, ...Array.from(reply.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g), match => match[1]!)])];
}
export function workspaceLink(origin: string, href: string, id: string, prefix: string) {
  try { const url = new URL(href, origin); const parts = url.pathname.split("/").map(decodeURIComponent); const at = parts.indexOf("execution-workspaces");
    return url.origin === new URL(origin).origin && at === 2 && parts[1] === prefix && parts[at + 1] === id
      && (parts.length === 4 || parts.length === 5 && ["services", "configuration", "runtime-logs", "issues", "routines"].includes(parts[4]!)); } catch { return false; }
}
export const runtimeWorkspacesCases = [runtimeDefinition("workspaces.locate-files", async ctx => {
  // The actual detail route is gated, independently of workspace realization.
  // Enable its supported UI fixture before the query, never after a bad link.
  if (!ctx.input.fixtures.company.issuePrefix) throw new Error("Workspace fixture has no public company prefix");
  await enableTaskWorkspaceView(ctx);
  return { ...await savedTaskWorkspace(ctx), companyPrefix: ctx.input.fixtures.company.issuePrefix };
}, gradeLocateFiles, {
  sourceFiles: ["chat-catalog-domains/runtime-workspaces.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/workspaces.yaml", "../../ui/src/components/IsolatedWorkspacesRouteGate.tsx", "../../ui/src/pages/ExecutionWorkspaceDetail.tsx"],
  expectedRunCount: 2, attemptTimeoutMs: 540_000,
  async observe(ctx, state) {
    const id = (state.task as Entity).id;
    state.workspaceAfter = await ctx.input.api.get<WorkspaceView>(`/api/issues/${id}/workspace`);
    const file = await ctx.input.api.get<{ content: { data: string } }>(`/api/issues/${id}/file-resources/content?workspace=execution&path=website-fixture.txt`);
    state.fileAfter = file.content.data;
    return observeRuntime(ctx, state);
  },
  async verifyResult(ctx, state, value) {
    const o = runtimeObservation(value); if (!o) throw new Error("Workspace result missing");
    const view = state.workspaceAfter as WorkspaceView;
    const prefix = state.companyPrefix;
    if (typeof prefix !== "string" || !prefix) throw new Error("Workspace view lost its actual company prefix");
    const links = workspaceResultLinks(o.reply, o.links);
    if (links.some(link => { try { return new URL(link, o.origin).pathname.includes("/execution-workspaces/")
      && !workspaceLink(o.origin, link, view.workspace.id, prefix); } catch { return false; } }))
      throw new Error("The actual reply supplied an incorrect workspace link");
    const href = links.find(link => workspaceLink(o.origin, link, view.workspace.id, prefix));
    const source = ctx.input.page.url();
    if (href) await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first().click();
    else await ctx.input.page.goto(`/${prefix}/execution-workspaces/${view.workspace.id}`, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page).toHaveURL(new RegExp(`/${prefix}/execution-workspaces/${view.workspace.id}(?:[/?#]|$)`));
    await expect(ctx.input.page.getByRole("heading", { name: view.workspace.name, exact: true }).first()).toBeVisible();
    await ctx.input.evidence("runtime-task-workspace-opened.json", { taskId: (state.task as Entity).id, workspaceId: view.workspace.id, url: ctx.input.page.url() });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
})];
