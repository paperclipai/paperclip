import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  assertConfinedSandboxPath,
  performSyncIn,
  performSyncOut,
  type PodStreamExec,
} from "../../src/file-sync.js";

// ---------------------------------------------------------------------------
// Test harness
//
// The K8s hooks transfer files over a single streaming exec per operation. In
// production that exec streams raw tar bytes over the pod's exec WebSocket
// (stdin from a host file, stdout into a host file); here the injected
// `PodStreamExec` runs the generated `sh -c` script against the REAL host shell,
// piping the caller's `stdin` Readable into the child and the child's stdout into
// the caller's `stdout` Writable, using a host temp dir as the stand-in "sandbox"
// workspace root. This exercises the actual tar/head/mv/realpath command shapes
// end-to-end (a true round-trip) while recording every exec so we can assert the
// single-exec contract and command shape.
// ---------------------------------------------------------------------------

interface RecordedCall {
  command: string[];
  script: string;
}

function makeRealExec(): { exec: PodStreamExec; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: PodStreamExec = async (command, io) => {
    calls.push({ command, script: command[2] ?? "" });
    return await new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1));
      let err = "";
      child.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString("utf-8");
      });
      child.on("error", reject);
      if (io.stdout) {
        io.stdout.on("error", reject);
        child.stdout.pipe(io.stdout);
      } else {
        child.stdout.resume();
      }
      if (io.stdin) {
        io.stdin.on("error", reject);
        io.stdin.pipe(child.stdin);
      } else {
        child.stdin.end();
      }
      child.on("close", (code) => {
        resolve({ exitCode: code ?? 0, stderr: err });
      });
    });
  };
  return { exec, calls };
}

// A stub exec that emits a controlled number of bytes to the caller's stdout
// sink without running any shell — used to drive the outbound disk-guard trip
// with a pod-authored payload larger than the host allows. Rejects if the sink
// errors (the guard fired). Records calls so a test can assert the exec ran.
function makeOutputExec(totalBytes: number): { exec: PodStreamExec; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: PodStreamExec = async (command, io) => {
    calls.push({ command, script: command[2] ?? "" });
    return await new Promise((resolve, reject) => {
      const sink = io.stdout;
      if (!sink) {
        resolve({ exitCode: 0, stderr: "" });
        return;
      }
      sink.on("error", reject);
      sink.on("finish", () => resolve({ exitCode: 0, stderr: "" }));
      sink.end(Buffer.alloc(totalBytes, 0x41));
    });
  };
  return { exec, calls };
}

const tmpDirs: string[] = [];
async function makeTmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("kubernetes file-sync path confinement", () => {
  it("rejects a target path that escapes the workspace remote dir", () => {
    expect(() => assertConfinedSandboxPath("/workspace", "/workspace/../etc/passwd", "target")).toThrow(
      /escapes|not a confined/,
    );
    expect(() => assertConfinedSandboxPath("/workspace", "/etc/passwd", "target")).toThrow(
      /escapes|not a confined/,
    );
    expect(() => assertConfinedSandboxPath("/workspace", "relative/path", "target")).toThrow(
      /not a confined/,
    );
  });

  it("accepts a target path inside the remote dir", () => {
    expect(() => assertConfinedSandboxPath("/workspace", "/workspace/a/b.txt", "target")).not.toThrow();
    expect(() => assertConfinedSandboxPath("/workspace", "/workspace", "target")).not.toThrow();
  });
});

