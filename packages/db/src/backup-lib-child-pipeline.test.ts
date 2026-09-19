import { describe, expect, it } from "vitest";
import { settleBackupChildPipeline } from "./backup-lib.js";

// SIN-70819 AC2: the stdout→gzip pipeline and the child-exit watcher race. The
// child-exit watcher carries the REAL failure (captured pg_dump stderr, e.g. a
// server-version mismatch); the gzip pipeline tends to reject first with a
// generic stream error. settleBackupChildPipeline must always surface the
// child-exit error over the pipeline noise, and never leak an unhandled
// rejection when both halves reject.
describe("settleBackupChildPipeline", () => {
  it("prefers the child-exit error (real stderr) over a generic pipeline error", async () => {
    const pipelineError = new Error("Premature close");
    const childExitError = new Error(
      "pg_dump failed with exit code 1: pg_dump: error: server version: 18.0; pg_dump version: 16.9",
    );
    await expect(
      settleBackupChildPipeline(Promise.reject(pipelineError), Promise.reject(childExitError)),
    ).rejects.toThrow("server version: 18.0");
  });

  it("surfaces a spawn ENOENT child-exit error over the pipeline error", async () => {
    const pipelineError = new Error("Premature close");
    const spawnError = Object.assign(new Error("spawn pg_dump ENOENT"), { code: "ENOENT" });
    await expect(
      settleBackupChildPipeline(Promise.reject(pipelineError), Promise.reject(spawnError)),
    ).rejects.toThrow("ENOENT");
  });

  it("surfaces the pipeline error when the child process exited cleanly", async () => {
    const pipelineError = new Error("ENOSPC: no space left on device");
    await expect(
      settleBackupChildPipeline(Promise.reject(pipelineError), Promise.resolve()),
    ).rejects.toThrow("ENOSPC");
  });

  it("surfaces the child-exit error when the pipeline resolved", async () => {
    const childExitError = new Error("pg_dump exited via SIGKILL");
    await expect(
      settleBackupChildPipeline(Promise.resolve(), Promise.reject(childExitError)),
    ).rejects.toThrow("SIGKILL");
  });

  it("resolves when both halves succeed", async () => {
    await expect(
      settleBackupChildPipeline(Promise.resolve("gz-done"), Promise.resolve()),
    ).resolves.toBeUndefined();
  });

  it("consumes both rejections (no unhandled rejection) and still throws child error", async () => {
    // Both reject on the same tick; allSettled awaits both before we throw, so the
    // pipeline rejection is consumed and cannot become an unhandled rejection.
    let unhandled: unknown;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        settleBackupChildPipeline(
          Promise.reject(new Error("pipeline noise")),
          Promise.reject(new Error("real child failure")),
        ),
      ).rejects.toThrow("real child failure");
      // Give the microtask queue a chance to flush any stray rejection.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
