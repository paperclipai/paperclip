import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

/**
 * TSMC-18806 / TSMC-18808 deliberate repro:
 * child exits before deferred stdin.write lands; without stdin.on("error")
 * the unhandled EPIPE on the stdin Socket kills the parent process.
 */
describe("runChildProcess stdin EPIPE guard (TSMC-18806)", () => {
  it("survives when the child dies before deferred prompt write completes", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "stdin-epipe-"));
    const commandPath = path.join(tmp, "die-before-read.mjs");
    // Exit immediately without reading stdin so the write end gets EPIPE.
    await fs.writeFile(
      commandPath,
      `#!/usr/bin/env node
process.exit(42);
`,
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);

    const largePrompt = "x".repeat(256 * 1024);
    const startedAt = Date.now();
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => {
      uncaught.push(err);
    };
    process.on("uncaughtException", onUncaught);

    try {
      const result = await runChildProcess(`stdin-epipe-repro-${startedAt}`, process.execPath, [commandPath], {
        cwd: tmp,
        env: process.env as Record<string, string>,
        // Large enough that the write is not always fully buffered before child death races.
        stdin: largePrompt,
        timeoutSec: 15,
        graceSec: 1,
        onLog: async () => {},
        // Hold spawnPersistPromise open long enough for the child to exit first.
        // The stdin write is deferred to this promise's finally().
        onSpawn: async ({ pid }) => {
          // Hard kill if it somehow lingered, then wait so exit wins the race.
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
          await new Promise((r) => setTimeout(r, 75));
        },
      });

      // Child failed (killed / non-zero). Parent must still be here.
      expect(result.exitCode === 42 || result.exitCode === null || result.signal != null).toBe(true);
      expect(uncaught.filter((e) => (e as NodeJS.ErrnoException).code === "EPIPE")).toEqual([]);
      expect(process.pid).toBeGreaterThan(0);
    } finally {
      process.off("uncaughtException", onUncaught);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("survives a burst of dying children under concurrent prompt writes", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "stdin-epipe-burst-"));
    const commandPath = path.join(tmp, "instant-exit.mjs");
    await fs.writeFile(commandPath, "process.exit(7);\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);

    try {
      const prompt = "y".repeat(128 * 1024);
      const runs = Array.from({ length: 12 }, (_, i) =>
        runChildProcess(`stdin-epipe-burst-${i}`, process.execPath, [commandPath], {
          cwd: tmp,
          env: process.env as Record<string, string>,
          stdin: prompt,
          timeoutSec: 10,
          graceSec: 1,
          onLog: async () => {},
          onSpawn: async ({ pid }) => {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // already gone
            }
            await new Promise((r) => setTimeout(r, 40 + i * 5));
          },
        }),
      );

      const results = await Promise.all(runs);
      expect(results).toHaveLength(12);
      for (const r of results) {
        expect(r.exitCode === 7 || r.exitCode === null || r.signal != null).toBe(true);
      }
      expect(uncaught.filter((e) => (e as NodeJS.ErrnoException).code === "EPIPE")).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
