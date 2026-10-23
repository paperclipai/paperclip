import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({ getSandbox: vi.fn() }));

import { destroySandbox } from "./sandboxes.js";

const context = { route: "leases/release", providerLeaseId: "pc-run-1-abcd1234" };
const noSleep = (_ms: number) => Promise.resolve();

describe("destroySandbox", () => {
  it("returns ok on the first successful attempt", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    await expect(destroySandbox({ destroy }, context, { sleep: noSleep })).resolves.toEqual({ ok: true, attempts: 1 });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and reports the recovering attempt", async () => {
    const destroy = vi.fn()
      .mockRejectedValueOnce(new Error("Durable Object is overloaded. Requests queued for too long."))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(noSleep);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(destroySandbox({ destroy }, context, { sleep })).resolves.toEqual({ ok: true, attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(500);
    expect(log.mock.calls[0]?.[0]).toContain("sandbox.destroy.failed");
    log.mockRestore();
  });

  it("returns the last error after exhausting every attempt instead of swallowing it", async () => {
    const destroy = vi.fn().mockRejectedValue(new Error("Durable Object is overloaded. Requests queued for too long."));
    const sleep = vi.fn(noSleep);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(destroySandbox({ destroy }, context, { sleep })).resolves.toEqual({
      ok: false,
      attempts: 3,
      error: "Durable Object is overloaded. Requests queued for too long.",
    });
    expect(destroy).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 2000]);
    log.mockRestore();
  });

  it("bounds a hung destroy with a per-attempt timeout", async () => {
    const destroy = vi.fn(() => new Promise<void>(() => undefined));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outcome = await destroySandbox({ destroy }, context, { attempts: 2, timeoutMs: 10, sleep: noSleep });
    expect(outcome).toEqual({ ok: false, attempts: 2, error: "sandbox.destroy() timed out after 10ms" });
    log.mockRestore();
  });

  it("treats a synchronous throw as a failed attempt", async () => {
    const destroy = vi.fn(() => { throw new Error("boom"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outcome = await destroySandbox({ destroy }, context, { attempts: 1, sleep: noSleep });
    expect(outcome).toEqual({ ok: false, attempts: 1, error: "boom" });
    log.mockRestore();
  });
});
