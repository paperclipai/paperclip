import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { navigationBoundaryIdentityCases } from "./identity-navigation-boundaries.js";

const definition = navigationBoundaryIdentityCases.find(row => row.scenarioId === "navigation-preferences.dismiss-announcement")!;
const boundary = new Error("First actual publication read; no human action performed");
function fixture(replyAt = 151_600, deadline: number | undefined = 300_000) {
  const read = vi.fn().mockRejectedValue(boundary);
  const ctx = { observationDeadlineAt: deadline,
    input: { execution: { id: "chat-features.runner-opencode.local.navigation-preferences.dismiss-announcement" },
      page: { url: () => "http://fixture.invalid/ACO/chats/ceo" }, api: { get: read } },
    refreshIssue: async () => {},
    issue: () => ({ conversationState: Date.now() >= replyAt ? "waiting" : "active" }),
    allRuns: async () => [{ id: "native", status: Date.now() >= replyAt ? "succeeded" : "running" }],
  } as unknown as ChatCatalogContext;
  return { ctx, read };
}
afterEach(() => vi.useRealTimers());
it("actual announcement act admits the native reply after151.6s within its original clock before human dismissal", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { ctx, read } = fixture();
  const pending = definition.act!(ctx, { publication: { id: "publication" } }).catch(error => error);
  await vi.advanceTimersByTimeAsync(151_000); expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000); expect(await pending).toBe(boundary);
  expect(read).toHaveBeenCalledExactlyOnceWith("/api/announcements/current");
  expect(definition.attemptTimeoutMs).toBe(300_000);
});
it("consumes elapsed setup instead of granting a fresh wait budget", async () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000);
  const { ctx, read } = fixture(280_000, 270_000);
  const pending = definition.act!(ctx, {}).catch(error => error);
  await vi.advanceTimersByTimeAsync(70_500);
  expect(String(await pending)).toContain("Timed out waiting for initial identity response");
  expect(read).not.toHaveBeenCalled();
});
it.each(["failed", "cancelled", "timed_out"])("does not turn a %s native run into a human dismissal", async status => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { ctx, read } = fixture(); ctx.allRuns = async () => [{ status }] as never;
  await expect(definition.act!(ctx, {})).rejects.toThrow("Initial response failed");
  expect(read).not.toHaveBeenCalled();
});
it.each([undefined, NaN, Infinity, 200_000, 199_999])("rejects missing or exhausted original deadline %s before observing", async deadline => {
  vi.useFakeTimers(); vi.setSystemTime(200_000);
  const { ctx, read } = fixture(0); Object.assign(ctx, { observationDeadlineAt: deadline });
  await expect(definition.act!(ctx, {})).rejects.toThrow("Original native observation budget exhausted or missing");
  expect(read).not.toHaveBeenCalled();
});
it("rejects a successful observation that completes after the original deadline", async () => {
  vi.useFakeTimers(); vi.setSystemTime(269_000);
  const { ctx, read } = fixture(0, 270_000);
  ctx.refreshIssue = async () => { vi.setSystemTime(270_001); };
  const pending = definition.act!(ctx, {}).catch(error => error);
  await vi.advanceTimersByTimeAsync(1500);
  expect(String(await pending)).toContain("Timed out waiting for initial identity response");
  expect(read).not.toHaveBeenCalled();
});
