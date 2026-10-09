import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { environmentSyncErrorData, withEnvironmentSyncErrorCapture, readEnvironmentSyncErrorDiagnostic } from "@paperclipai/plugin-sdk";
vi.mock("./plugin.js", async () => {
  const { NOOP_PLUGIN_TRACER } = await import("@paperclipai/plugin-sdk");
  return { getPluginTracer: () => NOOP_PLUGIN_TRACER };
});
import { performSyncOut } from "./file-sync.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

it.each([
  ["guard", "sandbox_guard", "command_failed", 42],
  ["create", "archive_create", "command_failed", 2],
  ["download", "archive_download", "download_failed", undefined],
  ["missing", "archive_download", "download_missing", undefined],
  ["file", "file_download", "download_failed", undefined],
  ["file-missing", "file_download", "download_missing", undefined],
] as const)("records producer evidence for %s without copying output or paths", async (failure, step, kind, exitCode) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daytona-diagnostic-"));
  dirs.push(dir);
  const sandbox = {
    process: { executeCommand: async (command: string) => ({
      exitCode: failure === "guard" ? 42 : failure === "create" && command.includes("tar -c") ? 2 : 0,
      result: "private-command-output",
    }) },
    fs: {
      downloadFiles: async (requests: Array<{ source: string }>) => failure.endsWith("missing") ? []
        : requests.map(request => ({ source: request.source, error: "private-download-error" })),
      deleteFile: async () => undefined,
    },
  };
  await withEnvironmentSyncErrorCapture(async () => {
    let caught: unknown;
    try {
      await performSyncOut({ sandbox: sandbox as never, remoteDir: "/workspace", timeoutSeconds: 30,
        operations: [{ operationId: "fixture", files: [{
          sourcePath: "/workspace/private-path", targetPath: path.join(dir, "target"), kind: failure.startsWith("file") ? "file" : "directory",
        }] }],
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    const diagnostic = readEnvironmentSyncErrorDiagnostic({ data: environmentSyncErrorData(caught) });
    expect(diagnostic).toEqual({ errorCode: "unknown", transferStep: step, transferFailureKind: kind,
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private-");
    expect(caught).not.toHaveProperty("transferStep");
    expect(caught).not.toHaveProperty("exitCode");
  });
});

it("keeps a thrown download exception identical and its nested safe code", async () => {
  const original = Object.freeze(new Error("private-download-error", { cause: { code: "ECONNRESET", token: "private-token" } }));
  const sandbox = {
    process: { executeCommand: async () => ({ exitCode: 0 }) },
    fs: { downloadFiles: async () => { throw original; }, deleteFile: async () => undefined },
  };
  await withEnvironmentSyncErrorCapture(async () => {
    await expect(performSyncOut({ sandbox: sandbox as never, remoteDir: "/workspace", timeoutSeconds: 30,
      operations: [{ operationId: "fixture", files: [{ sourcePath: "/workspace/private-path", targetPath: "/unused", kind: "directory" }] }],
    })).rejects.toBe(original);
    expect(readEnvironmentSyncErrorDiagnostic({ data: environmentSyncErrorData(original) })).toEqual({
      errorCode: "ECONNRESET", transferStep: "archive_download",
    });
  });
});


it.each(["file_finalize", "archive_validate", "archive_extract"] as const)("identifies the host-side %s failure without relaxing confinement", async (step) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daytona-host-diagnostic-"));
  dirs.push(dir);
  const target = path.join(dir, "target");
  const archive = path.join(dir, "safe.tar");
  if (step === "archive_extract") {
    await fs.writeFile(path.join(dir, "safe.txt"), "fixture");
    execFileSync("tar", ["-cf", archive, "-C", dir, "safe.txt"]);
    await fs.writeFile(target, "preserve target");
  }
  const sandbox = {
    process: { executeCommand: async () => ({ exitCode: 0 }) },
    fs: {
      downloadFiles: async (requests: Array<{ source: string; destination: string }>) => {
        for (const request of requests) {
          if (step === "archive_validate") await fs.writeFile(request.destination, "invalid private archive");
          if (step === "archive_extract") await fs.copyFile(archive, request.destination);
        }
        return requests.map(request => ({ source: request.source }));
      },
      deleteFile: async () => undefined,
    },
  };
  await withEnvironmentSyncErrorCapture(async () => {
    let caught: unknown;
    try {
      await performSyncOut({ sandbox: sandbox as never, remoteDir: "/workspace", timeoutSeconds: 30,
        operations: [{ operationId: "fixture", files: [{ sourcePath: "/workspace/private-path", targetPath: target,
          kind: step === "file_finalize" ? "file" : "directory" }] }],
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    const diagnostic = readEnvironmentSyncErrorDiagnostic({ data: environmentSyncErrorData(caught) });
    expect(diagnostic?.transferStep).toBe(step);
    expect(JSON.stringify(diagnostic)).not.toContain("private");
    if (step === "file_finalize") expect(diagnostic?.errorCode).toBe("ENOENT");
    if (step === "archive_validate") expect(diagnostic?.transferFailureKind).toBe("command_failed");
    if (step === "archive_extract") expect(await fs.readFile(target, "utf8")).toBe("preserve target");
  });
});
