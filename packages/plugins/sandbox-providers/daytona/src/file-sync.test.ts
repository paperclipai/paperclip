import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { Transform } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

// The plugin module imports `@daytonaio/sdk` as a value, but the sync tests never
// touch a real Daytona client — every sandbox call goes through a local mock. Stub
// the SDK so the import resolves without the excluded provider package.
import { vi } from "vitest";
vi.mock("@daytonaio/sdk", () => ({
  Daytona: class MockDaytona {},
  DaytonaNotFoundError: class MockDaytonaNotFoundError extends Error {},
  DaytonaTimeoutError: class MockDaytonaTimeoutError extends Error {},
}));

import { performSyncIn } from "./file-sync.js";
import { __setDaytonaPluginContextForTest } from "./plugin.js";
import type { PluginContext, PluginSyncOperation } from "@paperclipai/plugin-sdk";

// One recorded in-sandbox command, so a test can assert the exact cleanup command.
interface RecordedCommand {
  command: string;
}

// Build a mock Daytona sandbox for the inbound directory path. `executeCommand`
// records every command and returns exit 0, except that any command whose text
// matches `failCommandMatch` returns exit 1 (to simulate an extract failure).
// `uploadFiles` records each upload destination so a test can read the reserved
// scratch tar path the runtime chose.
function createMockSandbox(input: {
  failCommandMatch?: RegExp;
  uploadedDestinations: string[];
  commands: RecordedCommand[];
}) {
  return {
    process: {
      executeCommand: async (command: string) => {
        input.commands.push({ command });
        if (input.failCommandMatch && input.failCommandMatch.test(command)) {
          return { exitCode: 1, result: "simulated extract failure" };
        }
        return { exitCode: 0, result: "" };
      },
    },
    fs: {
      uploadFiles: async (uploads: Array<{ source: string; destination: string }>) => {
        for (const upload of uploads) input.uploadedDestinations.push(upload.destination);
      },
    },
  };
}

describe("daytona file-sync inbound scratch cleanup", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("removes the reserved scratch tar when a directory extraction fails", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-daytona-scratch-"));
    cleanupDirs.push(rootDir);
    const sourceDir = path.join(rootDir, "referenced-project");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "README.md"), "referenced project\n", "utf8");

    const remoteDir = "/workspace";
    const targetPath = "/workspace/.paperclip-runtime/test-adapter/project-abc";
    const uploadedDestinations: string[] = [];
    const commands: RecordedCommand[] = [];
    // Fail the extract round trip (the only command that runs `tar -xf`).
    const sandbox = createMockSandbox({
      failCommandMatch: /tar -xf/,
      uploadedDestinations,
      commands,
    });

    const operations: PluginSyncOperation[] = [{
      operationId: "sync-op-1",
      files: [{ sourcePath: sourceDir, targetPath, kind: "directory" }],
    }];

    await expect(
      performSyncIn({
        // The mock stands in for the Daytona SDK Sandbox; only the two methods the
        // inbound directory path calls are needed.
        sandbox: sandbox as never,
        operations,
        remoteDir,
        timeoutSeconds: 30,
      }),
    ).rejects.toThrow(/syncIn extract/);

    // The runtime uploaded exactly one reserved scratch tar under the workspace
    // root. Its name carries the reserved `.paperclip-upload-` prefix.
    expect(uploadedDestinations).toHaveLength(1);
    const scratchTar = uploadedDestinations[0];
    expect(scratchTar).toContain(".paperclip-upload-");
    expect(scratchTar.startsWith(`${remoteDir}/`)).toBe(true);

    // The failure path swept the scratch tar: a standalone `rm -f` of the exact
    // scratch path ran after the failed extract. The extract command itself also
    // contains an `rm -f`, so the cleanup is the `rm -f` command that does NOT run
    // `tar -xf`.
    const cleanupCommands = commands.filter(
      (entry) =>
        entry.command.includes(scratchTar) &&
        entry.command.includes("rm -f") &&
        !entry.command.includes("tar -xf"),
    );
    expect(cleanupCommands.length).toBeGreaterThan(0);
  });

  it("does not sweep scratch on the happy path (extract removes it)", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-daytona-scratch-"));
    cleanupDirs.push(rootDir);
    const sourceDir = path.join(rootDir, "referenced-project");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "README.md"), "referenced project\n", "utf8");

    const remoteDir = "/workspace";
    const targetPath = "/workspace/.paperclip-runtime/test-adapter/project-abc";
    const uploadedDestinations: string[] = [];
    const commands: RecordedCommand[] = [];
    // No failure: every command succeeds, so the extract's own `rm -f` clears the
    // scratch and no extra cleanup round trip runs.
    const sandbox = createMockSandbox({ uploadedDestinations, commands });

    const operations: PluginSyncOperation[] = [{
      operationId: "sync-op-1",
      files: [{ sourcePath: sourceDir, targetPath, kind: "directory" }],
    }];

    await performSyncIn({
      sandbox: sandbox as never,
      operations,
      remoteDir,
      timeoutSeconds: 30,
    });

    const scratchTar = uploadedDestinations[0];
    // The standalone cleanup command (a `rm -f` without `tar -xf`) never runs on the
    // happy path — only the extract command, which ends with its own `rm -f`.
    const standaloneRemoves = commands.filter(
      (entry) =>
        entry.command.includes(scratchTar) &&
        entry.command.includes("rm -f") &&
        !entry.command.includes("tar -xf"),
    );
    expect(standaloneRemoves).toHaveLength(0);
  });
});

