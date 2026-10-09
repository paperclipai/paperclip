import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import * as tar from "tar";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreateosClient } from "./client.js";
import { parseConfig } from "./config.js";
import { assertRemotePath, syncFiles, validateArchive } from "./file-sync.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("./execute.js", async (original) => ({ ...await original<typeof import("./execute.js")>(), execute: run }));

const config = { apiUrl: "https://createos.example.test", apiKey: "secret", shape: "test", timeoutMs: 5000 };
const client = () => new CreateosClient(parseConfig(config));
const params = { driverKey: "createos", companyId: "c", environmentId: "e", config, lease: { providerLeaseId: "sb_test" } };
let temp: string;
let downloads: Buffer;
let uploads: Buffer[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "createos-sync-test-"));
  downloads = Buffer.from("data");
  uploads = [];
  run.mockReset().mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
  fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    expect(init.headers).toMatchObject({ "X-Api-Key": "secret" });
    if (init.method === "PUT") {
      uploads.push(Buffer.from(await new Response(init.body).arrayBuffer()));
      return Response.json({ status: "success", data: {} });
    }
    if (new URL(url).pathname.endsWith("/files")) return new Response(downloads);
    return Response.json({ status: "success", data: { result: { exit_code: 0 } } });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(temp, { recursive: true, force: true }); });

it("uploads binary bytes directly and applies the requested mode before promotion", async () => {
  const source = path.join(temp, "secret");
  const bytes = Buffer.from([0, 255, 128, 10, 13]);
  await fs.writeFile(source, bytes);
  const result = await syncFiles(client(), { ...params, operations: [{ operationId: "asset", files: [{
    sourcePath: source, targetPath: "/paperclip-workspace/secret", kind: "file", mode: 0o600,
  }] }] }, "in", AbortSignal.timeout(5000));
  expect(uploads).toEqual([bytes]);
  expect(run.mock.calls[0][1].args[1]).toContain("chmod 600");
  expect(result.operations[0]).toMatchObject({ filesTransferred: 1, bytesTransferred: bytes.length });
});

it("downloads more than the process journal limit through the binary API with exact contents and mode", async () => {
  downloads = Buffer.alloc(5 * 1024 * 1024, 0xa5);
  const target = path.join(temp, "result");
  const result = await syncFiles(client(), { ...params, operations: [{ operationId: "workspace", files: [{
    sourcePath: "/paperclip-workspace/big.bin", targetPath: target, kind: "file", mode: 0o600,
  }] }] }, "out", AbortSignal.timeout(5000));
  expect((await fs.readFile(target)).equals(downloads)).toBe(true);
  expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  expect(result.operations[0].bytesTransferred).toBe(downloads.length);
  expect(run.mock.calls[0][1].args[1]).toContain("cp --");
  expect(run.mock.calls[0][1].args[1]).not.toContain("base64");
});

it("never replaces an existing host file with a partial download", async () => {
  const target = path.join(temp, "result");
  await fs.writeFile(target, "original");
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (new URL(url).pathname.endsWith("/files") && (!init?.method || init.method === "GET")) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.error(new Error("connection lost")); },
    }));
    return normal(url, init);
  });
  await expect(syncFiles(client(), { ...params, operations: [{ operationId: "file", files: [{
    sourcePath: "/paperclip-workspace/result", targetPath: target, kind: "file",
  }] }] }, "out", AbortSignal.timeout(5000))).rejects.toThrow();
  expect(await fs.readFile(target, "utf8")).toBe("original");
  expect(await fs.readdir(temp)).toEqual(["result"]);
});

it("preserves directory files, modes, and internal symlinks while honoring exclusions", async () => {
  const source = path.join(temp, "source");
  await fs.mkdir(path.join(source, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(source, "keep"), "hello", { mode: 0o600 });
  await fs.writeFile(path.join(source, "node_modules", "skip"), "ignored");
  await fs.symlink("keep", path.join(source, "link"));
  await syncFiles(client(), { ...params, operations: [{ operationId: "directory", files: [{
    sourcePath: source, targetPath: "/paperclip-workspace/project", kind: "directory", exclude: ["node_modules"],
  }] }] }, "in", AbortSignal.timeout(5000));
  downloads = uploads[0];
  const target = path.join(temp, "restored");
  await syncFiles(client(), { ...params, operations: [{ operationId: "directory", files: [{
    sourcePath: "/paperclip-workspace/project", targetPath: target, kind: "directory",
  }] }] }, "out", AbortSignal.timeout(5000));
  expect(await fs.readdir(target)).toEqual(["keep", "link"]);
  expect(await fs.readFile(path.join(target, "keep"), "utf8")).toBe("hello");
  expect((await fs.stat(path.join(target, "keep"))).mode & 0o777).toBe(0o600);
  expect(await fs.readlink(path.join(target, "link"))).toBe("keep");
});

it("rejects an archive carrying an escaping symlink before extracting any files", async () => {
  const source = path.join(temp, "malicious");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "safe"), "content");
  await fs.symlink("../../outside", path.join(source, "escape"));
  const file = path.join(temp, "malicious.tar");
  await tar.c({ cwd: source, file }, ["."]);
  await expect(validateArchive(file)).rejects.toThrow("unsafe entries");
  downloads = await fs.readFile(file);
  const target = path.join(temp, "restored");
  await expect(syncFiles(client(), { ...params, operations: [{ operationId: "directory", files: [{
    sourcePath: "/paperclip-workspace/project", targetPath: target, kind: "directory",
  }] }] }, "out", AbortSignal.timeout(5000))).rejects.toThrow("unsafe entries");
  await expect(fs.stat(target)).rejects.toThrow();
});

it("runs post-upload commands verbatim and stops after the first failure", async () => {
  const command = "printf 'first'; printf 'second'";
  run.mockImplementation(async (_client, execution) => ({ exitCode: execution.args[1] === command ? 1 : 0, timedOut: false, stdout: "", stderr: "" }));
  await expect(syncFiles(client(), { ...params, operations: [{ operationId: "commands", files: [], postUploadCommands: [
    { command, cwd: "/paperclip-workspace/project" }, { command: "must-not-run" },
  ] }] }, "in", AbortSignal.timeout(5000))).rejects.toThrow("transfer command failed");
  const commands = run.mock.calls.map((call) => call[1].args[1]);
  expect(commands).toContain(command);
  expect(commands).not.toContain("must-not-run");
});

it.each(["/etc/passwd", "/paperclip-workspace/../secret", "relative", "/paperclip-workspace-other/file"])("rejects unconfined sandbox path %s before any API call", async (sourcePath) => {
  expect(() => assertRemotePath(sourcePath)).toThrow();
  await expect(syncFiles(client(), { ...params, operations: [{ operationId: "bad", files: [{
    sourcePath, targetPath: path.join(temp, "file"), kind: "file",
  }] }] }, "out", AbortSignal.timeout(5000))).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
vi.mock("./request-pacer.js", () => ({ waitForRequest: vi.fn().mockResolvedValue(undefined) }));
