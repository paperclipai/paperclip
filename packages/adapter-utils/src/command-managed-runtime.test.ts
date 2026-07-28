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
import type { SandboxSyncOperation } from "./sandbox-managed-runtime.js";
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

function shellQuoteForTest(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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

  it("stages runtime assets without replacing or restoring an in-place workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-command-runtime-assets-only-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localHomeDir = path.join(rootDir, "local-home");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await mkdir(localHomeDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "local workspace\n", "utf8");
    await writeFile(path.join(remoteWorkspaceDir, "README.md"), "authoritative workspace\n", "utf8");
    await writeFile(path.join(localHomeDir, "auth.json"), '{"token":"host"}\n', "utf8");

    const { runner } = makeSpawnRunner();
    let restoredAuth = "";
    const prepared = await prepareCommandManagedRuntime({
      runner,
      spec: {
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      },
      adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir,
      syncWorkspace: false,
      assets: [
        {
          key: "home",
          localDir: localHomeDir,
          restore: async ({ assetDir, readFile }) => {
            restoredAuth = (await readFile(path.join(assetDir, "auth.json"))).toString("utf8");
          },
        },
      ],
    });

    expect(prepared.workspaceRemoteDir).toBe(remoteWorkspaceDir);
    expect(prepared.assetDirs.home).toBe(path.join(remoteWorkspaceDir, ".paperclip-runtime", "codex", "home"));
    await expect(readFile(path.join(remoteWorkspaceDir, "README.md"), "utf8")).resolves.toBe(
      "authoritative workspace\n",
    );
    await expect(readFile(path.join(prepared.assetDirs.home, "auth.json"), "utf8")).resolves.toBe(
      '{"token":"host"}\n',
    );

    await writeFile(path.join(prepared.assetDirs.home, "auth.json"), '{"token":"remote"}\n', "utf8");
    await prepared.restoreWorkspace();

    expect(restoredAuth).toBe('{"token":"remote"}\n');
    await expect(readFile(path.join(localWorkspaceDir, "README.md"), "utf8")).resolves.toBe(
      "local workspace\n",
    );
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
    expect(calls.length).toBe(2);
    expect(calls[1].args?.join(" ")).toContain("rm -rf");
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

  it("stages a single-file write to <path>.paperclip-upload then atomically renames it (single-stream path)", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-command-atomic-"));
    cleanupDirs.push(rootDir);
    const remotePath = path.join(rootDir, "nested", "payload.bin");

    const { runner, calls } = makeSpawnRunner({ supportsSingleStreamStdinProgress: true });
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 30_000 });
    await client.writeFile(remotePath, toArrayBuffer(Buffer.from("hello atomic\n")));

    // Characterization guardrail: the legacy single-file transport must keep its
    // stage-then-atomic-rename shape (temp .paperclip-upload + `mv -f`).
    const script = (calls[0].args ?? []).join(" ");
    expect(script).toContain(`${remotePath}.paperclip-upload`);
    expect(script).toContain(`trap cleanup EXIT`);
    expect(script).toContain(`mv -f`);
    expect(script.indexOf(".paperclip-upload")).toBeLessThan(script.indexOf("mv -f"));
    expect(await readFile(remotePath, "utf8")).toBe("hello atomic\n");
  });

  it("cleans up a staged upload when rename fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-command-upload-cleanup-"));
    cleanupDirs.push(rootDir);
    const remotePath = path.join(rootDir, "nested", "payload.bin");

    const payload = Buffer.alloc(3 * 1024 * 1024, 7);
    const { runner, calls } = makeSpawnRunner({ supportsSingleStreamStdinProgress: true });
    const delegatedExecute = runner.execute.bind(runner);
    runner.execute = async (input) => {
      const script = (input.args ?? []).join(" ");
      if (script.includes("mv -f") && script.includes(".paperclip-upload.")) {
        calls.push({ command: input.command, args: input.args, cwd: input.cwd, stdin: input.stdin });
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "rename failed",
          pid: null,
          startedAt: new Date().toISOString(),
        };
      }
      return await delegatedExecute(input);
    };
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 30_000 });

    await expect(client.writeFile(remotePath, toArrayBuffer(payload))).rejects.toThrow(/rename failed/);

    const uploadCall = calls.find((call) => (call.args ?? []).join(" ").includes(".paperclip-upload."));
    expect(uploadCall).toBeDefined();
    const stagedPath = (uploadCall?.args ?? []).join(" ").match(/([/A-Za-z0-9_.-]+\.paperclip-upload\.[A-Za-z0-9-]+)/)?.[1];
    expect(stagedPath).toBeDefined();
    await expect(readFile(stagedPath!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls.some((call) => (call.args ?? []).join(" ").includes(`rm -rf '${stagedPath}'`))).toBe(true);
    await expect(readFile(remotePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages a single-file write to a temp then renames it on the chunked fallback path too", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-command-atomic-fallback-"));
    cleanupDirs.push(rootDir);
    const remotePath = path.join(rootDir, "nested", "payload.bin");

    const payload = Buffer.alloc(10 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
    const { runner, calls } = makeSpawnRunner({ supportsSingleStreamStdinProgress: false });
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 30_000 });
    await client.writeFile(remotePath, toArrayBuffer(payload));

    const scripts = calls.map((call) => (call.args ?? []).join(" "));
    expect(scripts.some((script) => script.includes(`${remotePath}.paperclip-upload`))).toBe(true);
    expect(scripts.some((script) => script.includes(`mv -f`))).toBe(true);
    expect((await readFile(remotePath)).equals(payload)).toBe(true);
  });

  it("test_client_syncIn_present_even_without_native_runner_syncIn", () => {
    // Phase 2 (PAP-3222): `client.syncIn` is ALWAYS present so the caller can
    // delegate unconditionally. `syncOut` stays native-only (no generic outbound
    // fallback in this seam).
    const base = makeSpawnRunner().runner;
    const client = createCommandManagedRuntimeClient({ runner: base, commandCwd: "/", timeoutMs: 1 });
    expect(client.syncIn).toBeTypeOf("function");
    expect(client.syncOut).toBeUndefined();

    // A runner advertising only one verb still gets the fallback syncIn; syncOut
    // stays undefined (native delegation needs BOTH verbs).
    const onlyIn: CommandManagedRuntimeRunner = { ...base, syncIn: async () => ({ operations: [] }) };
    const partial = createCommandManagedRuntimeClient({ runner: onlyIn, commandCwd: "/", timeoutMs: 1 });
    expect(partial.syncIn).toBeTypeOf("function");
    expect(partial.syncOut).toBeUndefined();

    // With both verbs, syncIn delegates natively and syncOut is exposed.
    const both: CommandManagedRuntimeRunner = {
      ...base,
      syncIn: async () => ({ operations: [] }),
      syncOut: async () => ({ operations: [] }),
    };
    const native = createCommandManagedRuntimeClient({ runner: both, commandCwd: "/", timeoutMs: 1 });
    expect(native.syncIn).toBeTypeOf("function");
    expect(native.syncOut).toBeTypeOf("function");
  });

  it("test_client_syncIn_delegates_to_native_runner_with_zero_execute_calls", async () => {
    // With a native runner, `client.syncIn` forwards `files` + `postUploadCommands`
    // to the runner and issues ZERO `execute` round-trips (the provider owns the
    // transport + command execution).
    let executeCalls = 0;
    const forwarded: SandboxSyncOperation[][] = [];
    const runner: CommandManagedRuntimeRunner = {
      execute: async () => {
        executeCalls += 1;
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: "" };
      },
      syncIn: async (operations) => {
        forwarded.push(operations);
        return {
          operations: operations.map((op) => ({
            operationId: op.operationId,
            filesTransferred: op.files.length,
            bytesTransferred: 0,
          })),
        };
      },
      syncOut: async () => ({ operations: [] }),
    };
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 1 });

    const operations: SandboxSyncOperation[] = [
      {
        operationId: "op-1",
        files: [{ sourcePath: "/host/a", targetPath: "/remote/a", kind: "directory" }],
        postUploadCommands: [{ command: "echo done", cwd: "/remote/a" }],
      },
    ];
    const result = await client.syncIn!(operations);

    expect(executeCalls).toBe(0);
    expect(forwarded).toEqual([operations]);
    expect(result.operations[0]).toMatchObject({ operationId: "op-1", filesTransferred: 1 });
  });

  it("fallback syncIn tarballs+uploads a directory then runs post-upload commands in order", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-syncin-fallback-"));
    cleanupDirs.push(rootDir);
    const sourceDir = path.join(rootDir, "source");
    const targetDir = path.join(rootDir, "target");
    const markerDir = path.join(rootDir, "markers");
    await mkdir(path.join(sourceDir, "nested"), { recursive: true });
    await mkdir(markerDir, { recursive: true });
    await writeFile(path.join(sourceDir, "file.txt"), "payload\n", "utf8");
    await writeFile(path.join(sourceDir, "nested", "deep.txt"), "deep\n", "utf8");

    const { runner, calls } = makeSpawnRunner({ supportsSingleStreamStdinProgress: true });
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 30_000 });

    await client.syncIn!([
      {
        operationId: "op-dir",
        files: [{ sourcePath: sourceDir, targetPath: targetDir, kind: "directory" }],
        postUploadCommands: [
          { command: "touch " + shellQuoteForTest(path.join(markerDir, "1-first")) },
          { command: "touch " + shellQuoteForTest(path.join(markerDir, "2-second")) },
        ],
      },
    ]);

    // Files landed via tar → untar (destroy-then-replace).
    expect(await readFile(path.join(targetDir, "file.txt"), "utf8")).toBe("payload\n");
    expect(await readFile(path.join(targetDir, "nested", "deep.txt"), "utf8")).toBe("deep\n");
    // Both post-upload commands ran (markers exist).
    await expect(readFile(path.join(markerDir, "1-first"))).resolves.toBeDefined();
    await expect(readFile(path.join(markerDir, "2-second"))).resolves.toBeDefined();

    // Ordering: upload → untar → command 1 → command 2. The tarball upload is the
    // single stdin-backed call; the untar and the two commands follow it in order.
    const scripts = calls.map((call) => (call.args ?? []).join("\n"));
    const uploadIdx = scripts.findIndex((s) => s.includes(".paperclip-syncin.tar") && s.includes("base64 -d"));
    const untarIdx = scripts.findIndex((s) => s.includes("tar -xf") && s.includes(targetDir));
    const cmd1Idx = scripts.findIndex((s) => s.includes("1-first"));
    const cmd2Idx = scripts.findIndex((s) => s.includes("2-second"));
    expect(uploadIdx).toBeGreaterThanOrEqual(0);
    expect(untarIdx).toBeGreaterThan(uploadIdx);
    expect(cmd1Idx).toBeGreaterThan(untarIdx);
    expect(cmd2Idx).toBeGreaterThan(cmd1Idx);
  });

  it("fallback syncIn stages mode-constrained files before chmod and rename", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-syncin-mode-"));
    cleanupDirs.push(rootDir);
    const sourceFile = path.join(rootDir, "source.txt");
    const targetFile = path.join(rootDir, "target.txt");
    await writeFile(sourceFile, "payload\n", "utf8");

    const { runner, calls } = makeSpawnRunner({ supportsSingleStreamStdinProgress: true });
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 30_000 });

    await client.syncIn!([
      {
        operationId: "op-mode",
        files: [{ sourcePath: sourceFile, targetPath: targetFile, kind: "file", mode: 0o640 }],
      },
    ]);

    expect(await readFile(targetFile, "utf8")).toBe("payload\n");
    const scripts = calls.map((call) => (call.args ?? []).join(" "));
    expect(scripts).toHaveLength(5);
    expect(scripts[0]).toContain(targetFile + ".paperclip-syncin.");
    expect(scripts[0]).toContain(".paperclip-upload.");
    expect(scripts[1]).toContain("rm -rf");
    expect(scripts[1]).toContain(".paperclip-upload.");
    expect(scripts[2]).toContain("chmod 640");
    expect(scripts[2]).toContain(targetFile + ".paperclip-syncin.");
    expect(scripts[3]).toContain("mv -f");
    expect(scripts[3]).toContain(targetFile + ".paperclip-syncin.");
    expect(scripts[3]).toContain(targetFile);
    expect(scripts[4]).toContain("rm -rf");
    expect(scripts[4]).toContain(targetFile + ".paperclip-syncin.");
  });

  it("fallback syncIn cleans up a staged file when chmod fails before rename", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-syncin-cleanup-"));
    cleanupDirs.push(rootDir);
    const sourceFile = path.join(rootDir, "source.txt");
    const targetFile = path.join(rootDir, "target.txt");
    await writeFile(sourceFile, "payload\n", "utf8");

    const { runner, calls } = makeSpawnRunner({ supportsSingleStreamStdinProgress: true });
    const delegatedExecute = runner.execute.bind(runner);
    runner.execute = async (input) => {
      const script = (input.args ?? []).join(" ");
      if (script.includes("chmod 600")) {
        calls.push({ command: input.command, args: input.args, cwd: input.cwd, stdin: input.stdin });
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "chmod failed",
          pid: null,
          startedAt: new Date().toISOString(),
        };
      }
      return await delegatedExecute(input);
    };
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 30_000 });

    await expect(
      client.syncIn!([
        {
          operationId: "op-cleanup",
          files: [{ sourcePath: sourceFile, targetPath: targetFile, kind: "file", mode: 0o600 }],
        },
      ]),
    ).rejects.toThrow(/chmod failed/);

    const chmodCall = calls.find((call) => (call.args ?? []).join(" ").includes("chmod 600"));
    expect(chmodCall).toBeDefined();
    const stagedPath = (chmodCall?.args ?? []).join(" ").match(/chmod 600 '([^']+)'/)?.[1];
    expect(stagedPath).toBeDefined();
    await expect(readFile(stagedPath!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls.some((call) => (call.args ?? []).join(" ").includes(`rm -rf '${stagedPath}'`))).toBe(true);
    await expect(readFile(targetFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("test_post_upload_commands_execute_verbatim_not_rewritten (C1 opaque)", async () => {
    // The provider/client treats each command as opaque: it is executed VERBATIM,
    // never concatenated with asset keys / paths or otherwise rewritten.
    const executed: string[] = [];
    const runner: CommandManagedRuntimeRunner = {
      execute: async (input) => {
        // Only capture the post-upload command executions (single `sh -c <cmd>`).
        if ((input.args?.[0] === "-c") && typeof input.args?.[1] === "string") {
          executed.push(input.args[1]);
        }
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: "" };
      },
    };
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 1 });

    const verbatim = "my-tool --flag 'quoted value' && echo $HOME";
    await client.syncIn!([
      { operationId: "op-verbatim", files: [], postUploadCommands: [{ command: verbatim }] },
    ]);

    // The exact string appears among executed scripts, unmodified.
    expect(executed).toContain(verbatim);
  });

  it("test_post_upload_command_cwd_escaping_target_root_is_rejected (C2)", async () => {
    // A `cwd` that escapes the operation's target root — via `..` or an absolute
    // path outside the target — is rejected BEFORE any handoff (no execute).
    let executeCalls = 0;
    const runner: CommandManagedRuntimeRunner = {
      execute: async () => {
        executeCalls += 1;
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: "" };
      },
    };
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 1 });

    const traversal: SandboxSyncOperation[] = [
      {
        operationId: "op-traversal",
        files: [{ sourcePath: "/host/a", targetPath: "/remote/a", kind: "directory" }],
        postUploadCommands: [{ command: "echo x", cwd: "/remote/a/../etc" }],
      },
    ];
    await expect(client.syncIn!(traversal)).rejects.toThrow(/confined absolute POSIX path|escapes/);

    const absoluteEscape: SandboxSyncOperation[] = [
      {
        operationId: "op-escape",
        files: [{ sourcePath: "/host/a", targetPath: "/remote/a", kind: "directory" }],
        postUploadCommands: [{ command: "echo x", cwd: "/etc/passwd" }],
      },
    ];
    await expect(client.syncIn!(absoluteEscape)).rejects.toThrow(/escapes the operation's target root/);

    // A confined cwd (equal to the target root) passes confinement — it fails
    // later at tar time (the source dir does not exist), which is a DIFFERENT
    // error than a confinement rejection.
    const confined: SandboxSyncOperation[] = [
      {
        operationId: "op-confined",
        files: [{ sourcePath: "/host/a", targetPath: "/remote/a", kind: "directory" }],
        postUploadCommands: [{ command: "echo x", cwd: "/remote/a" }],
      },
    ];
    let confinementRejected = false;
    try {
      await client.syncIn!(confined);
    } catch (error) {
      confinementRejected = /escapes the operation's target root|confined absolute POSIX path/.test(
        (error as Error).message,
      );
    }
    expect(confinementRejected).toBe(false);

    // Confinement rejected before any exec for the escape cases.
    expect(executeCalls).toBe(0);
  });

  it("test_fallback_syncIn_aborts_and_rejects_on_first_nonzero_exit (C4 fail-fast)", async () => {
    // The first non-zero post-upload command aborts the operation: syncIn rejects,
    // the remaining commands do NOT run, and there is no silent partial fallback.
    const executed: string[] = [];
    const runner: CommandManagedRuntimeRunner = {
      execute: async (input) => {
        const script = input.args?.[1] ?? "";
        executed.push(script);
        const isFailing = script.includes("FAIL-COMMAND");
        return {
          exitCode: isFailing ? 3 : 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: isFailing ? "boom" : "",
          pid: null,
          startedAt: "",
        };
      },
    };
    const client = createCommandManagedRuntimeClient({ runner, commandCwd: "/", timeoutMs: 1 });

    await expect(
      client.syncIn!([
        {
          operationId: "op-failfast",
          files: [],
          postUploadCommands: [
            { command: "echo before" },
            { command: "FAIL-COMMAND" },
            { command: "echo SHOULD-NOT-RUN" },
          ],
        },
      ]),
    ).rejects.toThrow(/exit code 3|boom/);

    expect(executed.some((s) => s.includes("echo before"))).toBe(true);
    expect(executed.some((s) => s.includes("FAIL-COMMAND"))).toBe(true);
    expect(executed.some((s) => s.includes("SHOULD-NOT-RUN"))).toBe(false);
  });

  it("test_single_stream_writeFile_collapses_roundtrips_under_96MiB", async () => {
    // Research A1: with single-stream enabled a ≤96 MiB write is ONE round-trip;
    // without it, the chunked path is `2 + ceil(bytes / 3 MiB)`. Same payload,
    // same client API — only the runner capability flag differs.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-single-stream-collapse-"));
    cleanupDirs.push(rootDir);
    const payload = Buffer.alloc(9 * 1024 * 1024, 7); // 9 MiB → chunked = 2 + 3 = 5 execs

    const single = makeSpawnRunner({ supportsSingleStreamStdinProgress: true });
    const singleClient = createCommandManagedRuntimeClient({ runner: single.runner, commandCwd: "/", timeoutMs: 30_000 });
    await singleClient.writeFile(path.join(rootDir, "single.bin"), toArrayBuffer(payload));
    expect(single.calls.length).toBe(2);

    const chunked = makeSpawnRunner({ supportsSingleStreamStdinProgress: false });
    const chunkedClient = createCommandManagedRuntimeClient({ runner: chunked.runner, commandCwd: "/", timeoutMs: 30_000 });
    await chunkedClient.writeFile(path.join(rootDir, "chunked.bin"), toArrayBuffer(payload));
    // 3 (init temp + final mv + cleanup) + ceil(9MiB / 3MiB) = 6 round-trips.
    expect(chunked.calls.length).toBe(3 + Math.ceil(payload.byteLength / (3 * 1024 * 1024)));
    expect(chunked.calls.length).toBeGreaterThan(single.calls.length);

    expect((await readFile(path.join(rootDir, "single.bin"))).equals(payload)).toBe(true);
    expect((await readFile(path.join(rootDir, "chunked.bin"))).equals(payload)).toBe(true);
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
