import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { observedFaultSchedule, replayRecordFor, type TaskFaultLog } from "./scheduler.js";
import { worktreeFingerprint } from "./wave-guard.js";

describe("mid-wave worktree guard", () => {
  it("changes on rebuilt runner output, a re-edited dirty file, an edited untracked file or a rebuilt runner binary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chaos-wave-guard-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    try {
      git("init", "-q");
      git("config", "user.email", "chaos@example.invalid"); git("config", "user.name", "chaos");
      await writeFile(path.join(root, ".gitignore"), "dist/\nbin/\n");
      await writeFile(path.join(root, "server.ts"), "export const a = 1;\n");
      git("add", "."); git("commit", "-qm", "base");
      await mkdir(path.join(root, "dist/cli"), { recursive: true });
      await mkdir(path.join(root, "bin"), { recursive: true });
      await writeFile(path.join(root, "dist/cli/runner.js"), "one");
      await writeFile(path.join(root, "bin/runnerd"), "binary");
      const outputs = ["dist", "bin/runnerd"];
      const print = () => worktreeFingerprint(root, outputs);

      const clean = print();
      expect(print()).toBe(clean);
      await utimes(path.join(root, "dist/cli/runner.js"), new Date(), new Date(Date.now() + 5_000));
      const rebuilt = print();
      expect(rebuilt).not.toBe(clean);

      // A wave may start dirty; re-editing the same dirty file must still be caught.
      await writeFile(path.join(root, "server.ts"), "export const a = 2;\n");
      const dirty = print();
      await writeFile(path.join(root, "server.ts"), "export const a = 3;\n");
      expect(print()).not.toBe(dirty);

      await writeFile(path.join(root, "extra.ts"), "one");
      const untracked = print();
      await writeFile(path.join(root, "extra.ts"), "two");
      expect(print()).not.toBe(untracked);

      const beforeBinary = print();
      await utimes(path.join(root, "bin/runnerd"), new Date(), new Date(Date.now() + 9_000));
      expect(print()).not.toBe(beforeBinary);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("storm replay from the live fault log", () => {
  const faults = [
    { faultId: "f01", kind: "K1" as const, holdMs: 0, startedAt: 1_060_000, requestedBy: "storm" },
    { faultId: "f02", kind: "K6" as const, holdMs: 0, startedAt: 1_300_000, requestedBy: "storm" },
    { faultId: "f03", kind: "K4" as const, holdMs: 200_000, startedAt: 1_500_000, requestedBy: "storm" },
  ];
  const log: TaskFaultLog = { t07: { createdAt: 1_000_000, faultIds: ["f01", "f02"] } };

  it("replays the storm faults that crossed an ungraded task at their offsets from its launch", () => {
    const crossed = replayRecordFor("t07", null, log);
    expect(crossed).toEqual(log.t07);
    expect(observedFaultSchedule(crossed!.createdAt, crossed!.faultIds, faults, "t07"))
      .toEqual([{ kind: "K1", holdMs: 0, atMs: 60_000 }, { kind: "K6", holdMs: 0, atMs: 300_000 }]);
  });

  it("prefers the graded record and falls back to the log only when the grade has no faults", () => {
    const graded = { createdAt: 1_000_000, faultIds: ["f03"] };
    expect(replayRecordFor("t07", graded, log)).toBe(graded);
    expect(replayRecordFor("t07", { createdAt: 1_000_000, faultIds: [] }, log)).toEqual(log.t07);
    expect(replayRecordFor("t99", null, log)).toBeNull();
  });
});
