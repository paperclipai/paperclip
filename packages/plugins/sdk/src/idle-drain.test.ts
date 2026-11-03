import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginIdleDrain } from "./idle-drain.js";

describe("plugin idle admission", () => {
  afterEach(() => vi.useRealTimers());
  const hold = () => ({ ownerId: "idle-owner", expiresAt: Date.now() + 10_000 });

  it("keeps accepted work counted until actual settlement", async () => {
    const gate = createPluginIdleDrain();
    const done = gate.begin();
    const inspect = vi.fn(async () => "none" as const);
    expect(await gate.prepare(hold(), inspect)).toBe("present");
    expect(inspect).not.toHaveBeenCalled();
    done(); done();
    expect(await gate.prepare(hold(), inspect)).toBe("none");
    expect(() => gate.begin()).toThrow("held");
    gate.close();
  });

  it("rejects legacy hooks, invalid deadlines, busy replies and hook errors", async () => {
    const gate = createPluginIdleDrain();
    expect(await gate.prepare(hold())).toBe("present");
    expect(await gate.prepare({ ...hold(), expiresAt: Infinity }, async () => "none")).toBe("unknown");
    expect(await gate.prepare(hold(), async () => "present")).toBe("present");
    expect(await gate.prepare(hold(), async () => { throw new Error("private detail"); })).toBe("unknown");
    gate.begin()();
  });

  it("releases only the matching owner and resumes on expiry without another request", async () => {
    vi.useFakeTimers();
    const gate = createPluginIdleDrain();
    const lease = hold();
    let signal!: AbortSignal;
    expect(await gate.prepare(lease, async (value) => { signal = value; return "none"; })).toBe("none");
    gate.release("stale-owner");
    expect(signal.aborted).toBe(false);
    expect(await gate.prepare({ ...lease, ownerId: "other-owner" }, async () => "none")).toBe("unknown");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal.aborted).toBe(true);
    gate.begin()();
  });

  it("holds admission while the hook runs and rejects a late acknowledgement", async () => {
    vi.useFakeTimers();
    const gate = createPluginIdleDrain();
    let resolve!: (state: "none") => void;
    const pending = gate.prepare(hold(), () => new Promise((done) => { resolve = done; }));
    expect(() => gate.begin()).toThrow("held");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await gate.prepare(hold(), async () => "none")).toBe("present");
    resolve("none");
    expect(await pending).toBe("unknown");
    gate.begin()();
  });
});
