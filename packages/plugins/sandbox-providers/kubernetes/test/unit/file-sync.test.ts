import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  assertConfinedSandboxPath,
  parseTarVerboseListingLine,
  performSyncIn,
  performSyncOut,
  splitLinkEntryOnce,
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

    // TECH-8174: the commands run inside the transfer exec (one exec in total).
    expect(calls).toHaveLength(1);
    // C1/C3: each command rides as its own positional argument, byte-for-byte
    // unmutated, never in the script text: the provider concatenated no shell
    // fragment onto it. Positional pairs are (cwd, command) after `$0`.
    const [call] = calls;
    expect(call.command.slice(3)).toEqual([
      "pc-sync-in",
      remoteDir,
      "cat config.txt > out.txt",
      remoteDir,
      "printf DONE >> out.txt",
    ]);
    expect(call.script).not.toContain("cat config.txt");
    expect(call.script).not.toContain("printf DONE");
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

// ---------------------------------------------------------------------------
// TECH-8174: upload and extract in ONE exec. A runtime asset or workspace
// operation is a host tarball (one `file` mapping) plus its extract command. The
// extract now runs at the end of the transfer exec. These run the real host
// shell and real tar.
// ---------------------------------------------------------------------------
describe("kubernetes onEnvironmentSyncIn (upload and extract in one exec, TECH-8174)", () => {
  const extractCommand = (tarPath: string, dir: string) =>
    `rm -rf '${dir}' && mkdir -p '${dir}' && tar -xf '${tarPath}' -C '${dir}' && rm -f '${tarPath}'`;

  async function hostTarball(host: string, files: Record<string, string>): Promise<string> {
    const src = path.join(host, "asset-src");
    for (const [name, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(src, name)), { recursive: true });
      await fs.writeFile(path.join(src, name), body);
    }
    const tarPath = path.join(host, "asset.tar");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("tar", ["-cf", tarPath, "-C", src, ...Object.keys(files)]);
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
    });
    return tarPath;
  }

  it("uploads three asset tarballs and extracts each in ONE exec per operation (3 execs, not 6)", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const runtime = path.join(remoteDir, ".paperclip-runtime", "hermes");
    const operations = [];
    for (const key of ["workspace", "hermesHome", "instructions"]) {
      const keyHost = path.join(host, key);
      await fs.mkdir(keyHost);
      const tarPath = await hostTarball(keyHost, { [`${key}.txt`]: `${key} body`, "nested/deep.txt": `${key} deep` });
      const remoteTar = path.join(runtime, `${key}-upload.tar`);
      operations.push({
        operationId: `op-${key}`,
        files: [{ sourcePath: tarPath, targetPath: remoteTar, kind: "file" as const }],
        postUploadCommands: [{ command: extractCommand(remoteTar, path.join(runtime, key)) }],
      });
    }

    const { exec, calls } = makeRealExec();
    const result = await performSyncIn({ exec, remoteDir, timeoutMs: 30_000, operations });

    expect(calls).toHaveLength(3);
    for (const key of ["workspace", "hermesHome", "instructions"]) {
      expect(await fs.readFile(path.join(runtime, key, `${key}.txt`), "utf-8")).toBe(`${key} body`);
      expect(await fs.readFile(path.join(runtime, key, "nested/deep.txt"), "utf-8")).toBe(`${key} deep`);
      // The extract removed its tarball.
      await expect(fs.stat(path.join(runtime, `${key}-upload.tar`))).rejects.toThrow();
    }
    expect(result.operations.map((op) => op.filesTransferred)).toEqual([1, 1, 1]);
    // No staging scratch is left at the workspace root.
    expect((await fs.readdir(remoteDir)).filter((name) => name.startsWith(".paperclip-upload"))).toEqual([]);
  });

  it("reports a failed extract as a post-upload command failure with its own stderr, never as success", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const corrupt = path.join(host, "corrupt.tar");
    await fs.writeFile(corrupt, "this is not a tar archive at all".repeat(64));
    const remoteTar = path.join(remoteDir, "rt", "asset-upload.tar");
    const assetDir = path.join(remoteDir, "rt", "asset");

    const { exec, calls } = makeRealExec();
    const failure = await performSyncIn({
      exec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [{
        operationId: "op-corrupt",
        files: [{ sourcePath: corrupt, targetPath: remoteTar, kind: "file" }],
        postUploadCommands: [
          { command: "echo first-step-noise >&2" },
          { command: extractCommand(remoteTar, assetDir) },
          { command: "touch after-failure.txt" },
        ],
      }],
    }).then(() => null, (error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toMatch(/^Kubernetes post-upload command failed \(exit [1-9]\d*\)/);
    expect(failure!.message).not.toMatch(/file transfer failed/);
    // Only the failing step's stderr is attached: not an earlier step's, no markers.
    expect(failure!.message).not.toContain("first-step-noise");
    expect(failure!.message).not.toContain("__PC_SYNC_STEP");
    expect(failure!.message.toLowerCase()).toContain("tar");
    // Fail-fast inside the one exec: the command after the failure never ran.
    await expect(fs.stat(path.join(remoteDir, "after-failure.txt"))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("reports a transfer-stage failure as a transfer failure even when commands follow, and runs none of them", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const outside = await makeTmp("k8s-outside-");
    const src = path.join(host, "a.txt");
    await fs.writeFile(src, "x");
    // A planted symlink ancestor: the transfer stage refuses it (exit 42).
    await fs.symlink(outside, path.join(remoteDir, "evil"));

    const { exec, calls } = makeRealExec();
    await expect(
      performSyncIn({
        exec,
        remoteDir,
        timeoutMs: 30_000,
        operations: [{
          operationId: "op-escape",
          files: [{ sourcePath: src, targetPath: path.join(remoteDir, "evil", "a.txt"), kind: "file" }],
          postUploadCommands: [{ command: "touch ran.txt" }],
        }],
      }),
    ).rejects.toThrow(/^Kubernetes syncIn file transfer failed \(exit 42\)/);
    expect(calls).toHaveLength(1);
    await expect(fs.stat(path.join(outside, "a.txt"))).rejects.toThrow();
    await expect(fs.stat(path.join(remoteDir, "ran.txt"))).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("keeps the symlink cwd guard inside the merged exec: the command never runs through the link", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const outside = await makeTmp("k8s-outside-");
    const src = path.join(host, "a.txt");
    await fs.writeFile(src, "x");
    await fs.symlink(outside, path.join(remoteDir, "evil"));

    const { exec, calls } = makeRealExec();
    await expect(
      performSyncIn({
        exec,
        remoteDir,
        timeoutMs: 30_000,
        operations: [{
          operationId: "op-cwd-link",
          files: [{ sourcePath: src, targetPath: path.join(remoteDir, "a.txt"), kind: "file" }],
          postUploadCommands: [
            { command: "touch first.txt" },
            { command: "touch pwned.txt", cwd: path.join(remoteDir, "evil") },
          ],
        }],
      }),
    ).rejects.toThrow(/^Kubernetes post-upload command failed \(exit 42\): ESCAPE/);
    expect(calls).toHaveLength(1);
    // The file landed and the first command ran; the escaping one did not.
    expect(await fs.readFile(path.join(remoteDir, "a.txt"), "utf-8")).toBe("x");
    await fs.stat(path.join(remoteDir, "first.txt"));
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("rejects an escaping command cwd before ANY exec, so no file is uploaded either", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const src = path.join(host, "a.txt");
    await fs.writeFile(src, "x");

    const { exec, calls } = makeRealExec();
    await expect(
      performSyncIn({
        exec,
        remoteDir,
        timeoutMs: 30_000,
        operations: [{
          operationId: "op-cwd-escape",
          files: [{ sourcePath: src, targetPath: path.join(remoteDir, "a.txt"), kind: "file" }],
          postUploadCommands: [{ command: "touch pwned.txt", cwd: "/etc" }],
        }],
      }),
    ).rejects.toThrow(/escapes|not a confined/);
    expect(calls).toHaveLength(0);
    await expect(fs.stat(path.join(remoteDir, "a.txt"))).rejects.toThrow();
  });

  it("gives commands no stdin: the archive bytes are never readable by a command", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const src = path.join(host, "a.txt");
    await fs.writeFile(src, "payload");

    const { exec } = makeRealExec();
    await performSyncIn({
      exec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [{
        operationId: "op-stdin",
        files: [{ sourcePath: src, targetPath: path.join(remoteDir, "a.txt"), kind: "file" }],
        postUploadCommands: [{ command: "cat > stdin-seen.txt" }],
      }],
    });
    expect(await fs.readFile(path.join(remoteDir, "stdin-seen.txt"), "utf-8")).toBe("");
  });

  it("keeps separate execs for an operation that also carries a directory mapping", async () => {
    const remoteDir = await makeTmp("k8s-sandbox-");
    const host = await makeTmp("k8s-host-");
    const src = path.join(host, "a.txt");
    await fs.writeFile(src, "x");
    const dirSrc = path.join(host, "dir");
    await fs.mkdir(dirSrc);
    await fs.writeFile(path.join(dirSrc, "b.txt"), "y");

    const { exec, calls } = makeRealExec();
    await performSyncIn({
      exec,
      remoteDir,
      timeoutMs: 30_000,
      operations: [{
        operationId: "op-mixed",
        files: [
          { sourcePath: src, targetPath: path.join(remoteDir, "a.txt"), kind: "file" },
          { sourcePath: dirSrc, targetPath: path.join(remoteDir, "dir"), kind: "directory" },
        ],
        // Must run after the directory landed, so it stays its own exec.
        postUploadCommands: [{ command: "cat dir/b.txt > seen.txt" }],
      }],
    });
    expect(calls).toHaveLength(3);
    expect(await fs.readFile(path.join(remoteDir, "seen.txt"), "utf-8")).toBe("y");
  });
});


describe("parseTarVerboseListingLine", () => {
  it("parses GNU tar listing lines (file, dir, symlink, hardlink, numeric owner)", () => {
    expect(parseTarVerboseListingLine("-rw-r--r-- daytona/daytona 7560 2026-08-11 21:43 AGENTS.md")).toEqual({
      typeFlag: "-",
      rest: "AGENTS.md",
    });
    expect(parseTarVerboseListingLine("drwxr-xr-x daytona/daytona 0 2026-08-11 21:43 nested/")).toEqual({
      typeFlag: "d",
      rest: "nested/",
    });
    expect(
      parseTarVerboseListingLine("lrwxrwxrwx daytona/daytona 0 2026-08-11 21:43 shortcut -> nested/data.txt"),
    ).toEqual({ typeFlag: "l", rest: "shortcut -> nested/data.txt" });
    expect(
      parseTarVerboseListingLine("hrw-r--r-- daytona/daytona 0 2026-08-11 21:43 copy.txt link to data.txt"),
    ).toEqual({ typeFlag: "h", rest: "copy.txt link to data.txt" });
    expect(parseTarVerboseListingLine("-rw-r--r-- 0/0 12 2026-08-11 21:43 root-owned.txt")).toEqual({
      typeFlag: "-",
      rest: "root-owned.txt",
    });
  });

  it("parses bsdtar (macOS) listing lines, including year-form dates", () => {
    expect(parseTarVerboseListingLine("-rw-r--r--  0 daytona daytona  7560 Aug 11 21:43 AGENTS.md")).toEqual({
      typeFlag: "-",
      rest: "AGENTS.md",
    });
    expect(parseTarVerboseListingLine("drwxr-xr-x  0 daytona daytona     0 Aug 11 21:43 nested/")).toEqual({
      typeFlag: "d",
      rest: "nested/",
    });
    expect(
      parseTarVerboseListingLine("lrwxr-xr-x  0 daytona daytona     0 Aug 11 21:43 shortcut -> nested/data.txt"),
    ).toEqual({ typeFlag: "l", rest: "shortcut -> nested/data.txt" });
    expect(
      parseTarVerboseListingLine("hrw-r--r--  0 daytona daytona     0 Aug 11 21:43 copy.txt link to data.txt"),
    ).toEqual({ typeFlag: "h", rest: "copy.txt link to data.txt" });
    expect(parseTarVerboseListingLine("-rw-r--r--  0 daytona daytona  7560 Aug 11  2025 old.txt")).toEqual({
      typeFlag: "-",
      rest: "old.txt",
    });
  });

  it("keeps the true member name for bsdtar lines with numeric uid/gid, so traversal stays visible", () => {
    // With unresolvable ids bsdtar prints bare numbers; a looser GNU-first parse
    // would read this shape shifted by one field and report the member name as
    // "21:43 ../escape.txt", hiding the leading "../" from the traversal check.
    expect(parseTarVerboseListingLine("-rw-r--r--  0 1001 1001  7560 Aug 11 21:43 ../escape.txt")).toEqual({
      typeFlag: "-",
      rest: "../escape.txt",
    });
  });

  it("returns null (fail closed) for lines matching neither dialect", () => {
    expect(parseTarVerboseListingLine("not a tar listing line")).toBeNull();
    expect(parseTarVerboseListingLine("tar: Error is not recoverable: exiting now")).toBeNull();
    // Device nodes carry "major,minor" instead of a byte count in both dialects.
    expect(parseTarVerboseListingLine("crw-rw-rw- root/root 1,3 2026-08-11 21:43 dev/null")).toBeNull();
    expect(parseTarVerboseListingLine("crw-rw-rw-  0 root wheel  1,3 Aug 11 21:43 dev/null")).toBeNull();
  });
});

describe("splitLinkEntryOnce", () => {
  it("splits a clean single-delimiter link field", () => {
    expect(splitLinkEntryOnce("shortcut -> nested/data.txt", " -> ")).toEqual({
      name: "shortcut",
      target: "nested/data.txt",
    });
    expect(splitLinkEntryOnce("copy.txt link to data.txt", " link to ")).toEqual({
      name: "copy.txt",
      target: "data.txt",
    });
  });

  it("returns null (fail closed) when the delimiter is absent or appears more than once", () => {
    expect(splitLinkEntryOnce("no delimiter here", " -> ")).toBeNull();
    // A link name or target embedding the delimiter makes the split point
    // unresolvable; either split choice can hide an escaping target.
    expect(splitLinkEntryOnce("evil -> decoy -> ../../outside.txt", " -> ")).toBeNull();
    expect(splitLinkEntryOnce("a link to b link to ../../outside.txt", " link to ")).toBeNull();
  });
});
