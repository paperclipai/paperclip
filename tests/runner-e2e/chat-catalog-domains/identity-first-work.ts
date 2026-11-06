import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "@playwright/test";
import type { IssueAttachment } from "../../../packages/shared/src/types/issue.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, entity, hasLink, project, type Entity } from "./internal-support.js";
import { identityDefinition, identityObservation, identityWorker, observeIdentity, openStandingChat } from "./identity-support.js";

interface Website { attachment: IssueAttachment; body: string; sha256: string }
const folders = new WeakMap<ChatCatalogContext, string>();
async function actualWebsite(ctx: ChatCatalogContext, state: Record<string, unknown>) {
  const o = await observeIdentity(ctx, state); const files: Website[] = [];
  for (const task of o.tasks) {
    const attachments = await ctx.input.api.get<IssueAttachment[]>(`/api/issues/${task.id}/attachments`);
    for (const attachment of attachments.filter(row => row.contentType === "text/html" || /\.html?$/i.test(row.originalFilename ?? "")).slice(0, 3)) {
      if (attachment.byteSize > 1_048_576) continue;
      const bytes = await ctx.input.api.getAttachmentContent(attachment.id);
      files.push({ attachment, body: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  state.websites = files; return o;
}
export function gradeFirstWork(value: unknown) {
  const c = checks(); const o = identityObservation(value); c.add("complete-first-website-work", !!o, "Actual first request, ordinary linked execution, authorized artifact bytes and browser rendering are required."); if (!o) return c.result();
  const work = o.tasks[0]; const worker = entity(o.state, "worker"); const websites = o.state.websites as Website[] | undefined;
  const website = websites?.find(file => file.attachment.id === o.state.reviewedAttachmentId);
  c.add("actual-first-request-context", o.state.beforeSourceHumanComments === 0 && o.state.beforeSourceRuns === 0 && o.humanQueries.length === 1
    && o.humanQueries[0]?.trim() === "Make me a simple website introducing our business.", "The canonical request is the first real human instruction in this ready company's conversation.");
  c.add("separate-requested-ordinary-work", o.tasks.length === 1 && work?.companyId === o.companyId && work.assigneeAgentId === worker.id && work.id !== o.state.sourceId && work.parentId == null
    && work.status === "done" && hasLink(o, "issues", work) && /website|landing.page|web site/i.test(`${work.title} ${work.description}`)
    && /Acorn Notes/i.test(`${work.title} ${work.description}`) && o.state.sourceStillConversation === true
    && o.activity.some(row => row.action === "issue.created" && row.entityId === work.id && row.agentId === o.leadId), "The first chat captures the actual known business in one linked ordinary completed task; its standing conversation stays separate.");
  c.add("actual-run-attributed-website", !!work && !!website && website.attachment.issueId === work.id && website.attachment.companyId === o.companyId
    && website.sha256 === website.attachment.sha256 && website.attachment.createdByAgentId === worker.id
    && o.runs.some(run => run.id === website.attachment.originatingRunId && run.agentId === worker.id && run.status === "succeeded"
      && (run.contextSnapshot?.issueId === work.id || (run as unknown as { nativeIssueId?: string }).nativeIssueId === work.id))
    && /<html\b/i.test(website.body) && /<body\b/i.test(website.body) && /<h[1-6]\b/i.test(website.body)
    && /Acorn Notes/i.test(website.body) && /research|science/i.test(website.body), "Authorized exact HTML bytes match the immutable actual upload hash and originating worker run, introducing the real business rather than an empty onboarding task.");
  c.add("actual-review-and-usable-rendering", o.state.visibleArtifactName === true && o.state.renderedBusinessHeading === true && o.state.renderedBusinessDescription === true
    && o.state.renderedBytesMatch === true && o.state.renderedWithoutScriptExecution === true,
    "The real task link exposes its delivered file, and the exact downloaded HTML renders a visible business heading/description in an isolated browser with scripts disabled.");
  return c.result();
}
export const firstWorkIdentityCases: readonly ChatCatalogCase[] = [identityDefinition("onboarding.first-work", async ctx => {
  const source = await openStandingChat(ctx); const worker = await identityWorker(ctx);
  const p = await project(ctx, "Launch", { description: "Acorn Notes is a research notebook for small science teams. It helps teams capture observations, organize evidence and share research notes. Our business website should introduce these benefits and offer a contact link. No external publishing is requested." });
  const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments`);
  return { sourceId: source.id, worker, project: p, beforeSourceHumanComments: comments.filter(comment => comment.authorUserId).length, beforeSourceRuns: (await ctx.allRuns()).length };
}, gradeFirstWork, {
  authentication: "human-session", expectedRunCount: 3, minimumRunCount: 2, attemptTimeoutMs: 600_000,
  sourceFiles: ["chat-catalog-domains/identity-first-work.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/onboarding.yaml"],
  async act(ctx, state) {
    const o = await pollUntil({ label: "first real completed website and delivered HTML", deadlineAt: Date.now() + 360_000,
      load: () => actualWebsite(ctx, state), accept: current => current.tasks.length === 1 && current.tasks[0]?.status === "done" && (state.websites as Website[]).some(file => /Acorn Notes/i.test(file.body))
        && current.runs.every(run => run.status === "succeeded") && ctx.issue()?.conversationState === "waiting" });
    const work = o.tasks[0]!; const file = (state.websites as Website[]).find(file => /Acorn Notes/i.test(file.body))!; state.reviewedAttachmentId = file.attachment.id;
    const href = o.links.find(link => hasLink({ ...o, links: [link] }, "issues", work)); if (!href) throw new Error("First website has no actual task review link");
    const source = ctx.input.page.url(); await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first().click();
    if (!file.attachment.originalFilename) throw new Error("Delivered website has no visible file name");
    await expect(ctx.input.page.getByText(file.attachment.originalFilename, { exact: true }).first()).toBeVisible(); state.visibleArtifactName = true;
    const privateDir = process.env.PAPERCLIP_RUNNER_E2E_PRIVATE_DIR; if (!privateDir) throw new Error("Attempt-private output directory is required");
    const folder = await mkdtemp(path.join(privateDir, "identity-website-")); folders.set(ctx, folder);
    const filename = path.join(folder, "website.html"); const bytes = await ctx.input.api.getAttachmentContent(file.attachment.id);
    await writeFile(filename, bytes, { mode: 0o600 }); state.renderedBytesMatch = createHash("sha256").update(bytes).digest("hex") === file.sha256;
    const browser = ctx.input.page.context().browser(); if (!browser) throw new Error("Actual website rendering requires a browser");
    const isolated = await browser.newContext({ javaScriptEnabled: false });
    try {
      // No rewrite, fabricated server, or script execution: inspect the exact
      // authorized delivered artifact bytes through the browser's file loader.
      await isolated.route(/^https?:\/\//, route => route.abort()); const page = await isolated.newPage(); await page.goto(pathToFileURL(filename).href);
      await expect(page.getByRole("heading", { name: /Acorn Notes/i }).first()).toBeVisible(); state.renderedBusinessHeading = true;
      await expect(page.getByText(/research|science/i).first()).toBeVisible(); state.renderedBusinessDescription = true; state.renderedWithoutScriptExecution = true;
    } finally { await isolated.close(); }
    await ctx.input.evidence("identity-real-first-website.json", { taskId: work.id, attachmentId: file.attachment.id, originatingRunId: file.attachment.originatingRunId,
      sha256: file.sha256, visibleArtifactName: state.visibleArtifactName, renderedBusinessHeading: state.renderedBusinessHeading, renderedBusinessDescription: state.renderedBusinessDescription,
      artifactBytesRewritten: false, scriptsExecuted: false, externallyPublished: false });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) { const o = await actualWebsite(ctx, state); state.sourceStillConversation = ctx.issue()?.status === "in_review" && ctx.issue()?.assigneeAgentId === ctx.input.fixtures.agent.id && ctx.issue()?.conversationState === "waiting"; return o; },
  async cleanup(ctx) { const folder = folders.get(ctx); if (folder) await rm(folder, { recursive: true, force: true }); folders.delete(ctx); },
})];
