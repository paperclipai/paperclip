import { expect, type Page } from "@playwright/test";
import { pendingStoryDecision, type StoryInteraction } from "./everyday-decisions.js";

/** Both delivery forms are supported by the product; a visible link must back an attachment. */
export async function readServiceBriefing(input: {
  page: Page; issueId: string; api: { get<T>(route: string): Promise<T>; bytes(route: string): Promise<Buffer> };
}) {
  type Row = Record<string, any>;
  const docs = await input.api.get<Row[]>(`/api/issues/${input.issueId}/documents`);
  const bodies = await Promise.all(docs.map(doc => input.api.get<Row>(`/api/issues/${input.issueId}/documents/${encodeURIComponent(doc.key)}`)));
  const attachments = await input.api.get<Row[]>(`/api/issues/${input.issueId}/attachments`);
  for (const attachment of attachments.filter(row => /\.(?:md|txt)$/i.test(row.originalFilename ?? row.filename ?? "")
    || ["text/markdown", "text/plain"].includes(row.contentType))) {
    const route = `/api/attachments/${attachment.id}/content`;
    await expect(input.page.locator(`a[href*="${route}"]`).first()).toBeVisible();
    const bytes = await input.api.bytes(route);
    if (bytes.length > 65_536) throw new Error("service_briefing_exceeds_limit");
    bodies.push({ id: attachment.id, title: attachment.originalFilename ?? attachment.filename, body: bytes.toString("utf8"), source: "delivered-attachment" });
  }
  return bodies;
}

export function serviceBriefingChecks(bodies: Array<Record<string, any>>, marker: string) {
  const text = bodies.map(doc => String(doc.body ?? doc.revision?.body ?? "")).join("\n");
  return [
    { id: "briefing-uses-real-result", passed: text.includes(marker), detail: "The saved document or attachment includes the actual service verification code." },
    { id: "briefing-includes-page-titles", passed: text.includes("Roadmap") && text.includes("Meeting notes"), detail: "The saved briefing includes both returned page titles." },
  ];
}

/** A saved decision for this exact connection must exist before any service call. */
export async function decideProtectedActionThroughUi(input: {
  page: Page; rows: StoryInteraction[]; connectionId: string; decline: boolean;
  invocationCount(): number; expectedCallsBefore?: number;
}) {
  const interaction = pendingStoryDecision(input.rows, { kind: "tool", connectionId: input.connectionId });
  expect(input.invocationCount()).toBe(input.expectedCallsBefore ?? 0);
  const dismiss = input.page.getByRole("button", { name: "Dismiss Approve tool action" });
  if (await dismiss.isVisible()) await dismiss.click();
  await input.page.getByRole("button", { name: "Review request", exact: true }).click();
  await input.page.getByRole("button", { name: input.decline ? "Decline" : "Approve & run", exact: true }).click();
  return interaction;
}
