import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { writeAdapterExecutionTargetFile, type AdapterSandboxExecutionTarget } from "./execution-target.js";
import type { RunProcessResult } from "./server-utils.js";

const REMOTE_CWD = "/srv/paperclip/workspace";
const REMOTE_FILE = `${REMOTE_CWD}/.paperclip-runtime/grok/prompt.txt`;

type RunnerExecuteInput = Parameters<CommandManagedRuntimeRunner["execute"]>[0];

type ControlledRunnerOptions = {
  /** Bytes the fake target actually lands for each `cat > path` write. */
  storedBytes?: (content: Buffer) => Buffer;
  writeExitCode?: number;
  writeStderr?: string;
  /** Overrides the byte count the `wc -c` verification reports. */
  wcStdout?: string;
  wcExitCode?: number;
};

/** Pull the shell-quoted path out of a `sh -c` script after `marker`. */
function extractPath(script: string, marker: string): string {
  const index = script.indexOf(marker);
  const raw = script.slice(index + marker.length).trim();
  const quoted = raw.match(/^'(.*)'$/s);
  return quoted ? quoted[1] : raw;
}

/**
 * A controlled remote target: the real helper runs against it, and the fake
 * runner records what the host actually sends (argv, stdin) plus the bytes the
 * target lands. Failures are injected per case so a short write and a broken
 * verification both surface as errors instead of a silently partial prompt.
 */
function createControlledSandboxRunner(options: ControlledRunnerOptions = {}) {
  const files = new Map<string, Buffer>();
  const argvLogs: string[][] = [];
  const stdinLogs: string[] = [];
  const execute = async (input: RunnerExecuteInput): Promise<RunProcessResult> => {
    const args = input.args ?? [];
    const script = args.at(-1) ?? "";
    argvLogs.push(args);
    const startedAt = new Date().toISOString();
    const done = (stdout = "", exitCode = 0, stderr = ""): RunProcessResult => ({
      exitCode,
      signal: null,
      timedOut: false,
      stdout,
      stderr,
      pid: null,
      startedAt,
    });

    if (script.includes("cat >")) {
      const filePath = extractPath(script, "cat >");
      const content = Buffer.from(input.stdin ?? "", "utf8");
      stdinLogs.push(input.stdin ?? "");
      files.set(filePath, options.storedBytes ? options.storedBytes(content) : content);
      return done("", options.writeExitCode ?? 0, options.writeStderr ?? "");
    }
    if (script.includes("wc -c")) {
      if (options.wcStdout !== undefined) {
        return done(options.wcStdout, options.wcExitCode ?? 0);
      }
      const filePath = extractPath(script, "wc -c <");
      const stored = files.get(filePath);
      if (stored === undefined) {
        return done("", 1, `wc: ${filePath}: No such file or directory`);
      }
      return done(`${stored.byteLength}\n`, options.wcExitCode ?? 0);
    }
    return done("", 0);
  };

  const target: AdapterSandboxExecutionTarget = {
    kind: "remote",
    transport: "sandbox",
    environmentId: "env-1",
    leaseId: "lease-1",
    remoteCwd: REMOTE_CWD,
    timeoutMs: 30_000,
    runner: { execute },
  };
  return { target, files, argvLogs, stdinLogs };
}

describe("writeAdapterExecutionTargetFile", () => {
  it("lands UTF-8 bytes on a local target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-write-file-"));
    try {
      const filePath = path.join(root, "nested", "prompt.txt");
      const content = "Zażółć gęślą jaźń — ".repeat(16);

      await writeAdapterExecutionTargetFile("run-local", null, filePath, content, { cwd: root, env: {} });

      expect(await readFile(filePath, "utf8")).toBe(content);
      // The byte count is what the helper verifies: multi-byte characters must
      // be counted as UTF-8 bytes, not JS string length.
      expect((await stat(filePath)).size).toBe(Buffer.byteLength(content, "utf8"));
      expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(content.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams a remote prompt through stdin and verifies the landed bytes", async () => {
    const { target, files, argvLogs, stdinLogs } = createControlledSandboxRunner();
    const content = "wake prompt ".repeat(400);

    await writeAdapterExecutionTargetFile("run-remote", target, REMOTE_FILE, content, {
      cwd: REMOTE_CWD,
      env: {},
    });

    expect(files.get(REMOTE_FILE)?.toString("utf8")).toBe(content);
    // One write attempt plus one `wc -c` verification.
    expect(argvLogs).toHaveLength(2);
    // The prompt must never travel as a command-line argument: a single argv
    // entry at MAX_ARG_STRLEN (131072 B) makes spawn fail with E2BIG.
    for (const argv of argvLogs) {
      expect(argv.join(" ")).not.toContain("wake prompt wake prompt");
    }
    expect(stdinLogs[0]).toBe(content);
  });

  it("rejects when the target lands fewer bytes than were sent", async () => {
    const content = "truncated prompt ".repeat(64);
    const expectedBytes = Buffer.byteLength(content, "utf8");
    const landedBytes = Math.floor(expectedBytes / 2);
    const { target, files } = createControlledSandboxRunner({
      storedBytes: (buffer) => buffer.subarray(0, landedBytes),
    });

    await expect(
      writeAdapterExecutionTargetFile("run-short", target, REMOTE_FILE, content, {
        cwd: REMOTE_CWD,
        env: {},
      }),
    ).rejects.toThrow(`landed ${landedBytes} of ${expectedBytes} bytes`);
    expect(files.get(REMOTE_FILE)?.byteLength).toBe(landedBytes);
  });

  it("rejects when the verification reports an unreadable size", async () => {
    const content = "prompt under verification";
    const { target } = createControlledSandboxRunner({ wcStdout: "not-a-number\n" });

    await expect(
      writeAdapterExecutionTargetFile("run-unreadable", target, REMOTE_FILE, content, {
        cwd: REMOTE_CWD,
        env: {},
      }),
    ).rejects.toThrow(
      `landed an unreadable size of ${Buffer.byteLength(content, "utf8")} bytes`,
    );
  });

  it("rejects when the verification command itself fails", async () => {
    const content = "prompt with failing wc";
    const { target } = createControlledSandboxRunner({
      wcStdout: `${Buffer.byteLength(content, "utf8")}\n`,
      wcExitCode: 1,
    });

    await expect(
      writeAdapterExecutionTargetFile("run-wc-fails", target, REMOTE_FILE, content, {
        cwd: REMOTE_CWD,
        env: {},
      }),
    ).rejects.toThrow(
      `landed ${Buffer.byteLength(content, "utf8")} of ${Buffer.byteLength(content, "utf8")} bytes`,
    );
  });

  it("rejects when the remote write command fails", async () => {
    const { target } = createControlledSandboxRunner({
      writeExitCode: 1,
      writeStderr: "cat: write error: No space left on device",
    });

    await expect(
      writeAdapterExecutionTargetFile("run-write-fails", target, REMOTE_FILE, "prompt", {
        cwd: REMOTE_CWD,
        env: {},
      }),
    ).rejects.toThrow(
      `Failed to write "${REMOTE_FILE}" on the remote target: cat: write error: No space left on device`,
    );
  });

  it("rejects a relative path on a remote target before spawning anything", async () => {
    const { target, argvLogs } = createControlledSandboxRunner();

    await expect(
      writeAdapterExecutionTargetFile("run-relative", target, "relative/prompt.txt", "prompt", {
        cwd: REMOTE_CWD,
        env: {},
      }),
    ).rejects.toThrow("absolute POSIX path");
    expect(argvLogs).toHaveLength(0);
  });
});