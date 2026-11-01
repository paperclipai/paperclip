import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { startNativeSessionExecutionLeaseRenewal } from "./native-execution-lease.js";

function fixture() {
  const returning = vi.fn(async () => [{ runId: "run" }]);
  const update = vi.fn(() => ({ set: () => ({ where: () => ({ returning }) }) }));
  const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({ update, execute: vi.fn() }));
  const db = { update, transaction };
  return { update, returning, transaction, input: { db: db as unknown as Db, runId: "run", companyId: "company", issueId: "issue",
    leaseOwner: "owner", attempt: 1, controller: { bootId: "boot", pid: 1, processStartedAt: new Date() }, remote: true,
    onLost: vi.fn(async () => undefined) } };
}
afterEach(() => vi.useRealTimers());
describe("native execution renewal ownership", () => {
  it("keeps a successfully renewed lease through repeated slow connection acquisition", async () => {
    vi.useFakeTimers();
    const { input, update, transaction } = fixture();
    const connected = transaction.getMockImplementation()!;
    transaction.mockImplementation(async run => {
      await new Promise(resolve => setTimeout(resolve, 30_000));
      return connected(run);
    });
    const guard = startNativeSessionExecutionLeaseRenewal(input);
    try {
      // Renewals start at 20s/60s and extend the database lease at 50s/90s.
      // Connection waits must not shorten the successfully extended ownership.
      await vi.advanceTimersByTimeAsync(95_000);
      expect(update).toHaveBeenCalledTimes(2);
      expect(input.onLost).not.toHaveBeenCalled();
    } finally { await guard.stop().catch(() => undefined); }
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shares one timer across preparation and execution and stops idle SQL after both release", async () => {
    vi.useFakeTimers();
    const { input, update } = fixture();
    const preparation = startNativeSessionExecutionLeaseRenewal(input);
    const execution = startNativeSessionExecutionLeaseRenewal(input);
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(update).toHaveBeenCalledTimes(2);
    await preparation.stop();
    await preparation.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(update).toHaveBeenCalledTimes(3);
    await execution.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(update).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retries cancelled SQL within the original deadline without losing healthy ownership", async () => {
    vi.useFakeTimers();
    const { input, returning } = fixture();
    returning.mockRejectedValueOnce(Object.assign(new Error("statement timeout"), { code: "57014" }));
    const guard = startNativeSessionExecutionLeaseRenewal(input);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(returning).toHaveBeenCalledTimes(3);
    expect(input.onLost).not.toHaveBeenCalled();
    await guard.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("detaches at the deadline while a database response is missing and cannot regain authority from a late response", async () => {
    vi.useFakeTimers();
    const { input, returning } = fixture();
    let complete!: (value: { runId: string }[]) => void;
    returning.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const guard = startNativeSessionExecutionLeaseRenewal(input);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(returning).toHaveBeenCalledTimes(1);
    expect(input.onLost).toHaveBeenCalledTimes(1);
    complete([{ runId: "run" }]);
    await expect(guard.stop()).rejects.toThrow("native_session_lease_renewal_deadline");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(returning).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not queue SQL behind a slow renewal and fences a lost owner", async () => {
    vi.useFakeTimers();
    const { input, update, returning } = fixture();
    let complete!: (value: { runId: string }[]) => void;
    returning.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const guard = startNativeSessionExecutionLeaseRenewal(input);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(update).toHaveBeenCalledTimes(1);
    complete([]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(update).toHaveBeenCalledTimes(1);
    expect(input.onLost).toHaveBeenCalledTimes(1);
    expect(() => startNativeSessionExecutionLeaseRenewal(input)).toThrow("native_session_lease_lost");
    await expect(guard.stop()).rejects.toThrow("native_session_lease_lost");
    expect(vi.getTimerCount()).toBe(0);
  });
});
