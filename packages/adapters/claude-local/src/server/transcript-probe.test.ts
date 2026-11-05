import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTranscriptProbe, probeClaudeTranscript, resolveTranscriptConfigDir } from "./transcript-probe.js";

describe("transcript probe", () => {
  it.skipIf(process.platform === "win32")("finds the transcript under the real path of a symlinked workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-transcript-link-"));
    try {
      const real = path.join(root, "real");
      const link = path.join(root, "link");
      const config = path.join(root, "config");
      await fs.mkdir(real);
      await fs.symlink(real, link);
      const encoded = (await fs.realpath(real)).replace(/[^a-zA-Z0-9-]/g, "-");
      await fs.mkdir(path.join(config, "projects", encoded), { recursive: true });
      await fs.writeFile(path.join(config, "projects", encoded, "session.jsonl"), "{}");
      expect(await probeClaudeTranscript({ configDir: config, cwd: link, sessionId: "session" })).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
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
