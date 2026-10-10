import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createAcpxCommandLeaseOwner } from "./command-lease-owner.js";
import type { VerifiedAcpxCommandLease } from "./installation-integrity.js";

function lease() {
  let consumed = false;
  return {
    spawn: vi.fn(() => {
      if (consumed) throw new Error("single-use command already consumed");
      consumed = true;
      return {} as ChildProcess;
    }),
    close: vi.fn(async () => {
      consumed = true;
    }),
  } satisfies VerifiedAcpxCommandLease;
}

describe("ACPX verified command lease owner", () => {
  it("refreshes only consumed snapshots and preserves single-use spawn enforcement", async () => {
    const first = lease();
    const second = lease();
    const open = vi.fn(async () => second);
    const owner = createAcpxCommandLeaseOwner(first, open);
    await owner.refreshConsumedCommand();
    expect(open).not.toHaveBeenCalled();
    owner.command.spawn();
    expect(() => owner.command.spawn()).toThrow("already consumed");
    await Promise.all([owner.refreshConsumedCommand(), owner.refreshConsumedCommand()]);
    expect(open).toHaveBeenCalledOnce();
    owner.command.spawn();
    expect(second.spawn).toHaveBeenCalledOnce();
    expect(() => owner.command.spawn()).toThrow("already consumed");
    await owner.command.close();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(() => owner.command.spawn()).toThrow("closing");
    await expect(owner.refreshConsumedCommand()).rejects.toThrow("closing");
  });

  it("retains a replacement acquired during shutdown and retries its failed cleanup", async () => {
    const first = lease();
    const replacement = lease();
    replacement.close.mockRejectedValueOnce(new Error("close failed"));
    let acquired!: (value: VerifiedAcpxCommandLease) => void;
    const owner = createAcpxCommandLeaseOwner(
      first,
      () => new Promise((resolve) => {
        acquired = resolve;
      }),
    );
    owner.command.spawn();
    const refresh = owner.refreshConsumedCommand();
    const rejectedRefresh = expect(refresh).rejects.toThrow("closed during refresh");
    await Promise.resolve();
    const close = owner.command.close();
    const rejectedClose = expect(close).rejects.toThrow("leases did not close");
    acquired(replacement);
    await rejectedRefresh;
    await rejectedClose;
    expect(replacement.spawn).not.toHaveBeenCalled();
    await owner.command.close();
    expect(replacement.close).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("fails closed when fresh command verification fails", async () => {
    const initial = lease();
    const owner = createAcpxCommandLeaseOwner(initial, async () => {
      throw new Error("installation changed");
    });
    owner.command.spawn();
    await expect(owner.refreshConsumedCommand()).rejects.toThrow("installation changed");
    expect(() => owner.command.spawn()).toThrow("already consumed");
    await owner.command.close();
    expect(initial.close).toHaveBeenCalledOnce();
  });

  it("cancels a pending refresh and joins its partial-copy cleanup before retiring ownership", async () => {
    const initial = lease();
    let signal!: AbortSignal;
    let entered!: () => void; let drained!: () => void;
    const acquiring = new Promise<void>(resolve => { entered = resolve; });
    const cleanup = new Promise<void>(resolve => { drained = resolve; });
    const owner = createAcpxCommandLeaseOwner(initial, async activeSignal => {
      signal = activeSignal; entered();
      await new Promise<void>(resolve => activeSignal.addEventListener("abort", () => resolve(), { once: true }));
      await cleanup;
      activeSignal.throwIfAborted();
      throw new Error("cancelled acquisition cannot return a lease");
    });
    owner.command.spawn();
    const refresh = owner.refreshConsumedCommand();
    const rejectedRefresh = expect(refresh).rejects.toThrow("owner is closing");
    await acquiring;
    let retired = false;
    const close = owner.command.close().then(() => { retired = true; });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(retired).toBe(false);
    expect(initial.close).not.toHaveBeenCalled();
    drained();
    await rejectedRefresh; await close;
    expect(retired).toBe(true);
    expect(initial.close).toHaveBeenCalledOnce();
  });
});