describe("kubernetes onEnvironmentSyncIn (native single-exec transfer)", () => {
  it("transfers all file mappings of an operation in a SINGLE exec, staging to a temp then mv -f, applying secret mode 0600 with no widened window", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const plainSrc = path.join(host, "plain.txt");
    const secretSrc = path.join(host, "auth.json");
    await fs.writeFile(plainSrc, "hello world");
    await fs.writeFile(secretSrc, "{\"token\":\"s3cr3t\"}");

    const { exec, calls } = makeRealExec();
    const result = await performSyncIn({
      exec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [
        {
          operationId: "op-alpha",
          files: [
            { sourcePath: plainSrc, targetPath: path.join(remoteDir, "plain.txt"), kind: "file" },
            {
              sourcePath: secretSrc,
              targetPath: path.join(remoteDir, "nested/auth.json"),
              kind: "file",
              mode: 0o600,
            },
          ],
        },
      ],
    });

    // Single exec for the whole file operation — NOT one exec per file/chunk.
    expect(calls).toHaveLength(1);
    // Atomic-replace shape and raw streamed-extract shape present in the script.
    expect(calls[0].script).toContain("mv -f");
    expect(calls[0].script).toContain("head -c");
    expect(calls[0].script).toContain("tar -xf -");
    // Streaming transport: no base64 round-trip anywhere in the script.
    expect(calls[0].script).not.toContain("base64");
    // Files landed with correct contents.
    expect(await fs.readFile(path.join(remoteDir, "plain.txt"), "utf-8")).toBe("hello world");
    expect(await fs.readFile(path.join(remoteDir, "nested/auth.json"), "utf-8")).toBe(
      "{\"token\":\"s3cr3t\"}",
    );
    // Secret landed 0600.
    expect((await fs.stat(path.join(remoteDir, "nested/auth.json"))).mode & 0o777).toBe(0o600);
    // No leftover reserved scratch dir in the workspace root.
    const leftovers = (await fs.readdir(remoteDir)).filter((e) => e.startsWith(".paperclip-upload"));
    expect(leftovers).toEqual([]);
    // Per-operation counts.
    expect(result.operations).toEqual([
      { operationId: "op-alpha", filesTransferred: 2, bytesTransferred: expect.any(Number) },
    ]);
    expect(result.operations[0].bytesTransferred).toBeGreaterThan(0);
  });

  it("transfers a directory mapping honoring exclude, and emits tar -h only when followSymlinks is true", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const srcDir = path.join(host, "tree");
    await fs.mkdir(path.join(srcDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(srcDir, "keep.txt"), "keep");
    await fs.writeFile(path.join(srcDir, "skip.log"), "skip");
    await fs.writeFile(path.join(srcDir, "sub", "data.bin"), "data");

    // Preserve-symlink case (followSymlinks falsy → no -h).
    {
      const { exec, calls } = makeRealExec();
      await performSyncIn({
        exec,
        remoteDir,
        timeoutMs: 30_000,
        operations: [
          {
            operationId: "op-dir",
            files: [
              {
                sourcePath: srcDir,
                targetPath: path.join(remoteDir, "dst"),
                kind: "directory",
                exclude: ["*.log"],
              },
            ],
          },
        ],
      });
      expect(calls).toHaveLength(1);
      expect(await fs.readFile(path.join(remoteDir, "dst/keep.txt"), "utf-8")).toBe("keep");
      expect(await fs.readFile(path.join(remoteDir, "dst/sub/data.bin"), "utf-8")).toBe("data");
      // Exclude honored.
      await expect(fs.stat(path.join(remoteDir, "dst/skip.log"))).rejects.toThrow();
    }

    // Dereference case: followSymlinks true → -h on the host tar-create.
    {
      const derefSrc = path.join(host, "deref");
      await fs.mkdir(derefSrc, { recursive: true });
      await fs.writeFile(path.join(derefSrc, "real.txt"), "realbytes");
      await fs.symlink(path.join(derefSrc, "real.txt"), path.join(derefSrc, "link.txt"));
      const derefTarget = await makeTmp("k8s-sandbox2-");
      const { exec } = makeRealExec();
      await performSyncIn({
        exec,
        remoteDir: derefTarget,
        timeoutMs: 30_000,
        operations: [
          {
            operationId: "op-deref",
            files: [
              {
                sourcePath: derefSrc,
                targetPath: path.join(derefTarget, "out"),
                kind: "directory",
                followSymlinks: true,
              },
            ],
          },
        ],
      });
      const linkStat = await fs.lstat(path.join(derefTarget, "out/link.txt"));
      // Dereferenced: the link became a regular file carrying the bytes.
      expect(linkStat.isSymbolicLink()).toBe(false);
      expect(await fs.readFile(path.join(derefTarget, "out/link.txt"), "utf-8")).toBe("realbytes");
    }
  });

  it("preserves a symlink as a link when followSymlinks is falsy", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const src = path.join(host, "tree");
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, "real.txt"), "realbytes");
    await fs.symlink("real.txt", path.join(src, "link.txt"));

    const { exec } = makeRealExec();
    await performSyncIn({
      exec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [
        {
          operationId: "op",
          files: [{ sourcePath: src, targetPath: path.join(remoteDir, "out"), kind: "directory" }],
        },
      ],
    });
    const linkStat = await fs.lstat(path.join(remoteDir, "out/link.txt"));
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  it("rejects a file mapping whose target escapes the remote dir before any exec runs", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const src = path.join(host, "x.txt");
    await fs.writeFile(src, "x");
    const { exec, calls } = makeRealExec();
    await expect(
      performSyncIn({
        exec,
        remoteDir,
        timeoutMs: 30_000,
        operations: [
          {
            operationId: "op",
            files: [{ sourcePath: src, targetPath: `${remoteDir}/../escape.txt`, kind: "file" }],
          },
        ],
      }),
    ).rejects.toThrow(/escapes|not a confined/);
    expect(calls).toHaveLength(0);
  });

  it("refuses to create a target dir through a sandbox-planted symlink ancestor, mutating nothing outside the root (confine-before-mkdir)", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const outside = await makeTmp("k8s-outside-");
    const host = await makeTmp("k8s-host-");
    const src = path.join(host, "x.txt");
    await fs.writeFile(src, "payload");
    // A sandbox process planted `evil` inside the workspace as a symlink to an
    // out-of-root dir. The target is LEXICALLY confined (no `..`), so only the
    // in-pod realpath guard can catch it — and it must catch it BEFORE mkdir -p
    // follows the link and creates the tree outside the root.
    await fs.symlink(outside, path.join(remoteDir, "evil"));

    const { exec } = makeRealExec();
    await expect(
      performSyncIn({
        exec,
        remoteDir,
        timeoutMs: 30_000,
        operations: [
          {
            operationId: "op",
            files: [
              { sourcePath: src, targetPath: path.join(remoteDir, "evil", "sub", "f.txt"), kind: "file" },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/ESCAPE|exit 42/);
    // The escape was rejected before mkdir ran: nothing was created outside root.
    await expect(fs.stat(path.join(outside, "sub"))).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("refuses to extract a directory mapping through a symlink ancestor, mutating nothing outside the root", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const outside = await makeTmp("k8s-outside-");
    const host = await makeTmp("k8s-host-");
    const srcDir = path.join(host, "tree");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, "a.txt"), "aaa");
    await fs.symlink(outside, path.join(remoteDir, "evil"));

    const { exec } = makeRealExec();
    await expect(
      performSyncIn({
        exec,
        remoteDir,
        timeoutMs: 30_000,
        operations: [
          {
            operationId: "op",
            files: [
              { sourcePath: srcDir, targetPath: path.join(remoteDir, "evil", "dst"), kind: "directory" },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/ESCAPE|exit 42/);
    await expect(fs.stat(path.join(outside, "dst"))).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("streams a payload with no in-memory cap: a file larger than the former 100 MB ceiling transfers in one exec", async () => {
    // The streaming transport moves raw tar bytes over stdin straight to disk, so
    // there is no whole-payload buffer to bound. A payload the old base64-buffered
    // transport would have rejected now transfers fine. We assert the shape (one
    // exec, byte-exact `head -c`) on a modestly large file — enough to prove the
    // path never accumulates the payload as a string.
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const src = path.join(host, "big.bin");
    const payload = Buffer.alloc(2 * 1024 * 1024, 7); // 2 MiB
    await fs.writeFile(src, payload);
    const { exec, calls } = makeRealExec();
    const result = await performSyncIn({
      exec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [
        {
          operationId: "op",
          files: [{ sourcePath: src, targetPath: path.join(remoteDir, "big.bin"), kind: "file" }],
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toMatch(/head -c \d+/);
    const landed = await fs.readFile(path.join(remoteDir, "big.bin"));
    expect(landed.equals(payload)).toBe(true);
    expect(result.operations[0].bytesTransferred).toBe(payload.length);
  });
});

describe("kubernetes onEnvironmentSyncOut (native single-exec transfer)", () => {
  it("streams all file mappings back over a SINGLE exec and reassembles them at host targets, preserving mode and per-operation counts", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const hostOut = await makeTmp("k8s-hostout-");
    // Simulate sandbox-side files.
    await fs.writeFile(path.join(remoteDir, "result.txt"), "computed output");
    await fs.writeFile(path.join(remoteDir, "secret.key"), "PRIVATE");
    await fs.chmod(path.join(remoteDir, "secret.key"), 0o600);

    const plainTarget = path.join(hostOut, "a/result.txt");
    const secretTarget = path.join(hostOut, "b/secret.key");

    const { exec, calls } = makeRealExec();
    const result = await performSyncOut({
      exec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [
        {
          operationId: "op-out",
          files: [
            { sourcePath: path.join(remoteDir, "result.txt"), targetPath: plainTarget, kind: "file" },
            {
              sourcePath: path.join(remoteDir, "secret.key"),
              targetPath: secretTarget,
              kind: "file",
              mode: 0o600,
            },
          ],
        },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(await fs.readFile(plainTarget, "utf-8")).toBe("computed output");
    expect(await fs.readFile(secretTarget, "utf-8")).toBe("PRIVATE");
    expect((await fs.stat(secretTarget)).mode & 0o777).toBe(0o600);
    expect(result.operations).toEqual([
      { operationId: "op-out", filesTransferred: 2, bytesTransferred: expect.any(Number) },
    ]);
    // Reserved snapshot scratch cleaned up from the workspace root.
    const leftovers = (await fs.readdir(remoteDir)).filter((e) => e.startsWith(".paperclip-upload"));
    expect(leftovers).toEqual([]);
  });

  it("round-trips a directory back to the host, preserving a symlink when followSymlinks is falsy", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const hostOut = await makeTmp("k8s-hostout-");
    const srcDir = path.join(remoteDir, "artifacts");
    await fs.mkdir(path.join(srcDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(srcDir, "a.txt"), "aaa");
    await fs.writeFile(path.join(srcDir, "sub", "b.txt"), "bbb");
    await fs.symlink("a.txt", path.join(srcDir, "link.txt"));

    const target = path.join(hostOut, "restored");
    const { exec, calls } = makeRealExec();
    const result = await performSyncOut({
      exec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [
        {
          operationId: "op-dir-out",
          files: [{ sourcePath: srcDir, targetPath: target, kind: "directory" }],
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(await fs.readFile(path.join(target, "a.txt"), "utf-8")).toBe("aaa");
    expect(await fs.readFile(path.join(target, "sub/b.txt"), "utf-8")).toBe("bbb");
    expect((await fs.lstat(path.join(target, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(result.operations[0].filesTransferred).toBeGreaterThanOrEqual(2);
  });

  it("rejects an outbound source that escapes the remote dir before any exec runs", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const hostOut = await makeTmp("k8s-hostout-");
    const { exec, calls } = makeRealExec();
    await expect(
      performSyncOut({
        exec,
        remoteDir,
        timeoutMs: 30_000,
        operations: [
          {
            operationId: "op",
            files: [
              { sourcePath: "/etc/passwd", targetPath: path.join(hostOut, "leak"), kind: "file" },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/escapes|not a confined/);
    expect(calls).toHaveLength(0);
  });

  it("snapshots the outbound source through a pinned FD (never re-opening by name) so a post-resolve replacement cannot redirect the copy", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const hostOut = await makeTmp("k8s-hostout-");
    await fs.writeFile(path.join(remoteDir, "result.txt"), "computed output");
    const target = path.join(hostOut, "result.txt");

    const { exec, calls } = makeRealExec();
    await performSyncOut({
      exec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [
        {
          operationId: "op",
          files: [
            { sourcePath: path.join(remoteDir, "result.txt"), targetPath: target, kind: "file" },
          ],
        },
      ],
    });
    // Correct bytes copied — through the FD, not the name.
    expect(await fs.readFile(target, "utf-8")).toBe("computed output");
    // The copy reads the pinned FD, and the source is never re-opened by its
    // resolved name after validation (which is what the TOCTOU exploited).
    expect(calls[0].script).toContain("exec 7<");
    expect(calls[0].script).toContain("cp -- /proc/self/fd/7");
    expect(calls[0].script).not.toMatch(/cp -- "\$_pc_real"/);
  });

  it("rejects an outbound source that is a symlink resolving outside the root, writing no target", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const outside = await makeTmp("k8s-outside-");
    const hostOut = await makeTmp("k8s-hostout-");
    await fs.writeFile(path.join(outside, "secret"), "PRIVATE");
    // A symlink LEXICALLY inside the root that resolves to an out-of-root file —
    // only the in-pod realpath/FD guard can reject it.
    await fs.symlink(path.join(outside, "secret"), path.join(remoteDir, "link"));
    const target = path.join(hostOut, "leak");

    const { exec } = makeRealExec();
    await expect(
      performSyncOut({
        exec,
        remoteDir,
        timeoutMs: 30_000,
        operations: [
          {
            operationId: "op",
            files: [{ sourcePath: path.join(remoteDir, "link"), targetPath: target, kind: "file" }],
          },
        ],
      }),
    ).rejects.toThrow(/ESCAPE|exit 42/);
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("fails closed when the outbound payload exceeds the streamed-output disk guard, writing no target", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const hostOut = await makeTmp("k8s-hostout-");
    await fs.writeFile(path.join(remoteDir, "result.txt"), "computed output");
    const target = path.join(hostOut, "result.txt");
    // The (untrusted) pod streams far more than a 1KB guard allows; the host must
    // trip the streamed-bytes guard and abort before it can fill the disk, never
    // extracting a target.
    const { exec, calls } = makeOutputExec(4096);
    await expect(
      performSyncOut({
        exec,
        remoteDir,
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
        operations: [
          {
            operationId: "op",
            files: [
              { sourcePath: path.join(remoteDir, "result.txt"), targetPath: target, kind: "file" },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/disk guard|exceeded/i);
    // The exec ran (source was confined), but the oversize stream is aborted, so
    // nothing lands at the host target.
    expect(calls).toHaveLength(1);
    await expect(fs.stat(target)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Post-upload commands (Phase 3 / Security Conditions C1–C4 + C7). Kubernetes is
// a native provider, so it EXECUTES an operation's ordered `postUploadCommands`
// symmetrically with Daytona after `uploadFiles` — never silently dropping them
// (C7). Each command runs in the pod over its own exec, fail-fast, with the `cwd`
// re-confined under the workspace remote dir. The injected exec runs the real
// host shell, so these assertions observe true command side-effects.
// ---------------------------------------------------------------------------
describe("kubernetes onEnvironmentSyncIn (post-upload commands)", () => {
  it("runs post-upload commands in array order AFTER the upload, each verbatim as a positional arg", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const src = path.join(host, "config.txt");
    await fs.writeFile(src, "hello");

    const { exec, calls } = makeRealExec();
    await performSyncIn({
      exec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [
        {
          operationId: "op-cmd",
          files: [{ sourcePath: src, targetPath: path.join(remoteDir, "config.txt"), kind: "file" }],
          // First command reads the just-uploaded file (proves upload-before-command);
          // second appends (proves array order). cwd absent → the remote dir.
          postUploadCommands: [
            { command: "cat config.txt > out.txt" },
            { command: "printf DONE >> out.txt" },
          ],
        },
      ],
    });

    // Upload-before-commands AND order: out.txt is the first command's read of the
    // uploaded bytes, then the second command's append.
    expect(await fs.readFile(path.join(remoteDir, "out.txt"), "utf-8")).toBe("helloDONE");

    // One exec for the transfer, then one exec per command (single-exec-per-command).
    expect(calls).toHaveLength(3);
    // C1/C3: each command rides as the FINAL positional argument, byte-for-byte
    // unmutated — the provider concatenated no shell fragment onto it.
    const cmdCalls = calls.filter((c) => c.command.includes("cat config.txt > out.txt") || c.command.includes("printf DONE >> out.txt"));
    expect(cmdCalls).toHaveLength(2);
    expect(cmdCalls[0].command[cmdCalls[0].command.length - 1]).toBe("cat config.txt > out.txt");
    expect(cmdCalls[1].command[cmdCalls[1].command.length - 1]).toBe("printf DONE >> out.txt");
    // Absent cwd defaults to the remote dir (the penultimate positional arg), never
    // a process default cwd (C2).
    expect(cmdCalls[0].command[cmdCalls[0].command.length - 2]).toBe(remoteDir);
  });

  it("runs a command in an explicit confined cwd", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const src = path.join(host, "seed.txt");
    await fs.writeFile(src, "x");
    const subDir = path.join(remoteDir, "sub");

    const { exec } = makeRealExec();
    await performSyncIn({
      exec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [
        {
          operationId: "op-cwd",
          files: [{ sourcePath: src, targetPath: path.join(subDir, "seed.txt"), kind: "file" }],
          postUploadCommands: [{ command: "pwd -P > where.txt", cwd: subDir }],
        },
      ],
    });
    // The command ran with its cwd = subDir: `where.txt` lands there (relative
    // write), and its physical cwd (`pwd -P`) is the realpath of subDir.
    expect((await fs.readFile(path.join(subDir, "where.txt"), "utf-8")).trim()).toBe(
      await fs.realpath(subDir),
    );
  });

  it("aborts the operation fail-loud on a non-zero post-upload command exit, skipping the remainder (C4)", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const src = path.join(host, "config.txt");
    await fs.writeFile(src, "hello");

    const { exec } = makeRealExec();
    await expect(
      performSyncIn({
        exec,
        remoteDir,
        timeoutMs: 30_000,
        operations: [
          {
            operationId: "op-fail",
            files: [{ sourcePath: src, targetPath: path.join(remoteDir, "config.txt"), kind: "file" }],
            postUploadCommands: [
              { command: "exit 3" },
              { command: "touch should_not_exist.txt" },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/post-upload command failed \(exit 3\)/);
    // Fail-fast: the command after the failing one never ran.
    await expect(fs.stat(path.join(remoteDir, "should_not_exist.txt"))).rejects.toThrow();
  });

  it("rejects a post-upload command cwd that escapes the remote dir lexically, before any exec (C2)", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const src = path.join(host, "config.txt");
    await fs.writeFile(src, "hello");

    for (const badCwd of [`${remoteDir}/../escape`, "/etc"]) {
      const { exec, calls } = makeRealExec();
      await expect(
        performSyncIn({
          exec,
          remoteDir,
          timeoutMs: 30_000,
          operations: [
            {
              operationId: "op-escape",
              files: [{ sourcePath: src, targetPath: path.join(remoteDir, "config.txt"), kind: "file" }],
              postUploadCommands: [{ command: "touch pwned.txt", cwd: badCwd }],
            },
          ],
        }),
      ).rejects.toThrow(/escapes|not a confined/);
      // Rejected before the command exec: only the transfer exec ran, no command.
      expect(calls.some((c) => c.command.includes("touch pwned.txt"))).toBe(false);
    }
  });

  it("rejects a post-upload command whose cwd resolves outside the root via a symlink (realpath guard, C2)", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const outside = await makeTmp("k8s-outside-");
    const src = path.join(host, "config.txt");
    await fs.writeFile(src, "hello");
    // A symlink LEXICALLY inside the root that resolves to an out-of-root dir.
    await fs.symlink(outside, path.join(remoteDir, "evil"));
    const cwd = path.join(remoteDir, "evil");

    const { exec } = makeRealExec();
    await expect(
      performSyncIn({
        exec,
        remoteDir,
        timeoutMs: 30_000,
        operations: [
          {
            operationId: "op-symlink",
            files: [{ sourcePath: src, targetPath: path.join(remoteDir, "config.txt"), kind: "file" }],
            postUploadCommands: [{ command: "touch pwned.txt", cwd }],
          },
        ],
      }),
    ).rejects.toThrow(/ESCAPE|exit 42/);
    // The command never ran through the symlink: nothing landed in the outside dir.
    await expect(fs.stat(path.join(outside, "pwned.txt"))).rejects.toThrow();
  });

  it("issues no extra exec when an operation has no post-upload commands (backward-compat)", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const src = path.join(host, "config.txt");
    await fs.writeFile(src, "hello");

    const { exec: baseExec, calls: baseCalls } = makeRealExec();
    await performSyncIn({
      exec: baseExec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [
        { operationId: "op-plain", files: [{ sourcePath: src, targetPath: path.join(remoteDir, "config.txt"), kind: "file" }] },
      ],
    });

    const { exec: emptyExec, calls: emptyCalls } = makeRealExec();
    await performSyncIn({
      exec: emptyExec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [
        {
          operationId: "op-plain",
          files: [{ sourcePath: src, targetPath: path.join(remoteDir, "config.txt"), kind: "file" }],
          postUploadCommands: [],
        },
      ],
    });
    // An absent/empty command list adds zero execs — byte-identical to today.
    expect(emptyCalls).toHaveLength(baseCalls.length);
    expect(emptyCalls).toHaveLength(1);
  });
});
