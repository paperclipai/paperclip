import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { parseIssueReferenceFromHref } from "../../../ui/src/lib/issue-reference.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { internalResultLink, entity, hasLink, observeInternal, type Entity, type InternalObservation } from "./internal-support.js";

const digest = (body: string) => createHash("sha256").update(body).digest("hex");
export function savedDesignInstruction(o: InternalObservation, body: string, design: Entity) {
  const valid: string[] = [];
  const reference = (href: string) => {
    let local = href;
    try {
      if (/^https?:/i.test(href)) {
        const url = new URL(href); if (url.origin !== new URL(o.origin).origin) return "{{OTHERREF}}";
        local = `${url.pathname}${url.search}${url.hash}`;
      }
      const segments = local.split(/[?#]/, 1)[0]!.split("/").filter(Boolean), issueAt = segments.indexOf("issues");
      if (design.identifier && issueAt > 0 && segments[issueAt - 1] !== design.identifier.split("-")[0]) return "{{OTHERREF}}";
    } catch { return "{{OTHERREF}}"; }
    const parsed = parseIssueReferenceFromHref(local, design.identifier ? new Set([design.identifier.split("-")[0]!]) : undefined);
    if (!parsed || !hasLink({ ...o, links: [parsed.href] }, "issues", design)) return "{{OTHERREF}}";
    const token = `{{DESIGNREF${valid.length}}}`; valid.push(token); return token;
  };
  const visibleSource = body.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, "");
  // Rendered-comment proof below is mandatory; lexical recognition alone never
  // proves that a Markdown or bare identifier became a visible, usable link.
  const text = visibleSource.replace(/\[[^\]]+\]\(<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\)/g, (_link, href: string) => reference(href))
    .replace(/\b[A-Z][A-Z0-9]*-\d+\b/gi, identifier => reference(identifier));
  if (!valid.length) return false;
  const directive = /\b(?:follow|use|adhere\s+to|implement\s+(?:according\s+to|in\s+line\s+with)|build\s+(?:according\s+to|in\s+line\s+with))\b/i;
  const negative = (prefix: string) => {
    const t = prefix.replace(/\b(?:do not|don't) forget to\b/gi, "remember to");
    return /\b(?:do not|don't|must not|should not|never|not to|not)\b[^{}.;!\n]{0,60}\b(?:follow|use|adhere|implement|build)\b[^{}.;!\n]{0,80}$/i.test(t)
      || /\b(?:avoid|ignore|disregard|stop)\b[^{}.;!\n]{0,80}$/i.test(t);
  };
  const clauses = text.split(/[.;!\n]+/).filter(clause => valid.some(token => clause.includes(token)));
  if (clauses.some(clause => valid.some(token => { const at = clause.indexOf(token); return at >= 0 && negative(clause.slice(0, at)); }))) return false;
  if (/\b(?:(?:do not|don't|never|must not|should not)\s+(?:follow|use|adhere\s+to)|ignore|disregard)\s+(?:it|this|that|the\s+(?:approved\s+)?design)\b/i.test(text)) return false;
  return clauses.some(clause => directive.test(clause) && valid.some(token => {
    const instruction = directive.exec(clause); return !!instruction && clause.indexOf(token) > instruction.index;
  }));
}
interface ReferenceProof { commentId: string; taskId: string; designId: string; bodySha256: string; href: string; visible: boolean; destinationMatched: boolean; publicReadMatched: boolean }
export function validRenderedCommentReference(o: InternalObservation, comment: Entity, design: Entity) {
  const proof = o.state.savedCommentReference as ReferenceProof | undefined;
  return !!proof && proof.commentId === comment.id && comment.issueId === proof.taskId && proof.taskId === entity(o.state, "task").id && proof.designId === design.id
    && proof.bodySha256 === digest(comment.body ?? "") && proof.visible === true && proof.destinationMatched === true && proof.publicReadMatched === true
    && hasLink({ ...o, links: [proof.href] }, "issues", design);
}
export const RENDERED_REPLY_WAIT_MS = 60_000;
/** Waits for every saved agent reply of the conversation to render; throws a named error otherwise. */
export async function waitForRenderedReply(ctx: Pick<ChatCatalogContext, "issue" | "input">, o: Pick<InternalObservation, "leadId" | "runs">,
  timeoutMs = RENDERED_REPLY_WAIT_MS, intervalMs = 500) {
  const source = ctx.issue();
  if (!source) throw new Error("Rendered reply wait: missing source conversation");
  const chat = await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`);
  const replies = chat.filter(row => row.authorAgentId === o.leadId && o.runs.some(run => run.id === row.createdByRunId));
  if (!replies.length) throw new Error("Rendered reply wait: the settled source run saved no reply");
  const deadlineAt = Date.now() + timeoutMs;
  for (const reply of replies) {
    const rendered = ctx.input.page.locator(`[id=${JSON.stringify(`comment-${reply.id}`)}]`).filter({ visible: true });
    try {
      await pollUntil({ label: `rendered reply ${reply.id}`, deadlineAt, intervalMs, load: async () => await rendered.count() > 0, accept: Boolean });
    } catch (error) {
      throw new Error(`Rendered reply wait: saved reply ${reply.id} did not render in the open conversation within ${timeoutMs}ms`, { cause: error });
    }
  }
}
export function withRenderedCommentReference(base: ChatCatalogCase): ChatCatalogCase {
  return { ...base, oracleVersion: "paperclip.chat-catalog.internal.comment-with-reference.v2",
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-comment-reference.ts", "../../ui/src/lib/issue-reference.ts", "../../ui/src/components/MarkdownBody.tsx"],
    async act(ctx, state) {
      await pollUntil({ label: "Saved comment source turn", deadlineAt: Date.now() + 150000,
        load: async () => { await ctx.refreshIssue(); return ctx.allRuns(); },
        accept: runs => runs.length === 1 && runs[0]!.status === "succeeded" && ctx.issue()?.conversationState === "waiting",
        reject: runs => runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Source run failed" : undefined });
      const saved = await observeInternal(ctx, state), target = entity(state, "task"), design = entity(state, "design");
      const added = saved.comments.filter(row => row.authorAgentId === saved.leadId && row.createdByRunId && saved.runs.some(run => run.id === row.createdByRunId));
      if (added.length !== 1 || !savedDesignInstruction(saved, added[0]!.body ?? "", design)) return;
      // Run settle precedes the reply's render in the open conversation; read
      // rendered links only after the saved reply itself is on the page.
      await waitForRenderedReply(ctx, saved);
      const o = await observeInternal(ctx, state);
      const taskHref = o.links.find(href => hasLink({ ...o, links: [href] }, "issues", target));
      if (!taskHref) return;
      const page = ctx.input.page, source = page.url();
      try {
        const link = internalResultLink(ctx, o, taskHref).first();
        await expect(link).toBeVisible(); await link.click();
        await page.waitForURL(url => hasLink({ ...o, links: [url.href] }, "issues", target));
        await expect(page.getByRole("heading", { name: target.title!, exact: true }).first()).toBeVisible();
        const comment = page.locator(`[id=${JSON.stringify(`comment-${added[0]!.id}`)}]`);
        await expect(comment).toBeVisible();
        const hrefs = await comment.locator("a[href]").evaluateAll(elements => elements.map(element => element.getAttribute("href")!));
        const href = hrefs.find(value => hasLink({ ...o, links: [value] }, "issues", design));
        if (!href) return;
        const designLink = comment.locator(`a[href=${JSON.stringify(href)}]`).first(); await expect(designLink).toBeVisible(); await designLink.click();
        await page.waitForURL(url => hasLink({ ...o, links: [url.href] }, "issues", design));
        await expect(page.getByRole("heading", { name: design.title!, exact: true }).first()).toBeVisible();
        const actual = await ctx.input.api.get<Entity>(`/api/issues/${design.id}`);
        state.savedCommentReference = { commentId: added[0]!.id, taskId: target.id, designId: design.id, bodySha256: digest(added[0]!.body ?? ""), href,
          visible: true, destinationMatched: true, publicReadMatched: actual.id === design.id && actual.companyId === o.companyId } satisfies ReferenceProof;
        await ctx.input.evidence("chat-saved-comment-reference.json", state.savedCommentReference);
      } finally { await page.goto(source, { waitUntil: "domcontentloaded" }); await expect(page.getByTestId("task-chat-composer-input")).toBeVisible(); }
    },
  };
}