// ---------------------------------------------------------------
// zstd-3 transport compression on the inbound file-mapping path
// ---------------------------------------------------------------

const ZSTD_MIN_SOURCE_BYTES_FOR_TEST = 8 * 1024 * 1024;

// A real `zstd` binary is required to run the tests that execute a real
// promotion script (the sandbox stand-in below shells out to THIS host). The
// package never depends on a `zstd` binary on the production host — only the
// sandbox side does, per the design — but the test double needs one to prove
// the decompression contract for real rather than only recording commands.
// Skip cleanly, like the existing `describeLinux`/`describeLive` gates in this
// package, when the test host has none.
const hasZstdBinary = spawnSync("zstd", ["--version"]).status === 0;
const describeWithZstd = hasZstdBinary ? describe : describe.skip;

function sha256OfFile(filePath: string): Promise<string> {
  return fs.readFile(filePath).then((buf) => crypto.createHash("sha256").update(buf).digest("hex"));
}

async function writeCompressibleFile(filePath: string, sizeBytes: number): Promise<void> {
  // Low-entropy repeated content compresses well past the 10% saving bar.
  const chunk = Buffer.from("paperclip-zstd-transport-compression-fixture-".repeat(64));
  const parts: Buffer[] = [];
  for (let written = 0; written < sizeBytes; written += chunk.length) parts.push(chunk);
  await fs.writeFile(filePath, Buffer.concat(parts).subarray(0, sizeBytes));
}

async function writeIncompressibleFile(filePath: string, sizeBytes: number): Promise<void> {
  await fs.writeFile(filePath, crypto.randomBytes(sizeBytes));
}

/**
 * Extract the raw scratch pathname from a promote-script command's own text.
 * The promote script embeds the path inside `shellQuote`, and the WHOLE
 * script is itself `shellQuote`d again for the outer `sh -c` wrapper — so the
 * literal `'...'` delimiters around the path get escaped and are not a
 * reliable anchor. The path text itself has no shell metacharacters (it is
 * `remoteDir` + a UUID-based scratch name), so it survives both quoting
 * passes unchanged and is matched directly instead. The script always emits
 * the raw scratch's `exec 9> ...` line before the `.zst` scratch's
 * `zstd -d -c -- ...` line, so the FIRST match is always the raw name.
 */
function extractRawScratchPath(command: string, remoteDir: string): string {
  const escapedRoot = remoteDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(new RegExp(`${escapedRoot}/\\.paperclip-upload-[0-9a-f-]+`));
  if (!match) throw new Error("test setup: could not find the raw scratch path in the promote script");
  return match[0];
}

/**
 * A lightweight recording sandbox double for the fallback-condition tests: it
 * never runs a real shell, only records commands and reports a canned exit
 * code, and simulates the zstd availability probe via `probeReportsZstd`.
 * Host-side compression (`node:zlib`) still runs for real in the code under
 * test — only the SANDBOX side is faked here — so these tests genuinely
 * exercise the host compression/ratio decision.
 */
function createRecordingSandbox(input: {
  probeReportsZstd: boolean;
  uploadedSources: string[];
  uploadedDestinations: string[];
  commands: RecordedCommand[];
}) {
  return {
    process: {
      executeCommand: async (command: string) => {
        input.commands.push({ command });
        if (command.includes("mkdir -p")) {
          return { exitCode: 0, result: input.probeReportsZstd ? "PAPERCLIP_ZSTD_AVAILABLE\n" : "" };
        }
        return { exitCode: 0, result: "" };
      },
    },
    fs: {
      uploadFiles: async (uploads: Array<{ source: string; destination: string }>) => {
        for (const upload of uploads) {
          input.uploadedSources.push(upload.source);
          input.uploadedDestinations.push(upload.destination);
        }
      },
      setFilePermissions: async () => undefined,
    },
  };
}

/**
 * A real POSIX-shell-backed sandbox double: `executeCommand` runs the exact
 * command string on THIS host via `/bin/sh -c`, and `uploadFiles`/
 * `setFilePermissions` apply real bytes/modes onto a real directory standing
 * in for the sandbox root. This proves the decompression/promotion script
 * for real, instead of only recording which commands the code would send.
 *
 * `beforeCommand` runs (and may `await` a filesystem mutation) immediately
 * before each real command executes. The race-regression test uses it to
 * plant a pre-created scratch name at exactly the moment a sandbox peer could
 * have observed the pathname (the R2 residual the design discloses), and the
 * parent-swap test uses it to swap a target's parent dir between the
 * confinement guard and the promotion round trip.
 */
