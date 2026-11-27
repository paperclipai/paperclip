import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { observeInternal, type InternalObservation } from "./internal-support.js";

export function integratorDefinition(area: string, scenarioId: string, setup: ChatCatalogCase["setup"], observe: ChatCatalogCase["observe"], grade: ChatCatalogCase["grade"], verifyResult: ChatCatalogCase["verifyResult"], extra: Partial<ChatCatalogCase> = {}): ChatCatalogCase {
  return { scenarioId, setup, observe, grade, verifyResult, expectedRunCount: 1, expectedHumanMessageCount: 1,
    turnTimeoutMs: 120_000, attemptTimeoutMs: 300_000, oracleVersion: "paperclip.chat-catalog.integrator.v1",
    sourceFiles: ["chat-catalog-domains/integrator-support.ts", "chat-catalog-domains/internal-support.ts", `chat-catalog-domains/integrator-${area}.ts`, `chat-scenarios/${area}.yaml`], ...extra };
}

/** Claims are checked in the sentence that contains their subject, including
 * negation and false-success controls; a keyword elsewhere is not grounding. */
export function groundedStatement(reply: string, subject: RegExp, meaning: RegExp, contradiction: RegExp): boolean {
  const sentences = reply.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  return sentences.some(sentence => subject.test(sentence) && meaning.test(sentence) && !contradiction.test(sentence))
    && !sentences.some(sentence => contradiction.test(sentence));
}

export async function inspectResult(ctx: ChatCatalogContext, route: string, title: string, href?: string) {
  const source = ctx.input.page.url();
  if (href) {
    const link = ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first();
    await expect(link).toBeVisible(); await link.click();
  } else await ctx.input.page.goto(new URL(route, ctx.input.api.baseURL).href);
  await expect(ctx.input.page).toHaveURL(url => url.pathname === route || url.pathname.startsWith(`${route}/`));
  await expect(ctx.input.page.getByText(title, { exact: true }).first()).toBeVisible();
  await ctx.input.evidence("chat-integrator-result-view.json", { route, title, url: ctx.input.page.url(), renderedReplyLink: !!href });
  await ctx.input.page.goto(source); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
}
export function resultHref(o: InternalObservation, id: string, segment: string): string | undefined {
  return o.links.find(href => { try { const url = new URL(href, o.origin); const parts = url.pathname.split("/");
    return url.origin === new URL(o.origin).origin && parts.some((part, index) => part === segment && parts[index + 1] === id);
  } catch { return false; } });
}
export { observeInternal };
