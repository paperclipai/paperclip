import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { pollUntil } from "../api.js";
import { dropChatSendAcknowledgement } from "../lost-send.js";
import type { ChatQueryAttachmentReceipt } from "../chat-query-attachments.js";
import { checks, sameTask, type Entity } from "./internal-support.js";
import { openStandingChat } from "./identity-support.js";
import { runtimeDefinition, runtimeWorker, runtimeObservation, observeRuntime } from "./runtime-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
type Interception = Awaited<ReturnType<typeof dropChatSendAcknowledgement>>;
const interceptions = new WeakMap<ChatCatalogContext, Interception>();
interface DraftComment extends Entity { clientRequestId?: string }
const editor = (ctx: ChatCatalogContext) => ctx.input.page.getByTestId("task-chat-composer-input").last().locator('[contenteditable="true"], textarea').first();
async function draftText(ctx: ChatCatalogContext) {
  return editor(ctx).evaluate(node => "value" in node ? String(node.value) : node.textContent ?? "");
}
export function gradePreserveDraft(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("real-draft-and-upload-evidence", !!o, "The unsent editor text, completed upload, source comment and actual transport receipt are independently required."); if (!o) return c.result();
  const attachment = o.state.briefAttachment as ChatQueryAttachmentReceipt;
  const sourceComments = o.state.sourceComments as DraftComment[] | undefined;
  const transport = o.state.transport as { commentId?: string; replayedCommentId?: string; clientRequestId?: string } | undefined;
  const human = sourceComments?.filter(row => !row.authorAgentId);
  c.add("draft-survived-switch-and-reload", o.state.restoredDraft === o.state.originalQuery && o.state.restoredAttachmentVisible === true
    && o.state.beforeSendHumanCount === 0 && o.state.otherTaskDraftIsolated === true && o.state.otherTaskAttachmentsEmpty === true,
    "The correct source retains the exact unsent text and completed upload while the other task receives neither.");
  const canonical = human?.find(row => row.id === transport?.commentId);
  const savedAttachment = o.state.savedAttachment as ChatQueryAttachmentReceipt | undefined;
  c.add("one-message-with-original-upload", human?.length === 1 && !!canonical && !!attachment && savedAttachment?.id === attachment.id
    && savedAttachment.issueCommentId === canonical.id && savedAttachment.issueId === o.state.sourceIssueId
    && savedAttachment.companyId === o.companyId && savedAttachment.createdByUserId === canonical.authorUserId
    && savedAttachment.createdByAgentId == null && savedAttachment.sha256 === o.state.briefHash,
    "One actual human send carries the exact human-owned upload receipt for this source and company.");
  c.add("actual-file-bytes-retained", o.state.downloadedBrief === o.state.briefBody && typeof o.state.briefBody === "string"
    && createHash("sha256").update(o.state.briefBody).digest("hex") === savedAttachment?.sha256,
    "Independent production download bytes match the original brief and receipt hash.");
  const requestRuns = transport ? o.runs.filter(run => run.contextSnapshot?.wakeCommentId === transport.commentId
    || Array.isArray(run.contextSnapshot?.wakeCommentIds) && run.contextSnapshot.wakeCommentIds.includes(transport.commentId)) : [];
  c.add("uncertain-send-reconciled-without-duplication", !!transport?.commentId && transport.commentId === transport.replayedCommentId
    && !!transport.clientRequestId && sourceComments?.filter(row => row.clientRequestId === transport.clientRequestId).map(row => row.id).join() === transport.commentId
    && requestRuns.length === 1 && o.state.persistedCommentReviewedBeforeReplay === true,
    "A real lost acknowledgement is reconciled against the persisted comment before an exact client-request replay; one request-bound run remains.");
  c.add("other-task-unchanged", !!o.state.otherTask && sameTask(o.state.otherTask as Entity, o.tasks.find(row => row.id === (o.state.otherTask as Entity).id)),
    "Draft navigation and the later send do not mutate the unrelated task.");
  return c.result();
}
export const runtimeSteeringCases = [runtimeDefinition("steering.preserve-draft", async ctx => {
  const worker = await runtimeWorker(ctx); const source = await openStandingChat(ctx);
  await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(editor(ctx)).toBeVisible();
  const otherTask = await ctx.input.api.post<Entity>(`/api/companies/${ctx.input.fixtures.company.id}/issues`, { title: "Unrelated draft-isolation task", status: "backlog" });
  const sourceUrl = ctx.input.page.url(); const filename = "website-brief.md";
  const briefBody = `# Website brief\nUse short copy, an accessible single-page layout, and a contact section. Product reference: ${ctx.input.nonce}.\n`;
  await editor(ctx).fill(ctx.scenario.query);
  await ctx.input.page.locator('input[type="file"]').first().setInputFiles({ name: filename, mimeType: "text/markdown", buffer: Buffer.from(briefBody) });
  const briefAttachment = await pollUntil({ label: "Completed public brief upload before unsent navigation", deadlineAt: Date.now() + 30_000,
    load: () => ctx.input.api.get<ChatQueryAttachmentReceipt[]>(`/api/issues/${source.id}/attachments`),
    accept: rows => rows.filter(row => row.originalFilename === filename).length === 1 });
  const receipt = briefAttachment.find(row => row.originalFilename === filename)!;
  await expect(ctx.input.page.getByTestId("task-chat-composer-attachments")).toContainText(filename);
  await expect(ctx.input.page.getByTestId("task-chat-composer-attachments")).not.toContainText("Uploading");
  await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${otherTask.identifier ?? otherTask.id}`, { waitUntil: "domcontentloaded" });
  await expect(editor(ctx)).toBeVisible(); await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
  await expect(editor(ctx)).toBeVisible();
  const otherTaskDraftIsolated = (await draftText(ctx)) !== ctx.scenario.query;
  const otherTaskAttachmentsEmpty = (await ctx.input.api.get<Entity[]>(`/api/issues/${otherTask.id}/attachments`)).length === 0
    && !(await ctx.input.page.getByTestId("task-chat-composer-attachments").isVisible());
  await ctx.input.page.goto(sourceUrl, { waitUntil: "domcontentloaded" });
  await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(editor(ctx)).toBeVisible();
  await expect.poll(() => draftText(ctx)).toBe(ctx.scenario.query);
  const restoredDraft = await draftText(ctx);
  await expect(ctx.input.page.getByTestId("task-chat-composer-attachments")).toContainText(filename);
  const before = await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`);
  interceptions.set(ctx, await dropChatSendAcknowledgement(ctx.input.page, ctx.scenario.query));
  return { worker, otherTask, sourceIssueId: source.id, originalQuery: ctx.scenario.query, restoredDraft,
    restoredAttachmentVisible: true, otherTaskDraftIsolated, otherTaskAttachmentsEmpty, beforeSendHumanCount: before.filter(row => !row.authorAgentId).length,
    briefAttachment: receipt, briefBody, briefHash: createHash("sha256").update(briefBody).digest("hex") };
}, gradePreserveDraft, {
  authentication: "human-session", queryAttachments: [{ stateKey: "briefAttachment", filename: "website-brief.md" }],
  sourceFiles: ["chat-catalog-domains/runtime-steering.ts", "chat-catalog-domains/runtime-support.ts", "lost-send.ts", "chat-scenarios/steering.yaml"],
  expectedRunCount: 3, minimumRunCount: 1, attemptTimeoutMs: 540_000,
  runPolicy: { kind: "source-settled-with-active-work", maximumActiveWorkerRuns: 1 },
  async act(ctx, state) {
    const interception = interceptions.get(ctx); if (!interception) throw new Error("Lost-ack draft fixture is not armed");
    const sent = await interception.committed;
    const comment = await ctx.input.api.get<DraftComment>(`/api/issues/${state.sourceIssueId}/comments/${sent.commentId}`);
    if (comment.id !== sent.commentId || comment.clientRequestId !== sent.data.clientRequestId) throw new Error("Uncertain send was not reconciled with its actual persisted comment");
    state.persistedCommentReviewedBeforeReplay = true;
    await interception.dispose(); interceptions.delete(ctx);
    const replayed = await ctx.input.api.post<{ id: string }>(sent.path, sent.data);
    state.transport = { commentId: sent.commentId, replayedCommentId: replayed.id, clientRequestId: String(sent.data.clientRequestId) };
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    const source = String(state.sourceIssueId);
    state.sourceComments = await ctx.input.api.get<DraftComment[]>(`/api/issues/${source}/comments?order=asc`);
    const attachment = (await ctx.input.api.get<ChatQueryAttachmentReceipt[]>(`/api/issues/${source}/attachments`)).find(row => row.id === (state.briefAttachment as ChatQueryAttachmentReceipt).id);
    state.savedAttachment = attachment;
    if (attachment) state.downloadedBrief = Buffer.from(await ctx.input.api.getAttachmentContent(attachment.id)).toString("utf8");
    return observeRuntime(ctx, state);
  },
  async verifyResult(ctx, state) {
    const transport = state.transport as { commentId: string }; const receipt = state.savedAttachment as ChatQueryAttachmentReceipt;
    const rendered = ctx.input.page.locator(`[id=${JSON.stringify(`comment-${transport.commentId}`)}]`);
    await expect(rendered).toContainText(ctx.scenario.query);
    await expect(rendered.locator(`a[href=${JSON.stringify(receipt.contentPath)}]`).first()).toBeVisible();
  },
  async cleanup(ctx) { const interception = interceptions.get(ctx); interceptions.delete(ctx); await interception?.dispose(); },
})];
