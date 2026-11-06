import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { checks, type Entity } from "./internal-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime } from "./runtime-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
type Artifact = Awaited<ReturnType<typeof readRegisteredArtifacts>>[number];
async function settled(ctx: ChatCatalogContext, count: number) {
  return pollUntil({ label: `Controller continuity phase ${count}`, deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000),
    load: async () => { await ctx.refreshIssue(); return { issue: ctx.issue(), runs: await ctx.allRuns() }; },
    accept: ({ issue, runs }) => chatCatalogNativePhaseIsTimely(ctx) && (issue?.conversationState === "waiting" && runs.length === count && runs.every(run => run.status === "succeeded")),
    reject: ({ runs }) => runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "A continuity provider turn failed" : undefined });
}
export async function currentControllerFile(ctx: ChatCatalogContext, name: string) {
  const root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT; if (!root) throw new Error("Continuity inspection requires the isolated attempt root");
  await ctx.refreshIssue(); const source = ctx.issue();
  if (!source) throw new Error("Continuity file inspection requires its actual source");
  const issue = await ctx.input.api.get<{ companyId: string; executionWorkspaceId: string | null }>(`/api/issues/${source.id}`);
  const { workspace } = await ctx.input.api.get<{ workspace: { id: string; companyId: string; cwd: string } }>(`/api/issues/${source.id}/workspace`);
  if (issue.companyId !== ctx.input.fixtures.company.id || workspace.companyId !== issue.companyId
    || workspace.id !== issue.executionWorkspaceId) throw new Error("Continuity workspace is not the actual same-company source binding");
  const home = await realpath(workspace.cwd);
  const isolated = await realpath(root);
  if (!home.startsWith(`${isolated}${path.sep}`) || path.basename(name) !== name) throw new Error("Continuity file escapes its owned fixture directory");
  const filename = await realpath(path.join(home, name));
  if (path.dirname(filename) !== home) throw new Error("Continuity file escapes its actual source binding");
  return readFile(filename, "utf8");
}
export function gradeControllerRestart(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("actual-restart-continuity-evidence", !!o, "Native prior work, real controller restart, retained bytes and run-attributed final artifact are required."); if (!o) return c.result();
  const before = o.state.initialArtifact as Artifact | undefined; const final = o.state.finalArtifact as Artifact | undefined;
  c.add("real-prior-file-survives-restart", !!before?.contentVerified && typeof o.state.fileBeforeRestart === "string"
    && o.state.fileBeforeRestart === before.content && o.state.fileAfterRestart === o.state.fileBeforeRestart
    && o.state.restarted === true, "The actual provider-written file bytes survive the supported controller restart unchanged.");
  c.add("prior-instruction-and-content-retained", !!final?.contentVerified && final.content.includes(String(o.state.headerMarker))
    && final.content.includes("hello@acorn.example") && /contact/i.test(final.content)
    && !before?.content.includes("hello@acorn.example") && o.state.finalFile === final.content,
    "The final saved website retains the unpredictable original header and follows the prior persisted contact-section instruction.");
  c.add("one-eligible-continuation", o.tasks.length === 0 && o.runs.length === 2 && o.runs.every(run => run.agentId === o.leadId && run.status === "succeeded")
    && o.runs.filter(run => run.id !== o.state.initialRunId).length === 1,
    "One ordinary continuation follows the explicit user request without duplicate execution tasks or replayed side effects.");
  c.add("source-and-history-retained", o.state.sourceIssueBefore === o.state.sourceIssueAfter && o.state.priorHistoryRetained === true,
    "The same conversation and genuine prior messages survive the controller restart.");
  c.add("actual-final-download-resource", !!final?.contentVerified && typeof final.attachmentId === "string" && !!final.attachmentId
    && typeof final.workProductId === "string" && !!final.workProductId,
    "The final work has a genuine run-attributed downloadable attachment and registered work product; its UI is verified separately.");
  return c.result();
}
export const runtimeRecoveryCases = [runtimeDefinition("recovery.controller-restart", async ctx => {
  if (ctx.input.execution.environment.id !== "local") throw new Error("Owned-file controller continuity fixture requires the actual local runtime");
  const headerMarker = `Retained Acorn header ${ctx.input.nonce}`; const filename = `website-${ctx.input.nonce}.html`;
  await sendChatMessage(ctx.input.page,
    `Start a small website draft in ${filename} in your current working directory, with a single header containing exactly ${JSON.stringify(headerMarker)}. Register that real file as a downloadable artifact work product titled ${filename}. This is a draft: do not add the contact section yet. Remember this instruction for when I ask to continue: keep the existing header and file, then add a contact section containing hello@acorn.example and register the final file as a new artifact from that continuation. Do this within our current conversation; no project, delegated task or external action is needed.`, chatCatalogNativePhaseRemainingBudget(ctx));
  const first = await settled(ctx, 1); const source = ctx.issue()!;
  const [initialArtifact] = await readRegisteredArtifacts(ctx.input.api, source.id, first.runs[0]!.id, [filename]);
  const fileBeforeRestart = await currentControllerFile(ctx, filename);
  if (fileBeforeRestart !== initialArtifact!.content) throw new Error("Initial downloadable artifact does not match the actual saved draft file");
  const priorHistory = await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`);
  const url = ctx.input.page.url();
  await ctx.input.restart();
  await ctx.input.page.goto(url, { waitUntil: "commit", timeout: 60_000 });
  await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible({ timeout: 60_000 });
  await ctx.refreshIssue();
  const afterHistory = await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`);
  return { headerMarker, filename, initialArtifact, initialRunId: first.runs[0]!.id, fileBeforeRestart,
    fileAfterRestart: await currentControllerFile(ctx, filename), restarted: true, sourceIssueBefore: source.id, sourceIssueAfter: ctx.issue()?.id,
    priorHistoryRetained: priorHistory.every(prior => afterHistory.some(row => row.id === prior.id && row.body === prior.body && row.createdByRunId === prior.createdByRunId)) };
}, gradeControllerRestart, {
  setupHumanMessageCount: 1, expectedHumanMessageCount: 2, expectedRunCount: 2, attemptTimeoutMs: 600_000,
  async observe(ctx, state) {
    const runs = await ctx.allRuns(); const source = ctx.issue();
    const final = runs.find(run => run.id !== state.initialRunId && run.status === "succeeded");
    if (source && final) {
      const [artifact] = await readRegisteredArtifacts(ctx.input.api, source.id, final.id, [String(state.filename)]);
      state.finalArtifact = artifact; state.finalFile = await currentControllerFile(ctx, String(state.filename));
    }
    return observeRuntime(ctx, state);
  },
  async verifyResult(ctx, state, value) {
    const o = runtimeObservation(value); const artifact = state.finalArtifact as Artifact;
    if (!o || !artifact) throw new Error("No actual final continuation artifact");
    const href = o.links.find(link => { const url = new URL(link, o.origin); return url.origin === new URL(o.origin).origin
      && url.pathname === `/api/attachments/${artifact.attachmentId}/content`; });

    // HTML attachments use the production download policy. Verify the actual
    // human result control and download, not merely an API registration row.
    const downloadPromise = ctx.input.page.waitForEvent("download");
    if (href) await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).last().click();
    else await ctx.input.page.goto(new URL(`/api/attachments/${artifact.attachmentId}/content?download=1`, o.origin).href).catch(error => {
      if (!/Download is starting|net::ERR_ABORTED/i.test(String(error))) throw error;
    });
    const download = await downloadPromise;
    if (download.suggestedFilename() !== state.filename) throw new Error("The visible result downloaded a different file");
    await ctx.input.evidence("runtime-controller-final-download.json", { attachmentId: artifact.attachmentId, filename: download.suggestedFilename(), sha256: artifact.sha256 });
  },
})];
