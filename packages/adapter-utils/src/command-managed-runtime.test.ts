import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCommandManagedRuntimeClient,
  prepareCommandManagedRuntime,
  type CommandManagedRuntimeRunner,
} from "./command-managed-runtime.js";
import type { RunProcessResult } from "./server-utils.js";

const execFile = promisify(execFileCallback);

interface SpawnRunnerHandle {
  runner: CommandManagedRuntimeRunner;
  calls: Array<{ command: string; args?: string[]; cwd?: string; stdin?: string }>;
}

// A runner that actually executes the shell scripts (piping stdin through a real
// pipe so multi-MB payloads work) and replays stdout through onLog in several
// chunks so the streaming readFile byte-counter is exercised.
function makeSpawnRunner(options: {
  supportsSingleStreamStdinProgress?: boolean;
  maxStdoutBytes?: number;
} = {}): SpawnRunnerHandle {
  const calls: Array<{ command: string; args?: string[]; cwd?: string; stdin?: string }> = [];
  const runner: CommandManagedRuntimeRunner = {
    supportsSingleStreamStdinProgress: options.supportsSingleStreamStdinProgress,
    execute: async (input) =>
      await new Promise<RunProcessResult>((resolve) => {
        calls.push({ command: input.command, args: input.args, cwd: input.cwd, stdin: input.stdin });
        const startedAt = new Date().toISOString();
        const command =
          input.command === "sh" ? "/bin/sh" : input.command === "bash" ? "/bin/bash" : input.command;
        const child = spawn(command, input.args ?? [], {
          cwd: input.cwd,
          env: { ...process.env, ...input.env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", () => {
          resolve({ exitCode: 127, signal: null, timedOut: false, stdout, stderr, pid: null, startedAt });
        });
        child.on("close", async (code) => {
          if (
            options.maxStdoutBytes != null &&
            Buffer.byteLength(stdout, "utf8") > options.maxStdoutBytes
          ) {
            resolve({
              exitCode: 1,
              signal: null,
              timedOut: false,
              stdout,
              stderr: `stdout exceeded ${options.maxStdoutBytes} bytes`,
              pid: child.pid ?? null,
              startedAt,
            });
            return;
          }
          if (input.onLog && stdout.length > 0) {
            const chunkSize = Math.max(1, Math.ceil(stdout.length / 4));
            for (let offset = 0; offset < stdout.length; offset += chunkSize) {
              await input.onLog("stdout", stdout.slice(offset, offset + chunkSize));
            }
          }
          resolve({
            exitCode: code ?? 0,
            signal: null,
            timedOut: false,
            stdout,
            stderr,
            pid: child.pid ?? null,
            startedAt,
          });
        });
        if (input.stdin != null) child.stdin.write(input.stdin);
        child.stdin.end();
      }),
  };
  return { runner, calls };
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer;
}

async function withBase64StringByteLimit<T>(limitBytes: number, fn: () => Promise<T>): Promise<T> {
  const originalToString = Buffer.prototype.toString;
  Buffer.prototype.toString = function patchedToString(
    this: Buffer,
    encoding?: BufferEncoding,
    start?: number,
    end?: number,
  ) {
    if (encoding === "base64" && this.byteLength > limitBytes) {
      throw new Error(`test guard: attempted to base64-encode ${this.byteLength} bytes at once`);
    }
    return originalToString.call(this, encoding, start, end);
  } as typeof Buffer.prototype.toString;
  try {
    return await fn();
  } finally {
    Buffer.prototype.toString = originalToString;
  }
}

describe("command managed runtime", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps the runtime overlay out of sandbox workspace sync by default", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-command-runtime-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(path.join(localWorkspaceDir, ".paperclip-runtime"), { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "local workspace\n", "utf8");
    await writeFile(path.join(localWorkspaceDir, ".paperclip-runtime", "state.json"), "{\"keep\":true}\n", "utf8");

    const calls: Array<{
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs?: number;
    }> = [];
    const runner = {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
      }): Promise<RunProcessResult> => {
        calls.push({ ...input });
        const startedAt = new Date().toISOString();
        const env = {
          ...process.env,
          ...input.env,
        };
        const command =
          input.command === "sh" ? "/bin/sh" : input.command === "bash" ? "/bin/bash" : input.command;
        const args = [...(input.args ?? [])];
        if (
          input.stdin != null &&
          (input.command === "sh" || input.command === "bash") &&
          (args[0] === "-c" || args[0] === "-lc") &&
          typeof args[1] === "string"
        ) {
          env.PAPERCLIP_TEST_STDIN = input.stdin;
          args[1] = `printf '%s' \"$PAPERCLIP_TEST_STDIN\" | (${args[1]})`;
        }
        try {
          const result = await execFile(command, args, {
            cwd: input.cwd,
            env,
            maxBuffer: 32 * 1024 * 1024,
            timeout: input.timeoutMs,
          });
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: result.stdout,
            stderr: result.stderr,
            pid: null,
            startedAt,
          };
        } catch (error) {
          const err = error as NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
            code?: string | number | null;
            signal?: NodeJS.Signals | null;
            killed?: boolean;
          };
          return {
            exitCode: typeof err.code === "number" ? err.code : null,
            signal: err.signal ?? null,
            timedOut: Boolean(err.killed && input.timeoutMs),
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? "",
            pid: null,
            startedAt,
          };
        }
      },
    };

    const prepared = await prepareCommandManagedRuntime({
      runner,
      spec: {
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      },
      adapterKey: "claude",
      workspaceLocalDir: localWorkspaceDir,
    });

    await expect(readFile(path.join(remoteWorkspaceDir, "README.md"), "utf8")).resolves.toBe("local workspace\n");
    await expect(readFile(path.join(remoteWorkspaceDir, ".paperclip-runtime", "state.json"), "utf8")).rejects
      .toMatchObject({ code: "ENOENT" });
    // The single-stream upload pipes the tarball through exactly one stdin-backed
    // process (the speed fix); nothing else streams stdin.
    expect(calls.filter((call) => call.stdin != null).length).toBe(1);

    await mkdir(path.join(remoteWorkspaceDir, ".paperclip-runtime"), { recursive: true });
    await writeFile(path.join(remoteWorkspaceDir, "README.md"), "remote workspace\n", "utf8");
    await writeFile(path.join(remoteWorkspaceDir, ".paperclip-runtime", "remote-state.json"), "{\"remote\":true}\n", "utf8");
    await prepared.restoreWorkspace();

    await expect(readFile(path.join(localWorkspaceDir, "README.md"), "utf8")).resolves.toBe("remote workspace\n");
    await expect(readFile(path.join(localWorkspaceDir, ".paperclip-runtime", "state.json"), "utf8")).resolves
      .toBe("{\"keep\":true}\n");
    await expect(readFile(path.join(localWorkspaceDir, ".paperclip-runtime", "remote-state.json"), "utf8")).rejects
      .toMatchObject({ code: "ENOENT" });
    // Restore streams the download through `base64`/onLog (no stdin), so the only
    // stdin-backed call remains the single upload from prepare.
    expect(calls.filter((call) => call.stdin != null).length).toBe(1);
  });

  it("runs setup commands from a stable root cwd when staging into a nested remote workspace dir", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-command-runtime-nested-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteBaseDir = path.join(rootDir, "remote-base");
    const remoteWorkspaceDir = path.join(remoteBaseDir, ".paperclip-runtime", "runs", "test", "workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteBaseDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "local workspace\n", "utf8");

    const { runner, calls } = makeSpawnRunner();

    await prepareCommandManagedRuntime({
      runner,
      spec: {
        remoteCwd: remoteBaseDir,
        timeoutMs: 30_000,
      },
      adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir,
      workspaceRemoteDir: remoteWorkspaceDir,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.cwd === "/")).toBe(true);
    await expect(readFile(path.join(remoteWorkspaceDir, "README.md"), "utf8")).resolves.toBe("local workspace\n");
  });

  it("uploads a multi-MB payload in a single process and preserves exact bytes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-command-write-"));
    cleanupDirs.push(rootDir);
    const remotePath = path.join(rootDir, "nested", "payload.bin");

    // ~3 MB of every byte value so the test catches any non-binary-safe handling.
    const payload = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;

    const { runner, calls } = makeSpawnRunner({ supportsSingleStreamStdinProgress: true });
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 30_000 });

    const progress: Array<{ done: number; total: number | null }> = [];
    await withBase64StringByteLimit(4 * 1024 * 1024, async () => {
      await client.writeFile(remotePath, toArrayBuffer(payload), {
        onProgress: (done, total) => {
          progress.push({ done, total });
        },
      });
    });

    // Exactly one upload process: O(1) round-trips regardless of payload size.
    expect(calls.length).toBe(1);
    expect(calls[0].stdin).toBeTypeOf("string");

    const written = await readFile(remotePath);
    expect(written.equals(payload)).toBe(true);

    // Progress is monotonically non-decreasing and reaches the total.
    expect(progress.length).toBeGreaterThan(0);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].done).toBeGreaterThanOrEqual(progress[i - 1].done);
    }
    expect(progress.at(-1)).toEqual({ done: payload.length, total: payload.length });
  });

  it("falls back to chunked upload progress when the runner cannot report mid-stream stdin progress", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-command-write-fallback-"));
    cleanupDirs.push(rootDir);
    const remotePath = path.join(rootDir, "nested", "payload.bin");

    const payload = Buffer.alloc(12 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;

    const { runner, calls } = makeSpawnRunner({ supportsSingleStreamStdinProgress: false });
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 30_000 });

    const progress: Array<{ done: number; total: number | null }> = [];
    await client.writeFile(remotePath, toArrayBuffer(payload), {
      onProgress: (done, total) => {
        progress.push({ done, total });
      },
    });

    const written = await readFile(remotePath);
    expect(written.equals(payload)).toBe(true);

    // Provider-backed sandbox runners cannot surface mid-flight progress for a
    // single stdin RPC, so we intentionally use several large append commands.
    expect(calls.length).toBeGreaterThan(2);
    const stdinCalls = calls.filter((call) => call.stdin != null);
    expect(stdinCalls.length).toBeGreaterThan(2);
    expect(stdinCalls.every((call) => Buffer.byteLength(call.stdin ?? "", "utf8") <= 4.1 * 1024 * 1024)).toBe(true);
    expect(progress.length).toBeGreaterThan(2);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].done).toBeGreaterThanOrEqual(progress[i - 1].done);
    }
    expect(progress.at(-1)).toEqual({ done: payload.length, total: payload.length });
  });

  it("falls back to bounded chunks when the runner does not explicitly opt in", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-command-write-fallback-no-progress-"));
    cleanupDirs.push(rootDir);
    const remotePath = path.join(rootDir, "nested", "payload.bin");

    const payload = Buffer.alloc(12 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;

    const { runner, calls } = makeSpawnRunner();
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 30_000 });

    await withBase64StringByteLimit(4 * 1024 * 1024, async () => {
      await client.writeFile(remotePath, toArrayBuffer(payload));
    });

    const written = await readFile(remotePath);
    expect(written.equals(payload)).toBe(true);

    // A runner that doesn't mark single-stream stdin support must avoid passing
    // the whole base64 archive as one string, so we expect multiple append calls.
    const stdinCalls = calls.filter((call) => call.stdin != null);
    expect(stdinCalls.length).toBeGreaterThan(1);
    expect(stdinCalls.every((call) => Buffer.byteLength(call.stdin ?? "", "utf8") <= 4.1 * 1024 * 1024)).toBe(true);
  });

  it("downloads in bounded stdout chunks and reports monotonic byte progress to the total", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-command-read-"));
    cleanupDirs.push(rootDir);
    const remotePath = path.join(rootDir, "download.bin");

    const payload = Buffer.alloc(7 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 256;
    await writeFile(remotePath, payload);

    const { runner, calls } = makeSpawnRunner({ maxStdoutBytes: 5 * 1024 * 1024 });
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 30_000 });

    const progress: Array<{ done: number; total: number | null }> = [];
    const bytes = await client.readFile(remotePath, {
      onProgress: (done, total) => {
        progress.push({ done, total });
      },
    });

    expect(Buffer.from(bytes as ArrayBuffer).equals(payload)).toBe(true);

    // The old single `base64 < file` path would exceed the runner's stdout cap.
    // The bounded path reads with several small `dd | base64` commands instead.
    expect(calls.some((call) => call.args?.join(" ").includes("base64 <"))).toBe(false);
    expect(calls.filter((call) => call.args?.join(" ").includes("dd if=")).length).toBeGreaterThan(1);
    expect(progress.length).toBeGreaterThan(1);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].done).toBeGreaterThanOrEqual(progress[i - 1].done);
    }
    expect(progress.every((entry) => entry.total === payload.length)).toBe(true);
    expect(progress.at(-1)?.done).toBe(payload.length);
  });

  it("includes stdout diagnostics when a managed runtime command fails", async () => {
    const startedAt = new Date().toISOString();
    const runner: CommandManagedRuntimeRunner = {
      execute: async () => ({
        exitCode: 2,
        signal: null,
        timedOut: false,
        stdout: "tar: workspace-download.tar: Cannot open: Permission denied\n",
        stderr: "",
        pid: null,
        startedAt,
      }),
    };
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 30_000 });

    await expect(client.run("tar -cf workspace-download.tar .", { timeoutMs: 30_000 })).rejects.toThrow(
      /stdout: tar: workspace-download\.tar: Cannot open: Permission denied/,
    );
  });
});
