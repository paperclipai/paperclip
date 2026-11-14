import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) =>
      file === "ssh"
        ? actual.spawn("sh", ["-c", args.at(-1)!], options)
        : actual.spawn(file, args, options)),
    execFile: vi.fn((file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) =>
      file === "ssh"
        ? actual.execFile("sh", ["-c", args.at(-1)!], options, callback)
        : actual.execFile(file, args, options, callback)),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: vi.fn((...args: Parameters<typeof actual.createWriteStream>) => {
      const sink = actual.createWriteStream(...args);
      const write = sink._write.bind(sink);
      const writev = sink._writev!.bind(sink);
      sink._write = (...writeArgs) => { setTimeout(() => write(...writeArgs), 2); };
      sink._writev = (...writeArgs) => { setTimeout(() => writev(...writeArgs), 2); };
      return sink;
    }),
  };
});

import { restoreWorkspaceFromSshExecution } from "./ssh.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("SSH git export", () => {
  it.each(["exit", "source", "sink"] as const)("rejects an export on %s failure", async (failure) => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const error = new Error("transfer failed");
    vi.mocked(spawn).mockImplementationOnce((_file, _args, options) => {
      const child = actual.spawn("sh", ["-c", failure === "exit" ? "printf 'export failed' >&2; exit 7" : "printf payload"], options);
      if (failure === "source") queueMicrotask(() => child.stdout!.destroy(error));
      return child;
    });
    if (failure === "sink") {
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.mocked(createWriteStream).mockImplementationOnce((...args) => {
        const sink = fs.createWriteStream(...args);
        queueMicrotask(() => sink.destroy(error));
        return sink;
      });
    }
    await expect(restoreWorkspaceFromSshExecution({
      spec: {
        host: "fixture.invalid", username: "fixture", port: 22,
        remoteCwd: "/remote", remoteWorkspacePath: "/remote",
        privateKey: null, knownHosts: null, strictHostKeyChecking: false,
      },
      localDir: "/unused",
      baselineSnapshot: { exclude: [], entries: new Map() },
      restoreGitHistory: true,
      onProgress: async () => {},
    })).rejects.toEqual(failure === "exit" ? new Error("export failed") : error);
  });

  it.each([false, true])("drains the local bundle under backpressure with progress=%s", async (withProgress) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ssh-export-"));
    roots.push(root);
    const remoteDir = path.join(root, "remote");
    const localDir = path.join(root, "local");
    await mkdir(remoteDir);
    await run("git", ["init", remoteDir]);
    const contents = randomBytes(2 * 1024 * 1024);
    await writeFile(path.join(remoteDir, "payload"), contents);
    await run("git", ["-C", remoteDir, "add", "payload"]);
    await run("git", ["-C", remoteDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "payload"]);
    await run("git", ["clone", remoteDir, localDir]);
    await writeFile(path.join(remoteDir, "updated"), "remote commit\n");
    await run("git", ["-C", remoteDir, "add", "updated"]);
    await run("git", ["-C", remoteDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "update"]);

    await restoreWorkspaceFromSshExecution({
      spec: {
        host: "fixture.invalid", username: "fixture", port: 22,
        remoteCwd: remoteDir, remoteWorkspacePath: remoteDir,
        privateKey: null, knownHosts: null, strictHostKeyChecking: false,
      },
      localDir, remoteDir,
      ...(withProgress ? { onProgress: async () => {} } : {}),
    });

    expect((await run("git", ["-C", localDir, "rev-parse", "HEAD"])).stdout)
      .toBe((await run("git", ["-C", remoteDir, "rev-parse", "HEAD"])).stdout);
    expect(await readFile(path.join(localDir, "payload"))).toEqual(contents);
    expect(await readFile(path.join(localDir, "updated"), "utf8")).toBe("remote commit\n");
  }, 30_000);
});
