import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { restoreWorkspaceFromSshExecution } from "./ssh.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  createWriteStream: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

it.each(["stdout", "sink", "exit", "spawn"])("rejects an SSH export %s failure and releases the streams", async (failure) => {
  const error = new Error("transfer failed");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn() });
  vi.mocked(createWriteStream).mockReturnValue(sink as ReturnType<typeof createWriteStream>);
  vi.mocked(spawn).mockImplementation(() => {
    setImmediate(() => {
      if (failure === "stdout") stdout.destroy(error);
      if (failure === "sink") sink.destroy(error);
      if (failure === "spawn") child.emit("error", error);
      if (failure === "exit") {
        stderr.write(error.message);
        stdout.end();
        child.emit("close", 1);
      }
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
    callback(null, "", "");
    return {} as ReturnType<typeof execFile>;
  });
  await expect(restoreWorkspaceFromSshExecution({
    spec: {
      host: "fixture.invalid", username: "fixture", port: 22,
      remoteCwd: "/remote", remoteWorkspacePath: "/remote",
      privateKey: null, knownHosts: null, strictHostKeyChecking: true,
    },
    localDir: "/local",
    baselineSnapshot: { entries: new Map(), exclude: [] },
    restoreGitHistory: true,
    onProgress: async () => {},
  })).rejects.toThrow(error.message);
  expect(stdout.destroyed).toBe(true);
  expect(sink.destroyed).toBe(true);
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  expect(vi.mocked(execFile).mock.calls.some((call) => (call[1] as string[]).includes("fetch"))).toBe(false);
});

it.each([false, true])("drains SSH export before fetching with progress=%s", async (withProgress) => {
  const chunks = Array.from({ length: 16 }, (_, index) => Buffer.alloc(64 * 1024, index));
  const received: Buffer[] = [];
  let fetched: Buffer | undefined;
  const sink = new Writable({
    highWaterMark: 1024,
    write(chunk, _encoding, callback) {
      setTimeout(() => { received.push(Buffer.from(chunk)); callback(); }, 2);
    },
  });
  vi.mocked(createWriteStream).mockReturnValue(sink as ReturnType<typeof createWriteStream>);
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Readable.from(chunks), stderr: new PassThrough(), kill: vi.fn(),
    });
    child.stdout.on("end", () => child.emit("close", 0));
    return child as unknown as ReturnType<typeof spawn>;
  });
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const argv = args[1] as string[];
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    if (argv.includes("fetch")) {
      fetched = Buffer.concat(received);
      callback(new Error("stop after fetch"), "", "");
    } else {
      callback(null, "", "");
    }
    return {} as ReturnType<typeof execFile>;
  });
  await expect(restoreWorkspaceFromSshExecution({
    spec: {
      host: "fixture.invalid", username: "fixture", port: 22,
      remoteCwd: "/remote", remoteWorkspacePath: "/remote",
      privateKey: null, knownHosts: null, strictHostKeyChecking: true,
    },
    localDir: "/local",
    baselineSnapshot: { entries: new Map(), exclude: [] },
    restoreGitHistory: true,
    ...(withProgress ? { onProgress: async () => {} } : {}),
  })).rejects.toThrow("stop after fetch");
  expect(fetched).toEqual(Buffer.concat(chunks));
});
