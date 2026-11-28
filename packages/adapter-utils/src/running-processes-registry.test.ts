import { describe, expect, it, vi } from "vitest";

describe("runningProcesses", () => {
  it("shares one registry across separate copies of the module", async () => {
    const first = await import("./server-utils.js");
    vi.resetModules();
    const second = await import("./server-utils.js");

    expect(second).not.toBe(first);
    expect(second.runningProcesses).toBe(first.runningProcesses);
  });
});
