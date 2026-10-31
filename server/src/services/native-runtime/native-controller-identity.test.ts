import { describe, expect, it, vi } from "vitest";

const readProcessStartedAt = vi.fn();
vi.mock("../hot-restart.js", async importOriginal => ({
  ...await importOriginal<typeof import("../hot-restart.js")>(),
  readProcessStartedAt,
}));

const { currentNativeControllerIdentity } = await import("./native-restart-recovery.js");

describe("current native controller identity", () => {
  it("probes the controller start once, retrying only failed probes", async () => {
    readProcessStartedAt.mockResolvedValueOnce(null).mockResolvedValue("2026-10-21T10:00:00.000Z");
    await currentNativeControllerIdentity();
    const first = await currentNativeControllerIdentity();
    const second = await currentNativeControllerIdentity();
    expect(readProcessStartedAt).toHaveBeenCalledTimes(2);
    expect(first.processStartedAt.toISOString()).toBe("2026-10-21T10:00:00.000Z");
    expect(second).toEqual(first);
  });
});
