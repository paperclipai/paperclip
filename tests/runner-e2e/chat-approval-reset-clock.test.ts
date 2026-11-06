import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "./chat-catalog-contract.js";
const poll = vi.hoisted(() => vi.fn());
vi.mock("./api.js", async original => ({ ...await original<object>(), pollUntil: poll }));
vi.mock("../fixtures/connection-review-provider.js", () => ({ startReviewProvider: async () => ({ url: "http://fixture.invalid", captures: [], close: async () => {} }) }));
import { toolReviewIdentityCases } from "./chat-catalog-domains/identity-tool-review.js";
import { runtimeSessionCases } from "./chat-catalog-domains/runtime-session.js";

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function context(id: string, deadline: number) {
  return { observationDeadlineAt: deadline, scenario: { id }, input: { nonce: "unit", privateSecrets: [], execution: { id: `chat-features.runner-opencode.local.${id}` }, fixtures: { agent: { id: "ceo" }, company: { id: "company" } }, api: {
    get: async () => ({ runtimeConfig: {} }), patch: async () => ({}), post: async () => ({}), putSensitive: async () => ({}),
    postSensitive: async () => ({ connectionId: "connection", actions: { readOnly: [], canMakeChanges: [] } }),
  } }, issue: () => ({ id: "chat", conversationState: "waiting" }), refreshIssue: async () => {}, allRuns: async () => [] } as unknown as ChatCatalogContext;
}
it("actual approval request wait consumes elapsed setup and rejects a late pending card without changing review UI", async () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000);
  const ctx = context("questions-and-approvals.approve-tool-once", 570_000), definition = toolReviewIdentityCases[0]!;
  const state = await definition.setup(ctx); poll.mockRejectedValue(new Error("captured phase"));
  await expect(definition.act!(ctx, state)).rejects.toThrow("captured phase");
  const options = poll.mock.calls[0]![0]; expect(options.deadlineAt).toBe(570_000);
  const pending = [{ status: "pending", payload: { toolAction: { connectionId: "connection" } } }];
  expect(options.accept(pending)).toBe(true); vi.setSystemTime(570_000); expect(options.accept(pending)).toBe(false);
});
it("actual reset canonical wait uses the same setup-inclusive clock and retains exact successful-run prerequisites", async () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000);
  const ctx = context("runs-adapters.reset-session", 690_000); poll.mockRejectedValue(new Error("captured phase"));
  await expect(runtimeSessionCases[0]!.act!(ctx, {})).rejects.toThrow("captured phase");
  const options = poll.mock.calls[0]![0]; expect(options.deadlineAt).toBe(690_000);
  const valid = { source: { conversationState: "waiting" }, runs: [{ status: "succeeded" }, { status: "succeeded" }] };
  expect(options.accept(valid)).toBe(true); expect(options.accept({ ...valid, runs: [{ status: "succeeded" }, { status: "running" }] })).toBe(false);
  vi.setSystemTime(690_000); expect(options.accept(valid)).toBe(false);
});
