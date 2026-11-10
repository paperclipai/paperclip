import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { waitForCompanySettingsTurn } from "./identity-company-observer.js";

const start = 50_000;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(count = 1, allowance = 390_000) {
  vi.useFakeTimers(); vi.setSystemTime(start);
  let completesAt = start + 160_000, status = "succeeded", actualCount = count;
  const refreshIssue = vi.fn(async () => {});
  const ctx = { observationDeadlineAt: start + allowance, refreshIssue,
    issue: () => ({ conversationState: Date.now() >= completesAt ? "waiting" : "running" }),
    allRuns: async () => Array.from({ length: actualCount }, () => ({ status: Date.now() >= completesAt ? status : "running" })),
  } as unknown as ChatCatalogContext;
  return { ctx, refreshIssue, completesAt: (value: number) => { completesAt = value; },
    status: (value: string) => { status = value; }, count: (value: number) => { actualCount = value; } };
}
it.each([1, 2, 3])("observes valid declared turn %s after the old150s cap within the unchanged original clock", async count => {
  const f = fixture(count, count === 1 ? 390_000 : 570_000);
  const pending = waitForCompanySettingsTurn(f.ctx, count);
  const result = expect(pending).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(160_000); await result;
  expect(f.ctx.observationDeadlineAt).toBe(start + (count === 1 ? 390_000 : 570_000));
});
it.each([1, 2, 3])("does not reset the original deadline for late turn %s", async count => {
  const f = fixture(count, 10_000); f.completesAt(start + 11_000);
  const result = expect(waitForCompanySettingsTurn(f.ctx, count)).rejects.toThrow(/Timed out waiting/);
  await vi.advanceTimersByTimeAsync(12_000); await result;
  expect(f.ctx.observationDeadlineAt).toBe(start + 10_000);
});
it.each([undefined, NaN, Infinity, start, start - 1])("rejects missing, invalid or exhausted original deadline %s before observing", async deadline => {
  const f = fixture(); Object.assign(f.ctx, { observationDeadlineAt: deadline });
  await expect(waitForCompanySettingsTurn(f.ctx)).rejects.toThrow(/Original identity observation budget/);
  expect(f.refreshIssue).not.toHaveBeenCalled();
});
it.each(["failed", "cancelled", "timed_out"])("rejects actual stopped/failed native work %s", async status => {
  for (const count of [1, 2, 3]) {
    const f = fixture(count); f.completesAt(start); f.status(status);
    await expect(waitForCompanySettingsTurn(f.ctx, count)).rejects.toThrow(/Initial response failed|Declared company settings turn failed/);
  }
});
it("rejects a late asynchronous observation instead of accepting after the original deadline", async () => {
  const f = fixture(2, 1000); f.completesAt(start);
  f.refreshIssue.mockImplementation(async () => { vi.setSystemTime(start + 1001); });
  const result = expect(waitForCompanySettingsTurn(f.ctx, 2)).rejects.toThrow(/Timed out waiting/);
  await vi.advanceTimersByTimeAsync(2000); await result;
});
it("rejects extra native work instead of fitting a completed successor to the bound", async () => {
  const f = fixture(2); f.completesAt(start); f.count(3);
  await expect(waitForCompanySettingsTurn(f.ctx, 2)).rejects.toThrow(/declared native run bound/);
});

it.each([1, 2, 3])("does not accept a waiting chat with no native work for declared turn %s", async count => {
  const f = fixture(count, 1000); f.completesAt(start); f.count(0);
  const result = expect(waitForCompanySettingsTurn(f.ctx, count)).rejects.toThrow(/Timed out waiting/);
  await vi.advanceTimersByTimeAsync(2000); await result;
});