function createRealExecSandbox(input?: {
  beforeCommand?: (command: string, index: number) => void | Promise<void>;
  uploadOverride?: (uploads: Array<{ source: string; destination: string }>) => Promise<boolean>;
}) {
  const commands: RecordedCommand[] = [];
  let index = 0;
  return {
    commands,
    sandbox: {
      process: {
        executeCommand: async (command: string) => {
          await input?.beforeCommand?.(command, index);
          index += 1;
          commands.push({ command });
          const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
          return { exitCode: result.status ?? 1, result: (result.stdout ?? "") + (result.stderr ?? "") };
        },
      },
      fs: {
        uploadFiles: async (uploads: Array<{ source: string; destination: string }>) => {
          if (input?.uploadOverride && (await input.uploadOverride(uploads))) return;
          for (const upload of uploads) await fs.copyFile(upload.source, upload.destination);
        },
        setFilePermissions: async (target: string, options: { mode: string }) => {
          await fs.chmod(target, parseInt(options.mode, 8));
        },
      },
    },
  };
}

describe("daytona file-sync inbound zstd transport compression", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const mkTempDir = async (prefix: string): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(dir);
    return dir;
  };

  describeWithZstd("compressed path (real promotion script, real zstd)", () => {
    it("compresses on the host and decompresses in-sandbox to a byte-identical file", async () => {
      const remoteDir = await mkTempDir("paperclip-daytona-zstd-remote-");
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "workspace-upload.tar");
      await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      const targetPath = path.posix.join(remoteDir, "workspace-upload.tar");

      const { sandbox, commands } = createRealExecSandbox();
      const operations: PluginSyncOperation[] = [{
        operationId: "sync-op-1",
        files: [{ sourcePath, targetPath, kind: "file" }],
      }];

      const result = await performSyncIn({ sandbox: sandbox as never, operations, remoteDir, timeoutSeconds: 30 });

      expect(result.operations[0].filesTransferred).toBe(1);
      expect(result.operations[0].bytesTransferred).toBe(ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      // The promote script actually ran a real `zstd -d -c` — proves decompression
      // happened, not just that the code called `uploadFiles`.
      expect(commands.some((entry) => entry.command.includes("zstd -d -c"))).toBe(true);
      expect(await sha256OfFile(targetPath)).toBe(await sha256OfFile(sourcePath));

      // Cleanup on success: no reserved scratch (raw or `.zst`) remains.
      const remaining = await fs.readdir(remoteDir);
      expect(remaining.filter((name) => name.includes(".paperclip-upload"))).toHaveLength(0);
    });

    it("removes the private compressed host temp directory after a successful sync", async () => {
      const remoteDir = await mkTempDir("paperclip-daytona-zstd-remote-");
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "workspace-upload.tar");
      await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      const targetPath = path.posix.join(remoteDir, "target.bin");

      let capturedHostTempDir = "";
      const { sandbox } = createRealExecSandbox({
        uploadOverride: async (uploads) => {
          const zstdUpload = uploads.find((upload) => upload.destination.endsWith(".zst"));
          if (zstdUpload) capturedHostTempDir = path.dirname(zstdUpload.source);
          for (const upload of uploads) await fs.copyFile(upload.source, upload.destination);
          return true;
        },
      });
      const operations: PluginSyncOperation[] = [{
        operationId: "sync-op-1",
        files: [{ sourcePath, targetPath, kind: "file" }],
      }];

      await performSyncIn({ sandbox: sandbox as never, operations, remoteDir, timeoutSeconds: 30 });

      expect(capturedHostTempDir).toContain("paperclip-daytona-zstd-");
      // The private host temp directory (not just the file inside it) is gone
      // after a successful sync.
      await expect(fs.stat(capturedHostTempDir)).rejects.toThrow();
    });

    it("reports the sync as successful when the post-promotion `.zst` cleanup fails, and warns with a leftover count but no path", async () => {
      const remoteDir = await mkTempDir("paperclip-daytona-zstd-remote-");
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "workspace-upload.tar");
      await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      const targetPath = path.posix.join(remoteDir, "target.bin");

      // Put a stand-in `rm` first on PATH. It always exits 1. So BOTH the
      // promote script's OWN `.zst` cleanup and the later bounded sweep's
      // separate `rm -f` fail, the same way a persistent cleanup error would.
      // The other commands (`mv`, `zstd`, `chmod`) still resolve to the real
      // binaries later on PATH.
      const fakeBinDir = await mkTempDir("paperclip-daytona-zstd-fakebin-");
      const fakeRmPath = path.join(fakeBinDir, "rm");
      await fs.writeFile(fakeRmPath, "#!/bin/sh\nexit 1\n");
      await fs.chmod(fakeRmPath, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        const { sandbox } = createRealExecSandbox();
        const operations: PluginSyncOperation[] = [{
          operationId: "sync-op-1",
          files: [{ sourcePath, targetPath, kind: "file" }],
        }];

        // Every target file is already installed by the time the `.zst`
        // cleanup runs, so a failing cleanup must never turn into a sync
        // failure.
        await performSyncIn({ sandbox: sandbox as never, operations, remoteDir, timeoutSeconds: 30 });

        expect(await sha256OfFile(targetPath)).toBe(await sha256OfFile(sourcePath));
        // The forced `rm` failure left the `.zst` scratch behind — proof the
        // fake `rm` actually ran and failed, not that cleanup was skipped.
        const remaining = await fs.readdir(remoteDir);
        const zstdName = remaining.find((name) => name.endsWith(".zst"));
        expect(zstdName).toBeDefined();

        // A leftover that survives both the inline cleanup and the bounded
        // sweep is observable: exactly one warning, carrying a count, never
        // the scratch pathname itself.
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const warning = warnSpy.mock.calls[0]?.[0] as string;
        expect(warning).toContain("1 post-promotion scratch file");
        expect(warning).not.toContain(zstdName as string);
      } finally {
        process.env.PATH = originalPath;
        warnSpy.mockRestore();
      }
    });

    it("recovers a transient post-promotion `.zst` cleanup failure with the bounded sweep, without warning", async () => {
      const remoteDir = await mkTempDir("paperclip-daytona-zstd-remote-");
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "workspace-upload.tar");
      await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      const targetPath = path.posix.join(remoteDir, "target.bin");

      // A stand-in `rm` that fails only its first call — the promote script's
      // own inline `.zst` cleanup. It defers to the real `rm` for every later
      // call. This simulates a transient cleanup failure: the bounded sweep's
      // own, separate `rm -f` is the second call, and it succeeds.
      const fakeBinDir = await mkTempDir("paperclip-daytona-zstd-fakebin-");
      const counterFile = path.join(fakeBinDir, "rm-call-count");
      const fakeRmPath = path.join(fakeBinDir, "rm");
      await fs.writeFile(
        fakeRmPath,
        [
          "#!/bin/sh",
          "n=0",
          `[ -f "${counterFile}" ] && n=$(cat "${counterFile}")`,
          "n=$((n + 1))",
          `printf '%s' "$n" > "${counterFile}"`,
          '[ "$n" -eq 1 ] && exit 1',
          'exec /bin/rm "$@"',
          "",
        ].join("\n"),
      );
      await fs.chmod(fakeRmPath, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        const { sandbox } = createRealExecSandbox();
        const operations: PluginSyncOperation[] = [{
          operationId: "sync-op-1",
          files: [{ sourcePath, targetPath, kind: "file" }],
        }];

        await performSyncIn({ sandbox: sandbox as never, operations, remoteDir, timeoutSeconds: 30 });

        expect(await sha256OfFile(targetPath)).toBe(await sha256OfFile(sourcePath));
        expect(await fs.readFile(counterFile, "utf8")).toBe("2"); // proves the sweep actually ran a second `rm`
        // The sweep's separate, later `rm -f` succeeded where the inline
        // cleanup failed — no `.zst` scratch remains, so there is nothing to
        // warn about.
        const remaining = await fs.readdir(remoteDir);
        expect(remaining.some((name) => name.endsWith(".zst"))).toBe(false);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        process.env.PATH = originalPath;
        warnSpy.mockRestore();
      }
    });

    it("never promotes a partial file when decompression fails, and sweeps all reserved scratch", async () => {
      const remoteDir = await mkTempDir("paperclip-daytona-zstd-remote-");
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "workspace-upload.tar");
      await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      const targetPath = path.posix.join(remoteDir, "target.bin");

      const { sandbox } = createRealExecSandbox({
        // Simulate the `.zst` upload landing corrupted: the in-sandbox
        // `zstd -d -c` step will fail for real on this invalid input.
        uploadOverride: async (uploads) => {
          for (const upload of uploads) {
            if (upload.destination.endsWith(".zst")) {
              await fs.writeFile(upload.destination, Buffer.from("not a valid zstd frame at all"));
            } else {
              await fs.copyFile(upload.source, upload.destination);
            }
          }
          return true;
        },
      });
      const operations: PluginSyncOperation[] = [{
        operationId: "sync-op-1",
        files: [{ sourcePath, targetPath, kind: "file" }],
      }];

      await expect(
        performSyncIn({ sandbox: sandbox as never, operations, remoteDir, timeoutSeconds: 30 }),
      ).rejects.toThrow(/syncIn rename/);

      await expect(fs.stat(targetPath)).rejects.toThrow(); // never promoted
      const remaining = await fs.readdir(remoteDir);
      expect(remaining.filter((name) => name.includes(".paperclip-upload"))).toHaveLength(0); // scratch swept
    });

    it("refuses a pre-created regular file at the raw scratch name (race regression, C1)", async () => {
      const remoteDir = await mkTempDir("paperclip-daytona-zstd-remote-");
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "workspace-upload.tar");
      await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      const targetPath = path.posix.join(remoteDir, "target.bin");

      let injected = false;
      const { sandbox } = createRealExecSandbox({
        beforeCommand: async (command) => {
          if (injected || !command.includes("zstd -d -c")) return;
          const rawScratchPath = extractRawScratchPath(command, remoteDir);
          injected = true;
          // A peer that reads this command's own text (the R2 residual) claims
          // the reserved name first, as a plain pre-existing file.
          await fs.writeFile(rawScratchPath, "attacker-controlled pre-existing content");
        },
      });
      const operations: PluginSyncOperation[] = [{
        operationId: "sync-op-1",
        files: [{ sourcePath, targetPath, kind: "file" }],
      }];

      await expect(
        performSyncIn({ sandbox: sandbox as never, operations, remoteDir, timeoutSeconds: 30 }),
      ).rejects.toThrow();

      expect(injected).toBe(true);
      await expect(fs.stat(targetPath)).rejects.toThrow(); // never promoted
    });

    it("refuses a pre-created symlink at the raw scratch name and never writes through it (race regression, C1)", async () => {
      const remoteDir = await mkTempDir("paperclip-daytona-zstd-remote-");
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "workspace-upload.tar");
      await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      const targetPath = path.posix.join(remoteDir, "target.bin");
      const sentinelPath = path.join(hostDir, "outside-the-workspace-root.txt");
      const sentinelContent = "PRE-EXISTING CONTENT, MUST SURVIVE UNCHANGED\n";
      await fs.writeFile(sentinelPath, sentinelContent);

      let injected = false;
      const { sandbox } = createRealExecSandbox({
        beforeCommand: async (command) => {
          if (injected || !command.includes("zstd -d -c")) return;
          const rawScratchPath = extractRawScratchPath(command, remoteDir);
          injected = true;
          // A peer that reads this command's own text (the R2 residual) claims
          // the reserved name first, as a symlink pointing OUTSIDE the workspace
          // root — the attack shape a create-with-mode-not-check-then-create
          // primitive must refuse.
          await fs.symlink(sentinelPath, rawScratchPath);
        },
      });
      const operations: PluginSyncOperation[] = [{
        operationId: "sync-op-1",
        files: [{ sourcePath, targetPath, kind: "file" }],
      }];

      await expect(
        performSyncIn({ sandbox: sandbox as never, operations, remoteDir, timeoutSeconds: 30 }),
      ).rejects.toThrow();

      expect(injected).toBe(true);
      await expect(fs.stat(targetPath)).rejects.toThrow(); // never promoted
      // The symlink's target was never opened/written through: content unchanged,
      // and no write landed outside the workspace root.
      expect(await fs.readFile(sentinelPath, "utf8")).toBe(sentinelContent);
    });

    it("still fails at the fd re-verification when a target's parent dir is swapped after the confinement guard", async () => {
      const remoteDir = await mkTempDir("paperclip-daytona-zstd-remote-");
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const outsideDir = await mkTempDir("paperclip-daytona-zstd-outside-");
      const realParentDir = path.posix.join(remoteDir, "nested");
      const targetPath = path.posix.join(realParentDir, "target.bin");
      const sourcePath = path.join(hostDir, "small.bin");
      await fs.writeFile(sourcePath, "small file, well below the compression threshold\n");

      let swapped = false;
      const { sandbox } = createRealExecSandbox({
        beforeCommand: async (_command, index) => {
          // index 0 = mkdir+probe, index 1 = checkSymlinkEscape, index 2 = promote.
          if (index !== 2 || swapped) return;
          swapped = true;
          await fs.rm(realParentDir, { recursive: true, force: true });
          await fs.symlink(outsideDir, realParentDir);
        },
      });
      const operations: PluginSyncOperation[] = [{
        operationId: "sync-op-1",
        files: [{ sourcePath, targetPath, kind: "file" }],
      }];

      await expect(
        performSyncIn({ sandbox: sandbox as never, operations, remoteDir, timeoutSeconds: 30 }),
      ).rejects.toThrow(/ESCAPE|syncIn rename/);

      expect(swapped).toBe(true);
      expect(await fs.readdir(outsideDir)).toHaveLength(0); // nothing landed outside the root
    });

    it("applies mapping.mode via the retained descriptor, defaulting to 0600 when unset", async () => {
      const remoteDir = await mkTempDir("paperclip-daytona-zstd-remote-");
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourceNoMode = path.join(hostDir, "no-mode.tar");
      const sourceWithMode = path.join(hostDir, "with-mode.tar");
      await writeCompressibleFile(sourceNoMode, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      await writeCompressibleFile(sourceWithMode, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 2048);
      const targetNoMode = path.posix.join(remoteDir, "no-mode.bin");
      const targetWithMode = path.posix.join(remoteDir, "with-mode.bin");

      const { sandbox } = createRealExecSandbox();
      const operations: PluginSyncOperation[] = [{
        operationId: "sync-op-1",
        files: [
          { sourcePath: sourceNoMode, targetPath: targetNoMode, kind: "file" },
          { sourcePath: sourceWithMode, targetPath: targetWithMode, kind: "file", mode: 0o640 },
        ],
      }];

      await performSyncIn({ sandbox: sandbox as never, operations, remoteDir, timeoutSeconds: 30 });

      expect((await fs.stat(targetNoMode)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(targetWithMode)).mode & 0o777).toBe(0o640);
    });

    it("runs two concurrent compressed sync operations without cross-talk", async () => {
      const remoteDirA = await mkTempDir("paperclip-daytona-zstd-remote-a-");
      const remoteDirB = await mkTempDir("paperclip-daytona-zstd-remote-b-");
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourceA = path.join(hostDir, "a.tar");
      const sourceB = path.join(hostDir, "b.tar");
      await writeCompressibleFile(sourceA, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 2048);
      await writeCompressibleFile(sourceB, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 4096);
      await fs.appendFile(sourceA, "AAAA-marker-a");
      await fs.appendFile(sourceB, "BBBB-marker-b");
      const targetA = path.posix.join(remoteDirA, "target.bin");
      const targetB = path.posix.join(remoteDirB, "target.bin");
      const { sandbox: sandboxA } = createRealExecSandbox();
      const { sandbox: sandboxB } = createRealExecSandbox();

      await Promise.all([
        performSyncIn({
          sandbox: sandboxA as never,
          operations: [{ operationId: "a", files: [{ sourcePath: sourceA, targetPath: targetA, kind: "file" }] }],
          remoteDir: remoteDirA,
          timeoutSeconds: 30,
        }),
        performSyncIn({
          sandbox: sandboxB as never,
          operations: [{ operationId: "b", files: [{ sourcePath: sourceB, targetPath: targetB, kind: "file" }] }],
          remoteDir: remoteDirB,
          timeoutSeconds: 30,
        }),
      ]);

      expect(await sha256OfFile(targetA)).toBe(await sha256OfFile(sourceA));
      expect(await sha256OfFile(targetB)).toBe(await sha256OfFile(sourceB));
    });

    it("emits exactly the five compression/decompress span attributes, with closed-set/numeric values", async () => {
      const spans: Array<{ attributes: Record<string, unknown> }> = [];
      const tracer = {
        startSpan(_name: string, options?: { attributes?: Record<string, unknown> }) {
          const span = { attributes: { ...(options?.attributes ?? {}) } as Record<string, unknown> };
          spans.push(span);
          return {
            setAttribute(key: string, value: unknown) {
              span.attributes[key] = value;
            },
            setStatus() {},
            end() {},
          };
        },
      };
      const restore = __setDaytonaPluginContextForTest({ tracer } as unknown as PluginContext);
      let targetPath = "";
      let remoteDir = "";
      try {
        remoteDir = await mkTempDir("paperclip-daytona-zstd-remote-");
        const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
        const sourcePath = path.join(hostDir, "workspace-upload.tar");
        await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
        targetPath = path.posix.join(remoteDir, "target.bin");
        const { sandbox } = createRealExecSandbox();
        await performSyncIn({
          sandbox: sandbox as never,
          operations: [{ operationId: "op-1", files: [{ sourcePath, targetPath, kind: "file" }] }],
          remoteDir,
          timeoutSeconds: 30,
        });
      } finally {
        restore();
      }

      const allAttrs: Record<string, unknown> = {};
      for (const span of spans) Object.assign(allAttrs, span.attributes);
      const compressionKeys = Object.keys(allAttrs).filter(
        (key) => key.includes(".transfer.compression.") || key.includes(".transfer.decompress."),
      );
      expect(new Set(compressionKeys)).toEqual(new Set([
        "paperclip.sandbox.startup.transfer.compression.codec",
        "paperclip.sandbox.startup.transfer.compression.wall_ms",
        "paperclip.sandbox.startup.transfer.compression.bytes_in",
        "paperclip.sandbox.startup.transfer.compression.bytes_out",
        "paperclip.sandbox.startup.transfer.decompress.wall_ms",
      ]));
      expect(allAttrs["paperclip.sandbox.startup.transfer.compression.codec"]).toBe("zstd");
      for (const key of [
        "paperclip.sandbox.startup.transfer.compression.wall_ms",
        "paperclip.sandbox.startup.transfer.compression.bytes_in",
        "paperclip.sandbox.startup.transfer.compression.bytes_out",
        "paperclip.sandbox.startup.transfer.decompress.wall_ms",
      ]) {
        expect(Number.isFinite(allAttrs[key] as number)).toBe(true);
      }
    });
  });

  describe("raw-path fallback conditions (no real sandbox exec needed)", () => {
    it("falls back to the raw path when the sandbox reports no zstd binary", async () => {
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "big.tar");
      await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      const uploadedSources: string[] = [];
      const uploadedDestinations: string[] = [];
      const sandbox = createRecordingSandbox({
        probeReportsZstd: false,
        uploadedSources,
        uploadedDestinations,
        commands: [],
      });
      const operations: PluginSyncOperation[] = [{
        operationId: "op-1",
        files: [{ sourcePath, targetPath: "/workspace/target.bin", kind: "file" }],
      }];

      await performSyncIn({ sandbox: sandbox as never, operations, remoteDir: "/workspace", timeoutSeconds: 30 });

      expect(uploadedSources).toEqual([sourcePath]); // raw source uploaded directly
      expect(uploadedDestinations.some((dest) => dest.endsWith(".zst"))).toBe(false);
    });

    it("falls back to the raw path when the source is below ZSTD_MIN_SOURCE_BYTES", async () => {
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "small.tar");
      await fs.writeFile(sourcePath, "well below the 8 MiB compression floor\n");
      const uploadedSources: string[] = [];
      const uploadedDestinations: string[] = [];
      const sandbox = createRecordingSandbox({
        probeReportsZstd: true,
        uploadedSources,
        uploadedDestinations,
        commands: [],
      });
      const operations: PluginSyncOperation[] = [{
        operationId: "op-1",
        files: [{ sourcePath, targetPath: "/workspace/target.bin", kind: "file" }],
      }];

      await performSyncIn({ sandbox: sandbox as never, operations, remoteDir: "/workspace", timeoutSeconds: 30 });

      expect(uploadedSources).toEqual([sourcePath]);
      expect(uploadedDestinations.some((dest) => dest.endsWith(".zst"))).toBe(false);
    });

    it("falls back to the raw path when the saving ratio is below ZSTD_MIN_SAVING_RATIO", async () => {
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "incompressible.tar");
      await writeIncompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      const uploadedSources: string[] = [];
      const uploadedDestinations: string[] = [];
      const sandbox = createRecordingSandbox({
        probeReportsZstd: true,
        uploadedSources,
        uploadedDestinations,
        commands: [],
      });
      const operations: PluginSyncOperation[] = [{
        operationId: "op-1",
        files: [{ sourcePath, targetPath: "/workspace/target.bin", kind: "file" }],
      }];

      await performSyncIn({ sandbox: sandbox as never, operations, remoteDir: "/workspace", timeoutSeconds: 30 });

      expect(uploadedSources).toEqual([sourcePath]); // host discarded the compressed candidate
      expect(uploadedDestinations.some((dest) => dest.endsWith(".zst"))).toBe(false);
    });

    it("falls back to the raw path when zlib.createZstdCompress is not a function (feature-detect)", async () => {
      // `createZstdCompress` is a non-writable (but configurable) property on
      // `node:zlib` — simulate an older Node runtime without zstd support by
      // redefining it, not assigning it.
      const original = zlib.createZstdCompress;
      Object.defineProperty(zlib, "createZstdCompress", { value: undefined, configurable: true, writable: true });
      try {
        const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
        const sourcePath = path.join(hostDir, "big.tar");
        await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
        const uploadedSources: string[] = [];
        const uploadedDestinations: string[] = [];
        const sandbox = createRecordingSandbox({
          probeReportsZstd: true,
          uploadedSources,
          uploadedDestinations,
          commands: [],
        });
        const operations: PluginSyncOperation[] = [{
          operationId: "op-1",
          files: [{ sourcePath, targetPath: "/workspace/target.bin", kind: "file" }],
        }];

        await performSyncIn({ sandbox: sandbox as never, operations, remoteDir: "/workspace", timeoutSeconds: 30 });

        expect(uploadedSources).toEqual([sourcePath]);
        expect(uploadedDestinations.some((dest) => dest.endsWith(".zst"))).toBe(false);
      } finally {
        Object.defineProperty(zlib, "createZstdCompress", { value: original, configurable: true, writable: true });
      }
    });

    it("falls back to the raw path when host compression throws, and leaves no host temp file", async () => {
      const original = zlib.createZstdCompress;
      const throwingCompressor = () =>
        new Transform({
          transform(_chunk, _encoding, callback) {
            callback(new Error("simulated host compression failure"));
          },
        }) as ReturnType<typeof zlib.createZstdCompress>;
      Object.defineProperty(zlib, "createZstdCompress", {
        value: throwingCompressor,
        configurable: true,
        writable: true,
      });
      try {
        const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
        const sourcePath = path.join(hostDir, "big.tar");
        await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
        const uploadedSources: string[] = [];
        const uploadedDestinations: string[] = [];
        const sandbox = createRecordingSandbox({
          probeReportsZstd: true,
          uploadedSources,
          uploadedDestinations,
          commands: [],
        });
        const operations: PluginSyncOperation[] = [{
          operationId: "op-1",
          files: [{ sourcePath, targetPath: "/workspace/target.bin", kind: "file" }],
        }];
        const before = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("paperclip-daytona-zstd-"));

        await performSyncIn({ sandbox: sandbox as never, operations, remoteDir: "/workspace", timeoutSeconds: 30 });

        expect(uploadedSources).toEqual([sourcePath]);
        expect(uploadedDestinations.some((dest) => dest.endsWith(".zst"))).toBe(false);
        const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("paperclip-daytona-zstd-"));
        expect(after).toEqual(before); // no leftover host temp file
      } finally {
        Object.defineProperty(zlib, "createZstdCompress", { value: original, configurable: true, writable: true });
      }
    });

    it("removes the private host temp directory when the post-compression size stat throws", async () => {
      const realStat = fs.stat.bind(fs);
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (targetPath, ...rest) => {
        if (typeof targetPath === "string" && path.basename(targetPath) === "artifact.zst") {
          throw new Error("simulated post-compression stat failure");
        }
        return (realStat as typeof fs.stat)(targetPath, ...(rest as []));
      });
      try {
        const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
        const sourcePath = path.join(hostDir, "big.tar");
        await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
        const uploadedSources: string[] = [];
        const uploadedDestinations: string[] = [];
        const sandbox = createRecordingSandbox({
          probeReportsZstd: true,
          uploadedSources,
          uploadedDestinations,
          commands: [],
        });
        const operations: PluginSyncOperation[] = [{
          operationId: "op-1",
          files: [{ sourcePath, targetPath: "/workspace/target.bin", kind: "file" }],
        }];
        const before = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("paperclip-daytona-zstd-"));

        await performSyncIn({ sandbox: sandbox as never, operations, remoteDir: "/workspace", timeoutSeconds: 30 });

        // The post-compression stat failed, so the candidate falls back to the raw path.
        expect(uploadedSources).toEqual([sourcePath]);
        expect(uploadedDestinations.some((dest) => dest.endsWith(".zst"))).toBe(false);
        const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("paperclip-daytona-zstd-"));
        expect(after).toEqual(before); // the stat failure did not leak the private host temp directory
      } finally {
        statSpy.mockRestore();
      }
    });

    it("removes the host compressed temp file and sweeps sandbox scratch when the upload itself is rejected (cancellation)", async () => {
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "big.tar");
      await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      const commands: RecordedCommand[] = [];
      const sandbox = {
        process: {
          executeCommand: async (command: string) => {
            commands.push({ command });
            return { exitCode: 0, result: command.includes("mkdir -p") ? "PAPERCLIP_ZSTD_AVAILABLE\n" : "" };
          },
        },
        fs: {
          uploadFiles: async () => {
            throw new Error("simulated cancellation");
          },
          setFilePermissions: async () => undefined,
        },
      };
      const before = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("paperclip-daytona-zstd-"));
      const operations: PluginSyncOperation[] = [{
        operationId: "op-1",
        files: [{ sourcePath, targetPath: "/workspace/target.bin", kind: "file" }],
      }];

      await expect(
        performSyncIn({ sandbox: sandbox as never, operations, remoteDir: "/workspace", timeoutSeconds: 30 }),
      ).rejects.toThrow(/simulated cancellation/);

      const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("paperclip-daytona-zstd-"));
      expect(after).toEqual(before); // no leftover host temp file
      const rmCommands = commands.filter((entry) => entry.command.includes("rm -f"));
      expect(rmCommands.length).toBeGreaterThan(0); // both reserved scratch names swept
    });

    it("stages the compressed artifact in a private 0700 directory with a 0600 file, and removes the directory when the upload fails", async () => {
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "big.tar");
      await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      let capturedDir = "";
      let capturedDirMode = -1;
      let capturedFileMode = -1;
      const sandbox = {
        process: {
          executeCommand: async (command: string) => ({
            exitCode: 0,
            result: command.includes("mkdir -p") ? "PAPERCLIP_ZSTD_AVAILABLE\n" : "",
          }),
        },
        fs: {
          uploadFiles: async (uploads: Array<{ source: string; destination: string }>) => {
            const zstdUpload = uploads.find((upload) => upload.destination.endsWith(".zst"));
            if (!zstdUpload) throw new Error("test setup: expected a compressed upload");
            // Read the modes BEFORE throwing: the directory and its file still
            // exist at this point, on the way to the (simulated) failed upload.
            capturedDir = path.dirname(zstdUpload.source);
            capturedDirMode = (await fs.stat(capturedDir)).mode & 0o777;
            capturedFileMode = (await fs.stat(zstdUpload.source)).mode & 0o777;
            throw new Error("simulated upload failure");
          },
          setFilePermissions: async () => undefined,
        },
      };
      const operations: PluginSyncOperation[] = [{
        operationId: "op-1",
        files: [{ sourcePath, targetPath: "/workspace/target.bin", kind: "file" }],
      }];

      await expect(
        performSyncIn({ sandbox: sandbox as never, operations, remoteDir: "/workspace", timeoutSeconds: 30 }),
      ).rejects.toThrow(/simulated upload failure/);

      expect(capturedDirMode).toBe(0o700);
      expect(capturedFileMode).toBe(0o600);
      // The private directory (not only the file) is removed after the upload fails.
      await expect(fs.stat(capturedDir)).rejects.toThrow();
    });

    it("passes the caller's timeoutSeconds unchanged through every round trip on the compressed path", async () => {
      const hostDir = await mkTempDir("paperclip-daytona-zstd-host-");
      const sourcePath = path.join(hostDir, "big.tar");
      await writeCompressibleFile(sourcePath, ZSTD_MIN_SOURCE_BYTES_FOR_TEST + 1024);
      const seenTimeouts: Array<number | undefined> = [];
      const sandbox = {
        process: {
          executeCommand: async (command: string, _cwd?: string, _env?: unknown, timeoutSeconds?: number) => {
            seenTimeouts.push(timeoutSeconds);
            return { exitCode: 0, result: command.includes("mkdir -p") ? "PAPERCLIP_ZSTD_AVAILABLE\n" : "" };
          },
        },
        fs: {
          uploadFiles: async (_uploads: unknown, timeoutSeconds?: number) => {
            seenTimeouts.push(timeoutSeconds);
          },
          setFilePermissions: async () => undefined,
        },
      };
      const operations: PluginSyncOperation[] = [{
        operationId: "op-1",
        files: [{ sourcePath, targetPath: "/workspace/target.bin", kind: "file" }],
      }];

      await performSyncIn({ sandbox: sandbox as never, operations, remoteDir: "/workspace", timeoutSeconds: 123 });

      expect(seenTimeouts.length).toBeGreaterThanOrEqual(4); // mkdir+probe, checkSymlinkEscape, transfer, promote
      expect(seenTimeouts.every((timeout) => timeout === 123)).toBe(true);
    });
  });
});
