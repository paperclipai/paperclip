import { expect } from "@playwright/test";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { openStandingChat } from "./identity-support.js";
import { checks, sameTask, type Entity } from "./internal-support.js";
import { enableTaskWorkspaceView, savedTaskWorkspace } from "./runtime-workspaces.js";
import { runtimeDefinition, runtimeObservation, observeRuntime } from "./runtime-support.js";
type Artifact = Awaited<ReturnType<typeof readRegisteredArtifacts>>[number];
interface Workspace extends Entity { sourceIssueId?: string | null; rootIssueId?: string | null; cwd?: string; repoUrl?: string | null; branchName?: string | null; closedAt?: string | null }
export function gradeWorkspaceClosure(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("real-closure-retention-evidence", !!o, "Actual lifecycle, source references and independently downloaded retained file bytes are required."); if (!o) return c.result();
  const before = o.state.closingWorkspace as Workspace | undefined; const after = o.state.closedWorkspace as Workspace | undefined;
  const artifact = o.state.retainedArtifact as Artifact | undefined; const prior = o.state.artifact as Artifact | undefined;
  c.add("permitted-actual-workspace-closed", !!before && !!after && before.id === after.id && after.companyId === o.companyId
    && after.status === "archived" && !!after.closedAt && o.state.closeReadyBeforeQuery === true
    && o.activity.some(row => row.action === "execution_workspace.updated" && row.entityId === after.id && row.agentId === o.leadId
      && (row.details?.changedKeys as string[] | undefined)?.includes("status")),
  "The permitted model operation closes the exact genuinely eligible task workspace and has independent agent attribution.");
  c.add("promised-work-retained-and-readable", !!prior?.contentVerified && !!artifact?.contentVerified && artifact.attachmentId === prior.attachmentId
    && artifact.workProductId === prior.workProductId && artifact.sha256 === prior.sha256 && artifact.content === o.state.fileBefore
    && artifact.content.trim() === o.state.marker,
  "The actual promised saved file remains accessible with unchanged downloaded bytes and original artifact provenance after closure.");
  c.add("source-history-and-other-workspaces-preserved", !!before && !!after && ["sourceIssueId", "rootIssueId", "repoUrl", "branchName"].every(key => before[key as keyof Workspace] === after[key as keyof Workspace])
    && o.tasks.length === 2 && sameTask(o.state.task as Entity, o.tasks.find(row => row.id === (o.state.task as Entity).id))
    && o.state.otherWorkspacesUnchanged === true && o.state.otherFileRetained === true
    && o.runs.length === 4 && o.runs.every(run => run.status === "succeeded"),
  "Closure retains the task and source records, does not cancel prior execution or affect a separate workspace.");
  c.add("honest-supported-retrieval", /closed|archiv/i.test(o.reply) && /reopen|retriev|download|artifact|attachment|saved (?:file|work)/i.test(o.reply)
    && !/deleted (?:all|the).*files|force.?reconcil|merged.*branch|cancelled.*other/i.test(o.reply),
  "The reply reports the actual closed state and supported file retrieval without claiming deletion, forced reconciliation or unrelated cancellation.");
  return c.result();
}
export const runtimeWorkspaceClosureCases = [runtimeDefinition("workspaces.close-and-reopen", async ctx => {
  await enableTaskWorkspaceView(ctx);
  const state = await savedTaskWorkspace(ctx, { artifact: true }); const id = state.workspaceBefore.workspace.id;
  const other = await savedTaskWorkspace(ctx, { workerName: "Riley" });
  await ctx.input.api.patch(`/api/issues/${other.task.id}`, { title: "Unrelated retained notes" });
  const closingWorkspace = await ctx.input.api.get<Workspace>(`/api/execution-workspaces/${id}`);
  const readiness = await ctx.input.api.get<{ state: string }>(`/api/execution-workspaces/${id}/close-readiness`);
  if (!["ready", "ready_with_warnings"].includes(readiness.state)) throw new Error("Completed fixture is not genuinely eligible for supported workspace closure");
  await openStandingChat(ctx);
  await sendChatMessage(ctx.input.page, `For my next instruction, focus on the completed Website task ${state.task.identifier ?? state.task.id} and its exact execution workspace ${id}. Its saved website-fixture.txt must remain retrievable. The separate Unrelated retained notes task and its workspace belong to Riley and must stay untouched. Acknowledge the target only; do not close, reopen or change either workspace yet.`);
  await pollUntil({ label: "Native closure target context retained", deadlineAt: Date.now() + 150_000,
    load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
    accept: value => value.source?.conversationState === "waiting" && value.runs.length === 3 && value.runs.every(run => run.status === "succeeded") });
  const otherWorkspace = await ctx.input.api.get<Workspace>(`/api/execution-workspaces/${other.workspaceBefore.workspace.id}`);
  return { ...state, closingWorkspace, closeReadyBeforeQuery: true, otherTask: other.task, otherFileBefore: other.fileBefore, otherWorkspacesBefore: [otherWorkspace] };
}, gradeWorkspaceClosure, {
  sourceFiles: ["chat-catalog-domains/runtime-workspace-closure.ts", "chat-catalog-domains/runtime-workspaces.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/workspaces.yaml"],
  setupHumanMessageCount: 1, expectedHumanMessageCount: 2, expectedRunCount: 4, attemptTimeoutMs: 900_000,
  async observe(ctx, state) {
    const before = state.closingWorkspace as Workspace;
    state.closedWorkspace = await ctx.input.api.get<Workspace>(`/api/execution-workspaces/${before.id}`);
    [state.retainedArtifact] = await readRegisteredArtifacts(ctx.input.api, (state.task as Entity).id, String(state.fixtureRunId), ["website-fixture.txt"]);
    const inventory = await ctx.input.api.get<Workspace[]>(`/api/companies/${ctx.input.fixtures.company.id}/execution-workspaces`);
    state.otherWorkspacesUnchanged = (state.otherWorkspacesBefore as Workspace[]).every(prior => inventory.some(row => row.id === prior.id
      && row.status === prior.status && row.cwd === prior.cwd && row.sourceIssueId === prior.sourceIssueId && row.rootIssueId === prior.rootIssueId));
    const other = await ctx.input.api.get<{ content: { data: string } }>(`/api/issues/${(state.otherTask as Entity).id}/file-resources/content?workspace=execution&path=website-fixture.txt`);
    state.otherFileRetained = other.content.data === state.otherFileBefore;
    return observeRuntime(ctx, state);
  },
  async verifyResult(ctx, state) {
    const source = ctx.input.page.url(); const workspace = state.closedWorkspace as Workspace;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/execution-workspaces/${workspace.id}`, { waitUntil: "domcontentloaded" });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: workspace.name!, exact: true }).first()).toBeVisible();
    await expect(ctx.input.page.getByRole("button", { name: "Close workspace", exact: true })).toBeDisabled();
    const artifact = state.retainedArtifact as Artifact;
    const download = ctx.input.page.waitForEvent("download");
    await ctx.input.page.goto(`/api/attachments/${artifact.attachmentId}/content?download=1`).catch(error => {
      if (!/Download is starting|net::ERR_ABORTED/i.test(String(error))) throw error;
    });
    if ((await download).suggestedFilename() !== "website-fixture.txt") throw new Error("Closed workspace retrieval returned a different saved file");
    await ctx.input.evidence("runtime-closed-workspace-retained-file.json", { workspaceId: workspace.id, attachmentId: artifact.attachmentId, sha256: artifact.sha256 });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
})];
