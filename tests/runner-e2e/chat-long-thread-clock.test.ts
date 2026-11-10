import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "./chat-catalog-contract.js";
const { poll, settle, send } = vi.hoisted(() => ({ poll: vi.fn(), settle: vi.fn(), send: vi.fn() }));
vi.mock("./api.js", async original => ({ ...await original<object>(), pollUntil: poll }));
vi.mock("./chat-flow.js", async original => ({ ...await original<object>(), sendChatMessage: send }));
vi.mock("./chat-catalog-domains/privileged-support.js", async original => ({ ...await original<object>(), settlePrivilegedChat: settle }));
vi.mock("@playwright/test", async original => ({ ...await original<object>(), expect: Object.assign(() => ({ toBeVisible: async () => {} }), { poll: () => ({ toBeGreaterThanOrEqual: async () => {} }) }) }));
import { privilegedPerformanceCases } from "./chat-catalog-domains/privileged-performance.js";
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function context() {
  const values: Record<string, number> = { "perf-fixture-row-target": 487, "perf-fixture-markdown-rows": 150, "perf-mount-duration": 12.3, "perf-latest-duration": 8.1, "perf-max-duration": 12.3, "perf-total-duration": 20.4, "perf-commit-count": 2 };
  const page = { url: () => "http://owned.invalid/chat", goto: vi.fn(async () => {}), getByTestId: (id: string) => ({ innerText: async () => String(values[id]) }), evaluate: async () => "unit browser", viewportSize: () => ({ width: 1280, height: 720 }) };
  return { observationDeadlineAt: 570_000, scenario: { id: "developer-labs.long-thread-performance" }, input: { execution: { id: "chat-features.runner-opencode.local.developer-labs.long-thread-performance" }, page, api: { baseURL: "http://owned.invalid" }, evidence: vi.fn(), capture: vi.fn() }, refreshIssue: async () => {}, issue: () => ({ conversationState: "waiting" }) } as unknown as ChatCatalogContext;
}
it("actual measured-report followup and interpretation consume the original clock after browser work", async () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000); const ctx = context(), state: Record<string, unknown> = {};
  settle.mockResolvedValue({ runs: [{ id: "first" }] }); send.mockImplementation(async (_page, _text, remaining) => { expect(remaining()).toBe(370_000); }); poll.mockRejectedValue(new Error("captured interpretation"));
  await expect(privilegedPerformanceCases[0]!.act!(ctx, state)).rejects.toThrow("captured interpretation");
  expect(send).toHaveBeenCalledExactlyOnceWith(ctx.input.page, expect.stringContaining('"commentCount":469'), expect.any(Function));
  const options = poll.mock.calls[0]![0]; expect(options.deadlineAt).toBe(570_000);
  const valid = { issue: { conversationState: "waiting" }, runs: [{ status: "succeeded" }, { status: "succeeded" }] };
  expect(options.accept(valid)).toBe(true); expect(options.accept({ ...valid, runs: [{ status: "succeeded" }, { status: "running" }] })).toBe(false);
  vi.setSystemTime(570_000); expect(options.accept(valid)).toBe(false);
  expect(state.performanceReport).toMatchObject({ commentCount: 469, rowCount: 487, markdownCount: 150, mountMs: 12.3 });
});
it("elapsed browser measurement cannot reset the report send budget", async () => {
  vi.useFakeTimers(); vi.setSystemTime(570_000); const ctx = context(); settle.mockResolvedValue({ runs: [{ id: "first" }] }); send.mockImplementation(async (_page, _text, remaining) => remaining());
  await expect(privilegedPerformanceCases[0]!.act!(ctx, {})).rejects.toThrow(/exhausted/); expect(poll).not.toHaveBeenCalled();
  expect(ctx.observationDeadlineAt).toBe(570_000);
});
