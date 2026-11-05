import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type { RequestConfirmationInteraction } from "../../../packages/shared/src/types/issue.js";
import { requestConfirmationPayloadSchema } from "../../../packages/shared/src/validators/issue.js";
import { chatCatalogHumanQuestionPolicies, chatCatalogHasExactDefinitionId } from "../chat-catalog-contract.js";
export interface PersonalConfirmationBinding { companyId: string; issueId: string; agentId: string; userId: string; runId: string; definitionId: string; canonicalCommentId: string }
export function personalSecretConfirmationHandoff(value: unknown, b: PersonalConfirmationBinding, guidance: (text: string) => boolean, status: "pending" | "accepted" = "pending") {
  const row = value as Partial<RequestConfirmationInteraction> | undefined, p = row?.payload;
  if (!row?.id || row.kind !== "request_confirmation" || row.status !== status || row.companyId !== b.companyId || row.issueId !== b.issueId
    || row.sourceRunId !== b.runId || row.createdByAgentId !== b.agentId || row.createdByUserId || row.addresseeAgentId
    || (row.addresseeUserId != null && row.addresseeUserId !== b.userId) || !row.originCommentIds?.includes(b.canonicalCommentId)
    || !chatCatalogHumanQuestionPolicies(row) || row.continuationPolicy !== "wake_assignee" || !p
    || p.target || p.toolAction || p.secretProposal || p.connectionAuthorization || p.qualityReview
    || !requestConfirmationPayloadSchema.safeParse(p).success || row.dismissedAt
    || (status === "pending" ? row.resolvedByUserId || row.resolvedByAgentId : row.resolvedByUserId !== b.userId || row.resolvedByAgentId || row.result?.outcome !== "accepted")) return;
  const actionText = [p.prompt, p.detailsMarkdown].filter(Boolean).join("\n");
  const text = [actionText, p.acceptLabel].filter(Boolean).join("\n");
  if (!guidance(text) || !chatCatalogHasExactDefinitionId(actionText, b.definitionId) || !/\bPERSONAL_PUBLISHING_KEY\b/.test(text) || !/my secrets/i.test(text)
    || !/\b(?:when|once|after)\b[^.!?]*\b(?:saved|set|entered)\b[^.!?]*\bconfirm\b|\bconfirm\b[^.!?]*\b(?:saved|set|entered)\b/i.test(text)
    || /\b(?:deploy(?:ment)?|delet(?:e|ion)|execut(?:e|ion)|purchas(?:e|ing))\b/i.test(actionText)) return;
  return { interactionId: row.id, payloadHash: createHash("sha256").update(JSON.stringify(p)).digest("hex"), acceptLabel: p.acceptLabel ?? "Approve", prompt: p.prompt };
}
export async function acceptPersonalSecretConfirmation(page: Page, issueId: string, interactionId: string, label: string, prompt: string, remaining: () => number) {
  const card = page.getByTestId("task-chat-composer-takeover");
  await expect(card.getByText(prompt, { exact: true })).toBeVisible({ timeout: remaining() });
  const [response] = await Promise.all([
    page.waitForResponse(res => new URL(res.url()).pathname === `/api/issues/${issueId}/interactions/${interactionId}/accept` && res.request().method() === "POST", { timeout: remaining() }),
    card.getByRole("button", { name: label, exact: true }).click({ timeout: remaining() }),
  ]);
  if (!response.ok()) throw new Error("Personal secure-entry confirmation failed");
  return response.json() as Promise<unknown>;
}

export async function confirmThenStartPersonalConsumer(confirm: () => Promise<void>, start: () => Promise<void>) {
  await confirm();
  await start();
}

export async function readVisiblePersonalSecretConfirmation(page: Page, handoff: { prompt: string }, target: { origin: string; prefix: string; definitionId: string }, guidance: (text: string) => boolean, remaining: () => number) {
  const card = page.getByTestId("task-chat-composer-takeover");
  await expect(card.getByText(handoff.prompt, { exact: true })).toBeVisible({ timeout: remaining() });
  const read = () => card.evaluate((root, target) => {
    const visibility = { shown(node: Element, rect: DOMRect) {
      let opacity = 1;
      for (let element: Element | null = node; element; element = element.parentElement) {
        const style = getComputedStyle(element), box = element.getBoundingClientRect(); opacity *= Number(style.opacity);
        if (style.display === "none" || style.visibility !== "visible" || opacity < 0.05 || parseFloat(style.fontSize) <= 0) return false;
        if (element instanceof HTMLDetailsElement && !element.open && !element.querySelector(":scope > summary")?.contains(node)) return false;
        if (/hidden|clip/.test(style.overflowX) && (rect.right <= box.left || rect.left >= box.right)) return false;
        if (/hidden|clip/.test(style.overflowY) && (rect.bottom <= box.top || rect.top >= box.bottom)) return false;
      }
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
    } };
    const parts: string[] = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.parentElement) for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
      const range = document.createRange(); range.setStart(node, match.index!); range.setEnd(node, match.index! + match[0].length);
      if (Array.from(range.getClientRects()).some(rect => visibility.shown(node.parentElement!, rect))) parts.push(match[0]);
    }
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]")).filter(node => visibility.shown(node, node.getBoundingClientRect())).map(node => node.href);
    const linked = links.some(href => { try { const url = new URL(href, target.origin); return url.origin === target.origin && url.pathname === `/${target.prefix}/company/settings/secrets` && !url.username && !url.password && !url.hash && url.searchParams.getAll("definition").length === 1 && url.searchParams.get("definition") === target.definitionId && [...url.searchParams.keys()].every(key => key === "definition"); } catch { return false; } });
    return { text: parts.join(" "), linked };
  }, target);
  let visible = await read(); const before = visible.text;
  const seenDefinition = chatCatalogHasExactDefinitionId(visible.text, target.definitionId) || visible.linked;
  if (!seenDefinition || !guidance(visible.text)) {
    const details = card.locator("details");
    if (await details.count() !== 1) throw new Error("Personal confirmation definition is not visibly bound");
    if (await details.getAttribute("open") === null) await details.locator("summary").click({ timeout: remaining() });
    const text = details.getByText(target.definitionId, { exact: false }).last();
    if (await text.count()) await text.scrollIntoViewIfNeeded({ timeout: remaining() });
    else { const link = details.locator("a[href]").last(); if (await link.count()) await link.scrollIntoViewIfNeeded({ timeout: remaining() }); }
    visible = await read();
  }
  if ((!seenDefinition && !chatCatalogHasExactDefinitionId(visible.text, target.definitionId) && !visible.linked) || !guidance(before + "\n" + visible.text)) throw new Error("Personal confirmation secure handoff is not actually visible");
  return { definitionVisible: true, visibleTextHash: createHash("sha256").update(before + "\n" + visible.text).digest("hex") };
}
