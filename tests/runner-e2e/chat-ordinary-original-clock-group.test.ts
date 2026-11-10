import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "./chat-catalog-contract.js";
import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogOriginalPhaseDeadline } from "./chat-catalog-contract.js";
import { waitForReply } from "./chat-catalog-domains/identity-support.js";
const ids = ["companies.export-company", "projects.project-defaults", "questions-and-approvals.ambiguous-yes", "questions-and-approvals.review-plan", "questions-and-approvals.necessary-question", "task-coordination.block-on-design", "gateways-profiles.rotate-token", "gateways-profiles.create-gateway", "workspaces.preview-service", "assistant-connections.consent-read-only", "navigation-preferences.quick-search", "navigation-preferences.edit-profile", "navigation-preferences.broken-link", "projects.share-project"];
const context = (id: string, deadline: number | undefined = 630000) => ({ scenario: { id }, input: { execution: { id: `chat-features.runner-opencode.local.${id}` } }, observationDeadlineAt: deadline,
  refreshIssue: async () => {}, issue: () => ({ conversationState: "waiting" }), allRuns: async () => [{ status: Date.now() >= 200000 ? "succeeded" : "running" }] }) as unknown as ChatCatalogContext;
afterEach(() => vi.useRealTimers());
it.each(ids)("%s reuses the original setup-inclusive deadline and never grants a fresh phase", id => {
  vi.useFakeTimers(); vi.setSystemTime(200000); const c = context(id);
  expect(chatCatalogNativePhaseDeadline(c, 380000)).toBe(630000); expect(chatCatalogOriginalPhaseDeadline(c)).toBe(630000);
  vi.setSystemTime(629999); expect(chatCatalogNativePhaseDeadline(c, 900000)).toBe(630000);
  vi.setSystemTime(630000); expect(chatCatalogNativePhaseIsTimely(c)).toBe(false); expect(() => chatCatalogOriginalPhaseDeadline(c)).toThrow(/exhausted/);
});
it.each(["companies.export-company", "navigation-preferences.quick-search", "questions-and-approvals.ambiguous-yes"])("%s actual identity waiter can finish after the incidental150s cap", async id => {
  vi.useFakeTimers(); vi.setSystemTime(0); const c = context(id, 270000); let completed = false;
  const pending = waitForReply(c, chatCatalogOriginalPhaseDeadline(c)).then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(151000); expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(50000); await pending; expect(completed).toBe(true); expect(c.observationDeadlineAt).toBe(270000);
});
it("missing, infinite, expired clocks and delayed late successes fail closed", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  for (const deadline of [undefined, NaN, Infinity, 1000, 999]) { const c = context(ids[0]!, deadline); Object.assign(c, { observationDeadlineAt: deadline }); expect(() => chatCatalogOriginalPhaseDeadline(c)).toThrow(/exhausted/); }
  const c = context(ids[0]!, 1100); c.refreshIssue = async () => { vi.setSystemTime(1101); }; c.allRuns = async () => [{ status: "succeeded" }] as never;
  const pending = waitForReply(c, chatCatalogOriginalPhaseDeadline(c)).then(() => "accepted", () => "expired"); await vi.advanceTimersByTimeAsync(1000); expect(await pending).toBe("expired");
});
it("unselected cases and other provider/environment lanes retain authored phase caps", () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  for (const id of ["goals.create-goal-tree", "skills.author-skill", "questions-and-approvals.reject-and-revise", "questions-and-approvals.multi-part-question"]) { const c = context(id, 0); expect(chatCatalogOriginalPhaseDeadline(c)).toBeUndefined(); expect(chatCatalogNativePhaseDeadline(c, 151000)).toBe(151000); }
  for (const id of ids) for (const lane of ["runner-codex.local", "runner-opencode.daytona"]) { const c = context(id, 0); Object.assign(c.input.execution, { id: `chat-features.${lane}.${id}` }); expect(chatCatalogOriginalPhaseDeadline(c)).toBeUndefined(); }
});
