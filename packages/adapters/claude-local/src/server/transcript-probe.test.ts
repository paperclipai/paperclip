import { describe, expect, it, vi } from "vitest";
import { createTranscriptProbe, resolveTranscriptConfigDir } from "./transcript-probe.js";

describe("transcript probe", () => {
  it("prefers the child USERPROFILE over HOME on Windows", () => {
    expect(resolveTranscriptConfigDir({ HOME: "C:\\other", USERPROFILE: "C:\\Users\\agent" }, "C:\\work", "win32", "C:\\server"))
      .toBe("C:\\Users\\agent\\.claude");
  });
  it("uses the child Windows profile when HOME and CLAUDE_CONFIG_DIR are absent", () => {
    expect(resolveTranscriptConfigDir({ USERPROFILE: "C:\\Users\\agent" }, "C:\\work", "win32", "C:\\Users\\server"))
      .toBe("C:\\Users\\agent\\.claude");
  });
  it("bounds stalled filesystem work and shares a pending probe", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: boolean | null) => void;
      const inspect = vi.fn(() => new Promise<boolean | null>((resolve) => { finish = resolve; }));
      const probe = createTranscriptProbe(inspect, 1, 500);
      const first = probe("a");
      const same = probe("a");
      const other = probe("b");
      await expect(other).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(500);
      await expect(first).resolves.toBeNull();
      await expect(same).resolves.toBeNull();
      await expect(probe("b")).resolves.toBeNull();
      expect(inspect).toHaveBeenCalledTimes(1);
      finish(true);
      await vi.advanceTimersByTimeAsync(0);
      const next = probe("b");
      await Promise.resolve();
      expect(inspect).toHaveBeenCalledTimes(2);
      finish(false);
      await expect(next).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
