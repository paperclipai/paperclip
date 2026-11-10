import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "./chat-catalog-contract.js";
const poll = vi.hoisted(() => vi.fn());
vi.mock("./api.js", async original => ({ ...await original<object>(), pollUntil: poll }));
import { secretProposalExternalCases, secretProposalDecisionClickOptions } from "./chat-catalog-domains/external-secret-proposal.js";
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function context() { return { observationDeadlineAt: 810_000, scenario: { id: "secrets.secret-proposal" }, input: { execution: { id: "chat-features.runner-opencode.local.secrets.secret-proposal" } }, refreshIssue: async () => {}, issue: () => ({ conversationState: "waiting" }) } as unknown as ChatCatalogContext; }
it("actual proposal settlement uses the setup-inclusive810s clock and rejects running or late results", async () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000); const ctx = context(); poll.mockRejectedValue(new Error("captured settlement"));
  await expect(secretProposalExternalCases[0]!.act!(ctx, {})).rejects.toThrow("captured settlement");
  const options = poll.mock.calls[0]![0]; expect(options.deadlineAt).toBe(810_000);
  expect(options.accept([{ status: "succeeded" }])).toBe(true); expect(options.accept([{ status: "running" }])).toBe(false);
  expect(options.reject([{ status: "succeeded" }, { status: "succeeded" }])).toMatch(/extra/);
  vi.setSystemTime(810_000); expect(options.accept([{ status: "succeeded" }])).toBe(false);
});
it("expired original clock cannot start another native observation", async () => {
  vi.useFakeTimers(); vi.setSystemTime(810_000);
  await expect(secretProposalExternalCases[0]!.act!(context(), {})).rejects.toThrow(/exhausted/); expect(poll).not.toHaveBeenCalled();
});
it("real human decision keeps the30s UI cap and fails closed after elapsed composer or review work", () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000); const ctx = context(); expect(secretProposalDecisionClickOptions(ctx)).toEqual({ timeout: 30_000 });
  vi.setSystemTime(809_999); expect(secretProposalDecisionClickOptions(ctx)).toEqual({ timeout: 1 });
  vi.setSystemTime(810_000); expect(() => secretProposalDecisionClickOptions(ctx)).toThrow(/exhausted/);
  expect(ctx.observationDeadlineAt).toBe(810_000);
});
