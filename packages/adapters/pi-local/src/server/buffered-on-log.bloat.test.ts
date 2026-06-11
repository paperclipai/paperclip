import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBufferedOnLog, type LogStream } from "./buffered-on-log.js";
import { parsePiJsonl } from "./parse.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/fixtures/fake-pi-bloat.mjs", import.meta.url),
);

interface Run {
  persistedLogPath: string;
  fullStdout: string;
  cleanup: () => Promise<void>;
}

/**
 * Spawns the fake-pi-bloat fixture and pipes its stdout through
 * createBufferedOnLog into a temp file (modeling the heartbeat → run-log-store
 * pipeline). Returns the persisted log path + full unfiltered stdout for
 * separate verification.
 */
async function runFakePi(
  turns: number,
  increment: number,
  options: { toolresultBytes?: number } = {},
): Promise<Run> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-bloat-test-"));
  const persistedLogPath = path.join(dir, "run.ndjson");
  await writeFile(persistedLogPath, "");

  const fullStdoutChunks: Buffer[] = [];
  const onLog = async (stream: LogStream, chunk: string) => {
    if (stream === "stdout") {
      // Append filtered chunk to persisted log, matching what
      // run-log-store.append() does in production.
      const fs = await import("node:fs/promises");
      await fs.appendFile(persistedLogPath, chunk);
    }
  };
  const buffered = createBufferedOnLog(onLog);

  const fixtureArgs = [FIXTURE, `--turns=${turns}`, `--increment=${increment}`];
  if (options.toolresultBytes && options.toolresultBytes > 0) {
    fixtureArgs.push(`--toolresult-bytes=${options.toolresultBytes}`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, fixtureArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data: Buffer) => {
      fullStdoutChunks.push(data);
      // Schedule async handling without blocking the data event loop.
      void buffered.handle("stdout", data.toString("utf8"));
    });
    child.stderr.on("data", () => {
      // Ignore stderr in this fixture — fake-pi is silent there.
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      try {
        await buffered.flush();
        if (code === 0) resolve();
        else reject(new Error(`fake-pi exited ${code}`));
      } catch (err) {
        reject(err);
      }
    });
  });

  return {
    persistedLogPath,
    fullStdout: Buffer.concat(fullStdoutChunks).toString("utf8"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("bufferedOnLog × fake-pi-bloat fixture", () => {
  it("strips O(n²) delta bloat while preserving consolidated content", async () => {
    // 50 turns × 256B increment. The unfiltered stream grows quadratically
    // because each delta carries the full prior accumulated state; the
    // filter should strip all *_delta lines and leave only the structural
    // events plus the consolidated thinking_end / turn_end / agent_end.
    const run = await runFakePi(50, 256);
    try {
      const persistedSize = (await stat(run.persistedLogPath)).size;
      const persisted = await readFile(run.persistedLogPath, "utf8");

      // No delta lines made it to disk.
      expect(persisted).not.toContain("thinking_delta");
      expect(persisted).not.toContain("text_delta");
      expect(persisted).not.toContain("toolcall_delta");
      // Structural + consolidated events did.
      expect(persisted).toContain("agent_start");
      expect(persisted).toContain("turn_end");
      expect(persisted).toContain("agent_end");
      expect(persisted).toContain("thinking_end");

      // The wrapper should produce at least an order-of-magnitude smaller
      // log than the unfiltered stream — that's the bug we're fixing.
      const ratio = run.fullStdout.length / persistedSize;
      expect(ratio).toBeGreaterThan(10);
    } finally {
      await run.cleanup();
    }
  }, 15_000);

  it("keeps parsePiJsonl extraction intact when run on the full unfiltered stdout", async () => {
    const run = await runFakePi(20, 512);
    try {
      const parsed = parsePiJsonl(run.fullStdout);
      expect(parsed.finalMessage).toBe("Done thinking. Here is the answer.");
      expect(parsed.usage.inputTokens).toBe(100);
      expect(parsed.usage.outputTokens).toBe(50);
      expect(parsed.usage.costUsd).toBeCloseTo(0.001);
      expect(parsed.errors).toEqual([]);
    } finally {
      await run.cleanup();
    }
  }, 15_000);

  it("bounds an oversize tool_execution_end result and strips the duplicate in turn_end", async () => {
    // 5 MiB is 64× the 80 KiB head+tail budget — well into the regime where
    // truncation must engage. Smaller than the 64 MiB partial-buffer cap so
    // the line accumulates fully and the rewriter can run on it.
    const toolresultBytes = 5 * 1024 * 1024;
    const run = await runFakePi(1, 16, { toolresultBytes });
    try {
      const persistedSize = (await stat(run.persistedLogPath)).size;
      const persisted = await readFile(run.persistedLogPath, "utf8");

      // Truncation marker present, original payload size logged.
      expect(persisted).toContain("[paperclip] dropped");
      expect(persisted).toContain("tool_execution_end");
      // Hard ceiling — head (64 KiB) + tail (16 KiB) + JSON overhead, one
      // line. 200 KiB is comfortable headroom and would fail if either the
      // tool result truncation or the turn_end strip regressed.
      expect(persistedSize).toBeLessThan(200 * 1024);

      // parsePiJsonl still recovers a single tool call with the truncated
      // result; downstream consumers stay happy.
      const parsed = parsePiJsonl(persisted);
      expect(parsed.toolCalls).toHaveLength(1);
      const call = parsed.toolCalls[0]!;
      expect(call.toolName).toBe("Bash");
      expect(call.isError).toBe(false);
      expect(call.result).not.toBeNull();
      expect(call.result!).toContain("[paperclip] dropped");
      // 80 KiB head+tail + the marker line. Stay well under 100 KiB.
      expect(call.result!.length).toBeLessThan(100 * 1024);
    } finally {
      await run.cleanup();
    }
  }, 30_000);
});
