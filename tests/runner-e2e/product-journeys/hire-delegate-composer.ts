import { expect, type Page } from "@playwright/test";
import { parseAgentMentionHref, parseProjectMentionHref } from "../../../packages/shared/src/project-mentions.js";
import { JourneyError } from "./types.js";

export async function sendHireHandoffMessage(page: Page, text: string, references: Readonly<{ teammate: string; project: string }>, deadlineAt: number) {
  const timeout = () => {
    const remaining = Math.min(5_000, deadlineAt - Date.now());
    if (remaining <= 0) throw new JourneyError("failed", "hire_handoff_editor_not_ready");
    return remaining;
  };
  const tokens = [references.teammate, references.project].map(markdown => {
    const match = /^\[@([^\]]+)\]\(([^)]+)\)$/.exec(markdown);
    const href = match?.[2], agent = href && parseAgentMentionHref(href), project = href && parseProjectMentionHref(href);
    const at = text.indexOf(markdown);
    if (!match || !href || (!agent && !project) || at < 0 || text.indexOf(markdown, at + markdown.length) >= 0) {
      throw new JourneyError("failed", "hire_handoff_context_unverified");
    }
    return { markdown, href, name: match[1]!, kind: agent ? "agent" : "project", at };
  }).sort((left, right) => left.at - right.at);
  if (tokens[0]!.kind === tokens[1]!.kind) throw new JourneyError("failed", "hire_handoff_context_unverified");
  const composer = page.getByTestId("task-chat-composer-input").last();
  const editable = composer.locator('[contenteditable="true"]').first();
  await expect(editable).toBeVisible({ timeout: timeout() });
  await editable.fill("");
  let offset = 0;
  for (const token of tokens) {
    const prefix = text.slice(offset, token.at);
    if (prefix) await editable.pressSequentially(prefix);
    await editable.pressSequentially(`@${token.name}`);
    const menu = page.getByTestId("mention-autocomplete-menu");
    const option = menu.getByRole("button").filter({ has: page.getByText(token.name, { exact: true }) });
    await expect(option.first()).toBeVisible({ timeout: timeout() });
    if (await option.count() !== 1) throw new JourneyError("failed", "hire_handoff_mention_ambiguous");
    await option.click({ timeout: timeout() });
    const chip = editable.locator(`a[data-mention-kind="${token.kind}"]`).last();
    await expect(chip).toBeVisible({ timeout: timeout() });
    if (await chip.getAttribute("href") !== token.href) throw new JourneyError("failed", "hire_handoff_mention_mismatch");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    offset = token.at + token.markdown.length;
  }
  const suffix = text.slice(offset);
  if (suffix) await editable.pressSequentially(suffix);
  const hrefs = await editable.locator("a[data-mention-kind]").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")));
  if (JSON.stringify(hrefs) !== JSON.stringify(tokens.map(token => token.href))) throw new JourneyError("failed", "hire_handoff_mention_mismatch");
  await page.getByTestId("task-chat-composer-send").last().click({ timeout: timeout() });
}
