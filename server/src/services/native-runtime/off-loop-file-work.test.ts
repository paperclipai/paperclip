import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRemotePaperclipRunnerBinary } from "./native-codex-runner.js";
import { stageRemoteRunnerDirectory, syncRemoteRunnerDirectoryOut } from "./native-session-executor.js";
import {
  binaryTargetFromHeader,
  cachedFileSha256,
  clearCachedFileSha256,
  execFileBuffered,
} from "./off-loop-file-work.js";

// Measures the longest gap between 10 ms timer ticks while `work` runs. A
// synchronous read or child process stops every tick for its whole duration.
async function longestTimerGapDuring(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 10);
  try {
    await work();
    const now = performance.now();
    longest = Math.max(longest, now - last);
  } finally {
    clearInterval(timer);
  }
  return longest;
}

// An ELF64 little-endian x86-64 header, padded like a small executable.
const linuxX64Header = () => {
  const bytes = Buffer.alloc(4096);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
  bytes.writeUInt16LE(62, 18);
  return bytes;
};

const SLOW_MS = 2_500;
// Generous for a loaded CI runner, and well below one blocked slow step.
const RESPONSIVE_GAP_MS = 1_500;
const SLOW_TEST_TIMEOUT_MS = 30_000;

// The fixtures use POSIX tools (mkfifo, sh, sleep, find); the controller
// paths under test are the Linux and macOS ones.
describe.skipIf(process.platform === "win32")("run-path file work stays off the event loop", () => {
  let root: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "paperclip-off-loop-"));
    originalPath = process.env.PATH;
    clearCachedFileSha256();
  });
  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });

  // Every `tar` the server starts now takes SLOW_MS longer, like a slow disk.
  const slowTar = () => {
    const realTar = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
    const bin = join(root, "slow-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tar"), `#!/bin/sh\nsleep ${SLOW_MS / 1000}\nexec '${realTar}' "$@"\n`);
    chmodSync(join(bin, "tar"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
  };

  it("checks the remote daemon's target without blocking while its file is slow to read", async () => {
    // A FIFO whose writer waits stands in for a binary on a stalled disk.
    const binary = join(root, "paperclip-runnerd");
    execFileSync("mkfifo", [binary]);
    const header = join(root, "header");
    writeFileSync(header, linuxX64Header());
    const writer = spawn("sh", ["-c", `sleep ${SLOW_MS / 1000}; cat '${header}' > '${binary}'`], { stdio: "ignore" });
    const runner = { execute: async () => ({ stdout: "Linux\nx86_64\n", stderr: "", exitCode: 0, timedOut: false }) };

    let resolved = "";
    const gap = await longestTimerGapDuring(async () => {
      resolved = await resolveRemotePaperclipRunnerBinary({ runner: runner as never, remoteCwd: "/workspace", configuredPath: binary });
    });
    writer.kill();

    expect(resolved).toBe(binary);
    expect(gap).toBeLessThan(RESPONSIVE_GAP_MS);
  }, SLOW_TEST_TIMEOUT_MS);

  it("archives a staged directory without blocking while tar is slow", async () => {
    slowTar();
    const source = join(root, "source");
    mkdirSync(join(source, "keep"), { recursive: true });
    mkdirSync(join(source, "skip"), { recursive: true });
    writeFileSync(join(source, "keep", "file.txt"), "kept");
    writeFileSync(join(source, "skip", "file.txt"), "skipped");
    let staged: string[] = [];
    const runner = {
      execute: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      syncIn: async (operations: Array<{ files: Array<{ sourcePath: string }> }>) => {
        const sourcePath = operations[0]!.files[0]!.sourcePath;
        staged = execFileSync("find", [".", "-type", "f"], { cwd: sourcePath, encoding: "utf8" }).trim().split("\n");
      },
    };

    const gap = await longestTimerGapDuring(() => stageRemoteRunnerDirectory({
      target: { kind: "remote" } as never, runner: runner as never,
      sourcePath: source, targetPath: "/remote/target", mode: 0o700, excludeEntries: ["skip"],
    }));

    expect(staged).toEqual(["./keep/file.txt"]);
    expect(gap).toBeLessThan(RESPONSIVE_GAP_MS);
  }, SLOW_TEST_TIMEOUT_MS);

  it("checks and installs a copied-back checkpoint without blocking while tar is slow", async () => {
    const payload = join(root, "payload");
    mkdirSync(join(payload, "state"), { recursive: true });
    writeFileSync(join(payload, "state", "session.json"), "{\"ok\":true}");
    const archive = execFileSync("tar", ["-czf", "-", "-C", payload, "."]);
    slowTar();
    const runner = {
      execute: async ({ args }: { args: string[] }) => args[1]?.includes("base64")
        ? { stdout: archive.toString("base64"), stderr: "", exitCode: 0, timedOut: false }
        : { stdout: "", stderr: "", exitCode: 0, timedOut: false },
    };
    const target = join(root, "checkpoint");

    const gap = await longestTimerGapDuring(() => syncRemoteRunnerDirectoryOut({
      runner: runner as never, sourcePath: "/remote/state", targetPath: target, mode: 0o700,
    }));

    expect(readFileSync(join(target, "state", "session.json"), "utf8")).toBe("{\"ok\":true}");
    expect(gap).toBeLessThan(RESPONSIVE_GAP_MS);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe.skipIf(process.platform === "win32")("off-loop file helpers", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "paperclip-off-loop-helpers-"));
    clearCachedFileSha256();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reuses a binary digest until the file changes", async () => {
    const binary = join(root, "runnerd");
    writeFileSync(binary, "first");
    const first = await cachedFileSha256(binary);
    expect(first).toBe(`sha256:${createHash("sha256").update("first").digest("hex")}`);
    expect(await cachedFileSha256(binary)).toBe(first);

    writeFileSync(binary, "second");
    utimesSync(binary, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    expect(await cachedFileSha256(binary)).toBe(`sha256:${createHash("sha256").update("second").digest("hex")}`);
  });

  it("classifies a binary from its header, or from the whole file when the header cannot answer", async () => {
    const elf = join(root, "elf");
    writeFileSync(elf, linuxX64Header());
    const lengths: number[] = [];
    const classify = (bytes: Buffer) => {
      lengths.push(bytes.length);
      return bytes.length >= 70_000 ? "whole-file" : bytes[0] === 0x7f ? "header" : null;
    };
    expect(await binaryTargetFromHeader(elf, classify)).toBe("header");

    const large = join(root, "large");
    writeFileSync(large, Buffer.alloc(70_000));
    lengths.length = 0;
    expect(await binaryTargetFromHeader(large, classify)).toBe("whole-file");
    expect(lengths).toEqual([64 * 1024, 70_000]);
  });

  it("rejects like execFileSync on a non-zero exit, a timeout, and output past maxBuffer", async () => {
    expect((await execFileBuffered("sh", ["-c", "cat"], { input: Buffer.from("echo"), maxBuffer: 1024 })).toString()).toBe("echo");
    await expect(execFileBuffered("sh", ["-c", "exit 3"], { maxBuffer: 1024 })).rejects.toMatchObject({ code: 3 });
    await expect(execFileBuffered("sh", ["-c", "sleep 5"], { maxBuffer: 1024, timeout: 100 })).rejects.toMatchObject({ killed: true });
    await expect(execFileBuffered("sh", ["-c", "head -c 4096 /dev/zero"], { maxBuffer: 1024 }))
      .rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });
});
