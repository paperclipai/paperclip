import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const observed = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./internal-support.js", async importOriginal => ({ ...await importOriginal<object>(), observeInternal: observed.load }));
import { remainingPrivilegedObservationBudget, settlePrivilegedChat } from "./privileged-support.js";
import { privilegedConfigurationCases } from "./privileged-configuration.js";
function context(settlesAt = 180_000, deadline = 390_000): ChatCatalogContext {
  const ctx = { observationDeadlineAt: deadline, issue: () => ({ conversationState: Date.now() >= settlesAt ? "waiting" : "active" }) } as unknown as ChatCatalogContext;
  observed.load.mockImplementation(async () => ({ runs: [{ status: Date.now() >= settlesAt ? "succeeded" : "running" }], reply: Date.now() >= settlesAt ? "Use the operator experimental settings." : "" }));
  return ctx;
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.restoreAllMocks(); });
describe("instance settings consume the original observation clock", () => {
  it("waits beyond the incidental150s only for a genuinely settled reply", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const ctx = context(); let done = false;
    const pending = settlePrivilegedChat(ctx, ctx.observationDeadlineAt).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(151_000); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(29_000); await pending;
    expect(done).toBe(true); expect(remainingPrivilegedObservationBudget(ctx)).toBe(210_000);
  });
  it("does not change the default150s for other privileged callers", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const ctx = context();
    const pending = settlePrivilegedChat(ctx).then(() => "accepted", () => "timeout");
    await vi.advanceTimersByTimeAsync(151_000); expect(await pending).toBe("timeout");
  });
  it("charges elapsed setup against the same390s clock and retains the30s reserve", async () => {
    vi.useFakeTimers(); vi.setSystemTime(300_000); const ctx = context(400_000);
    expect(remainingPrivilegedObservationBudget(ctx)).toBe(90_000);
    const pending = settlePrivilegedChat(ctx, ctx.observationDeadlineAt).then(() => "accepted", () => "timeout");
    await vi.advanceTimersByTimeAsync(91_000); expect(await pending).toBe("timeout");
    expect(() => remainingPrivilegedObservationBudget(ctx)).toThrow(/exhausted/);
  });
  it("cannot accept late successful reads or still-running native work", async () => {
    vi.useFakeTimers(); vi.setSystemTime(389_000); const ctx = context(0);
    observed.load.mockImplementation(async () => { vi.setSystemTime(391_000); return { runs: [{ status: "succeeded" }], reply: "Settings" }; });
    const pending = settlePrivilegedChat(ctx, ctx.observationDeadlineAt).then(() => "accepted", () => "timeout");
    await vi.advanceTimersByTimeAsync(3_000); expect(await pending).toBe("timeout");
    vi.setSystemTime(389_000); const running = context(999_000);
    const another = settlePrivilegedChat(running, running.observationDeadlineAt).then(() => "accepted", () => "timeout");
    await vi.advanceTimersByTimeAsync(2_000); expect(await another).toBe("timeout");
  });
  it("keeps failure, queued-extra-run and missing reply gates", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const ctx = context(0);
    observed.load.mockResolvedValue({ runs: [{ status: "failed" }], reply: "Settings" });
    await expect(settlePrivilegedChat(ctx, ctx.observationDeadlineAt)).rejects.toThrow(/run failed/);
    for (const value of [{ runs: [{ status: "succeeded" }, { status: "queued" }], reply: "Settings" }, { runs: [{ status: "succeeded" }], reply: "" }]) {
      observed.load.mockResolvedValue(value);
      const pending = settlePrivilegedChat(ctx, Date.now() + 1000).then(() => "accepted", () => "timeout");
      await vi.advanceTimersByTimeAsync(2100); expect(await pending).toBe("timeout");
    }
  });
  it("actual settings act opts in and forwards only the remaining original budget", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const ctx = context();
    const goto = vi.fn(async () => { throw new Error("actual navigation boundary"); });
    ctx.input = { page: { url: () => "https://fixture.test/RUN/chats/ceo", goto }, fixtures: { company: { issuePrefix: "RUN" } }, api: { baseURL: "https://fixture.test" } } as never;
    const pending = privilegedConfigurationCases[0]!.act!(ctx, {}).catch(String);
    await vi.advanceTimersByTimeAsync(151_000); expect(goto).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_000); expect(await pending).toContain("actual navigation boundary");
    expect(goto).toHaveBeenCalledExactlyOnceWith("https://fixture.test/RUN/company/settings/instance/experimental", { waitUntil: "domcontentloaded", timeout: 210_000 });
  });
  it("slow navigation cannot start the next mutation or reset the original budget", async () => {
    vi.useFakeTimers(); vi.setSystemTime(389_000); const ctx = context(0); const click = vi.fn();
    const goto = vi.fn(async () => { vi.setSystemTime(391_000); });
    ctx.input = { page: { url: () => "https://fixture.test/RUN/chats/ceo", goto, getByRole: () => ({ click }) }, fixtures: { company: { issuePrefix: "RUN" } }, api: { baseURL: "https://fixture.test" } } as never;
    await expect(privilegedConfigurationCases[0]!.act!(ctx, {})).rejects.toThrow(/exhausted/);
    expect(goto).toHaveBeenCalledOnce(); expect(click).not.toHaveBeenCalled();
  });
  it("never returns Playwright's unlimited zero timeout at the deadline boundary", () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(389_999).mockReturnValueOnce(390_000);
    expect(remainingPrivilegedObservationBudget({ observationDeadlineAt: 390_000 } as ChatCatalogContext)).toBe(1);
    expect(now).toHaveBeenCalledOnce();
  });
  it("missing, expired and nonfinite original deadlines fail before any UI action", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    for (const deadline of [undefined, NaN, Infinity, 0, -1]) {
      const ctx = { observationDeadlineAt: deadline } as ChatCatalogContext;
      expect(() => remainingPrivilegedObservationBudget(ctx)).toThrow();
      await expect(privilegedConfigurationCases[0]!.act!(ctx, {})).rejects.toThrow(/exhausted or missing/);
    }
  });
});
