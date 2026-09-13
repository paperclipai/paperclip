import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runWithSandboxPerformanceTrace, type SandboxPerformanceRecord } from "../services/sandbox-performance.js";
import { workFolderTransport } from "../services/work-folder-transport.js";
import { localTestWorkFolderRunner } from "./helpers/work-folder-runner.js";

const exec = promisify(execFile);
describe("sandbox work folder transport with real Node and Git", () => {
  const roots: string[] = [];
  const transport = workFolderTransport(localTestWorkFolderRunner);
  async function root() {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "work-folder-io-")));
    roots.push(dir); return dir;
  }
  afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
  it("records host and remote timing without changing bytes or exporting paths", async () => {
    const dir = await root(), staging = await root();
    const payload = Buffer.from("private-file-content");
    const records: SandboxPerformanceRecord[] = [];
    const fast = workFolderTransport({ ...localTestWorkFolderRunner, supportsSingleStreamStdinProgress: true });
    await runWithSandboxPerformanceTrace({ runId: "test-run", enabled: true,
      onBatch: async (batch) => { records.push(...batch.records); } }, async () => {
      await fast.write(dir, staging, { path: "sensitive-file-name", kind: "file", byteSize: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"), executable: false }, Readable.from([payload]));
      const files = await fast.scan(dir);
      expect(await fast.readBatch!(dir, files.filter((entry) => entry.kind === "file"))).toEqual([payload]);
    });
    const roundtrip = records.find((record) => record.name === "work_folder.transport.roundtrip" && record.attributes.operation === "batch");
    expect(roundtrip?.attributes.executionMs).toBeGreaterThanOrEqual(0);
    expect(roundtrip?.attributes.transportOverheadMs).toBeGreaterThanOrEqual(0);
    expect(records.some((record) => record.name === "work_folder.transport.incoming_body")).toBe(true);
    expect(records.some((record) => record.name === "work_folder.transport.encode_bytes")).toBe(true);
    const remote = records.filter((record) => record.clock === "remote_relative");
    expect(remote.length).toBeGreaterThan(0);
    expect(remote.some((record) => record.name === "work_folder.remote.hash")).toBe(true);
    expect(remote.some((record) => record.name === "work_folder.remote.scan")).toBe(true);
    expect(remote.some((record) => record.name === "sandbox.invalid_operation")).toBe(false);
    expect(remote.every((record) => records.some((parent) => parent.id === record.parentId && parent.name === "work_folder.transport.roundtrip"))).toBe(true);
    for (const secret of [dir, staging, "sensitive-file-name", payload.toString()]) expect(JSON.stringify(records)).not.toContain(secret);
    expect(await readFile(path.join(dir, "sensitive-file-name"))).toEqual(payload);
  });
  it("keeps the helper's original raw result when performance is not requested", async () => {
    const script = await readFile(new URL("../services/scripts/work-folder-io.mjs", import.meta.url), "utf8");
    const result = await exec(process.execPath, ["--input-type=module", "-e", script,
      Buffer.from(JSON.stringify({ operation: "home" })).toString("base64")]);
    expect(JSON.parse(result.stdout)).toEqual({ home: os.homedir() });
    expect(result.stdout).not.toContain("workFolderPerformanceVersion");
  });
  it("does not discard a valid result or retry a command because diagnostics are malformed", async () => {
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false, stderr: "", stdout: JSON.stringify({
      workFolderPerformanceVersion: 1, result: { home: "/home/daytona" }, performance: { executionMs: "invalid" },
    }) });
    const records: SandboxPerformanceRecord[] = [];
    await runWithSandboxPerformanceTrace({ runId: "run", enabled: true,
      onBatch: async (batch) => { records.push(...batch.records); } }, async () => {
      expect(await workFolderTransport({ execute }).home()).toBe("/home/daytona");
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(records.find((record) => record.name === "work_folder.transport.roundtrip")?.attributes.dropped).toBe(1);
    execute.mockClear().mockResolvedValue({ exitCode: 1, timedOut: false, stderr: "socket hang up", stdout: "" });
    await expect(workFolderTransport({ execute }).home()).rejects.toThrow("socket hang up");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("bounds remote phase records while retaining complete aggregate hash counts", async () => {
    const dir = await root();
    await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(path.join(dir, `file-${index}`), "x")));
    const script = await readFile(new URL("../services/scripts/work-folder-io.mjs", import.meta.url), "utf8");
    const response = await exec(process.execPath, ["--input-type=module", "-e", script,
      Buffer.from(JSON.stringify({ operation: "scan", root: dir, performance: true })).toString("base64")]);
    const decoded = JSON.parse(response.stdout);
    expect(decoded.result).toHaveLength(300);
    expect(decoded.remotePhases).toHaveLength(256);
    expect(decoded.performance.hashFiles).toBe(300);
    expect(decoded.performance.hashBytes).toBe(300);
    expect(decoded.performance.droppedPhases).toBeGreaterThan(0);
    expect(decoded.performance.executionMs).toBeGreaterThanOrEqual(decoded.performance.scanMs);
    expect(JSON.stringify(decoded.remotePhases)).not.toContain(dir);
    expect(JSON.stringify(decoded.remotePhases)).not.toContain("file-");
  });
  it("retries a lost read response without duplicating streamed bytes", async () => {
    const dir = await root();
    const body = Buffer.alloc(700_000, "x");
    await writeFile(path.join(dir, "file"), body);
    let lostResponse = false;
    const execute = vi.fn(async (input: Parameters<typeof localTestWorkFolderRunner.execute>[0]) => {
      const result = await localTestWorkFolderRunner.execute(input);
      const request = JSON.parse(Buffer.from(input.args!.at(-1)!, "base64").toString());
      if (request.operation === "read" && request.offset > 0 && !lostResponse) {
        lostResponse = true;
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }
      return result;
    });
    const chunks = [];
    for await (const chunk of workFolderTransport({ execute }).read(dir, "file", body.length)) chunks.push(chunk);
    expect(lostResponse).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(body);
    const offsets = execute.mock.calls.map(([input]) => JSON.parse(Buffer.from(input.args!.at(-1)!, "base64").toString()).offset);
    expect(offsets.filter((offset) => offset === offsets[1])).toHaveLength(2);
  });
  it("bounds read retries and does not replay mutations or validation failures", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const retrying = workFolderTransport({ execute });
    await expect(retrying.scan("/home/daytona/task")).rejects.toThrow("socket hang up");
    expect(execute).toHaveBeenCalledTimes(3);
    execute.mockClear();
    await expect(retrying.moveRoot("/old", "/new")).rejects.toThrow("socket hang up");
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockReset().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "symlink_not_allowed", timedOut: false });
    await expect(retrying.scan("/home/daytona/task")).rejects.toThrow("symlink_not_allowed");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each(["before", "after"])("recovers a root-directory transport failure %s creation without replacing files", async (when) => {
    const dir = path.join(await root(), "task");
    let failed = false;
    const execute = vi.fn(async (input: Parameters<typeof localTestWorkFolderRunner.execute>[0]) => {
      if (!failed) {
        failed = true;
        if (when === "after") {
          expect((await localTestWorkFolderRunner.execute(input)).exitCode).toBe(0);
          await writeFile(path.join(dir, "retained"), "unsaved work", { mode: 0o751 });
        }
        throw Object.assign(new Error("Request failed with status code 502: Sandbox command requested here"), {
          name: "JsonRpcCallError", code: -32002,
        });
      }
      return localTestWorkFolderRunner.execute(input);
    });
    await workFolderTransport({ execute }).mkdirRoot(dir);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0].args).toEqual(execute.mock.calls[0]![0].args);
    expect((await stat(dir)).isDirectory()).toBe(true);
    if (when === "after") {
      expect(await readFile(path.join(dir, "retained"), "utf8")).toBe("unsaved work");
      expect((await stat(path.join(dir, "retained"))).mode & 0o777).toBe(0o751);
    }
  });
  it("revalidates a root replaced by a symlink after a lost creation response", async () => {
    const dir = path.join(await root(), "task"), outside = await root();
    await writeFile(path.join(outside, "private"), "untouched");
    let failed = false;
    const execute = vi.fn(async (input: Parameters<typeof localTestWorkFolderRunner.execute>[0]) => {
      const result = await localTestWorkFolderRunner.execute(input);
      if (!failed) {
        failed = true;
        expect(result.exitCode).toBe(0);
        await rm(dir, { recursive: true });
        await symlink(outside, dir);
        throw Object.assign(new Error("upstream unavailable"), { status: 502 });
      }
      return result;
    });
    await expect(workFolderTransport({ execute }).mkdirRoot(dir)).rejects.toThrow("symlink_not_allowed");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(outside, "private"), "utf8")).toBe("untouched");
  });
  it("bounds root-directory retries and keeps non-idempotent mutations single-attempt", async () => {
    const execute = vi.fn().mockRejectedValue(Object.assign(new Error("upstream unavailable"), { status: 503 }));
    const retrying = workFolderTransport({ execute });
    await expect(retrying.mkdirRoot("/home/daytona/task")).rejects.toThrow("upstream unavailable");
    expect(execute).toHaveBeenCalledTimes(3);
    for (const mutate of [() => retrying.moveRoot("/old", "/new"), () => retrying.remove("/root", "file")]) {
      execute.mockClear();
      await expect(mutate()).rejects.toThrow("upstream unavailable");
      expect(execute).toHaveBeenCalledOnce();
    }
    execute.mockReset().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "symlink_not_allowed", timedOut: false });
    await expect(retrying.mkdirRoot("/home/daytona/task")).rejects.toThrow("symlink_not_allowed");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("streams and atomically publishes files larger than a transfer chunk", async () => {
    const dir = await root();
    const staging = await root();
    const body = Buffer.alloc(700_000, "x");
    const entry = { path: "nested/file", kind: "file" as const, byteSize: body.length,
      sha256: createHash("sha256").update(body).digest("hex"), executable: true };
    const boundedTransport = workFolderTransport({ async execute(input) {
      // macOS permits larger argv entries than Linux; enforce the deployment
      // bound here as well so this regression is caught on developer machines.
      expect(Buffer.byteLength([input.command, ...(input.args ?? [])].join(" "))).toBeLessThan(120 * 1024);
      return localTestWorkFolderRunner.execute(input);
    } });
    await boundedTransport.write(dir, staging, entry, Readable.from([body]));
    expect(await readFile(path.join(dir, entry.path))).toEqual(body);
    const files = await transport.scan(dir);
    expect(files.find((file) => file.path === entry.path)).toEqual(entry);
  });
  it("batches many files and large files with bounded stdin, preserving empty files and executable modes", async () => {
    const dir = await root(), staging = await root();
    const execute = vi.fn(async (input: Parameters<typeof localTestWorkFolderRunner.execute>[0]) => {
      expect(Buffer.byteLength(input.stdin ?? "")).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(Buffer.byteLength((input.args ?? []).join(" "))).toBeLessThan(120 * 1024);
      return localTestWorkFolderRunner.execute(input);
    });
    const fast = workFolderTransport({ execute, supportsSingleStreamStdinProgress: true });
    const data = Buffer.alloc(5 * 1024 * 1024 + 17, "x");
    const emptyHash = createHash("sha256").digest("hex");
    await fast.writeMany(dir, staging, (async function* () {
      yield { entry: { path: "empty-dir", kind: "directory" as const, byteSize: 0, sha256: null, executable: false } };
      for (let i = 0; i < 169; i++) yield { entry: { path: `nested/empty-${i}`, kind: "file" as const,
        byteSize: 0, sha256: emptyHash, executable: false }, body: Readable.from([]) };
      yield { entry: { path: "large", kind: "file" as const, byteSize: data.length,
        sha256: createHash("sha256").update(data).digest("hex"), executable: true }, body: Readable.from([data]) };
    })());
    expect(execute).toHaveBeenCalledTimes(3);
    expect(await readFile(path.join(dir, "large"))).toEqual(data);
    const listed = await fast.scan(dir);
    expect(listed.filter((entry) => entry.kind === "file")).toHaveLength(170);
    expect(listed.find((entry) => entry.path === "large")?.executable).toBe(true);
    expect(listed.find((entry) => entry.path === "empty-dir")?.kind).toBe("directory");
    execute.mockClear();
    const chunks = [];
    for await (const chunk of fast.read(dir, "large", data.length)) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(data);
    expect(execute).toHaveBeenCalledTimes(6);
  }, 60_000);
  it("reads small files in one confined batch and rejects short or oversized batches", async () => {
    const dir = await root(), outside = await root();
    const execute = vi.fn(localTestWorkFolderRunner.execute);
    const fast = workFolderTransport({ execute, supportsSingleStreamStdinProgress: true });
    const entries = [];
    for (let i = 0; i < 32; i++) {
      const data = Buffer.alloc(i === 0 ? 0 : 1024, i);
      await writeFile(path.join(dir, String(i)), data);
      entries.push({ path: String(i), kind: "file" as const, byteSize: data.length,
        sha256: createHash("sha256").update(data).digest("hex"), executable: false });
    }
    const buffers = await fast.readBatch!(dir, entries);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(buffers.map((buffer) => createHash("sha256").update(buffer).digest("hex")))
      .toEqual(entries.map((entry) => entry.sha256));
    await writeFile(path.join(dir, "1"), "short");
    await expect(fast.readBatch!(dir, entries)).rejects.toThrow("changed during transfer");
    await writeFile(path.join(outside, "private"), "secret");
    await symlink(path.join(outside, "private"), path.join(dir, "link"));
    await expect(fast.readBatch!(dir, [{ ...entries[0]!, path: "link", byteSize: 6 }])).rejects.toThrow("symlink_not_allowed");
    execute.mockClear();
    await expect(fast.readBatch!(dir, [{ ...entries[0]!, byteSize: 1024 * 1024 + 1 }])).rejects.toThrow("byte limit");
    await expect(fast.readBatch!(dir, Array.from({ length: 65 }, () => entries[0]!))).rejects.toThrow("entry limit");
    expect(execute).not.toHaveBeenCalled();
    expect(transport.readBatch).toBeUndefined();
  });
  it("persists publication intent before dispatch and aborts if that persistence fails", async () => {
    const execute = vi.fn();
    const fast = workFolderTransport({ execute, supportsSingleStreamStdinProgress: true });
    const entry = { path: "file", kind: "file" as const, byteSize: 3,
      sha256: createHash("sha256").update("new").digest("hex"), executable: false };
    const beforePublish = vi.fn(async (entries) => {
      expect(entries).toEqual([entry]);
      expect(execute).not.toHaveBeenCalled();
      throw new Error("provenance unavailable");
    });
    const body = Readable.from(["new"]);
    await expect(fast.writeMany("/task", "/staging", (async function* () { yield { entry, body }; })(), beforePublish))
      .rejects.toThrow("provenance unavailable");
    expect(beforePublish).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(body.destroyed).toBe(true);
  });
  it("keeps previous files on bad hashes and never follows a symlink during bulk publication", async () => {
    const dir = await root(), staging = await root(), outside = await root();
    const fast = workFolderTransport({ ...localTestWorkFolderRunner, supportsSingleStreamStdinProgress: true });
    await writeFile(path.join(dir, "existing"), "old");
    const entry = { path: "existing", kind: "file" as const, byteSize: 3,
      sha256: createHash("sha256").update("different").digest("hex"), executable: false };
    await expect(fast.write(dir, staging, entry, Readable.from(["new"]))).rejects.toThrow("content_changed_during_transfer");
    expect(await readFile(path.join(dir, "existing"), "utf8")).toBe("old");
    await writeFile(path.join(outside, "private"), "secret");
    await symlink(outside, path.join(dir, "escape"));
    const body = Readable.from(["new"]);
    await expect(fast.write(dir, staging, { ...entry, path: "escape/private",
      sha256: createHash("sha256").update("new").digest("hex") }, body)).rejects.toThrow("symlink_not_allowed");
    expect(await readFile(path.join(outside, "private"), "utf8")).toBe("secret");
    expect(body.destroyed).toBe(true);
    const invalid = Readable.from(["new"]);
    await expect(fast.write(dir, staging, { ...entry, path: "../private" }, invalid)).rejects.toThrow();
    expect(invalid.destroyed).toBe(true);
  });
  it("does not replay a lost batch without a verified missing receipt or publish an incomplete source", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const fast = workFolderTransport({ execute, supportsSingleStreamStdinProgress: true });
    const entry = { path: "file", kind: "file" as const, byteSize: 3,
      sha256: createHash("sha256").update("new").digest("hex"), executable: false };
    await expect(fast.write("/task", "/staging", entry, Readable.from(["new"]))).rejects.toThrow("socket hang up");
    const operations = execute.mock.calls.map(([input]) => JSON.parse(Buffer.from(input.args!.at(-1)!, "base64").toString()).operation);
    expect(operations).toEqual(["batch", "batch-status", "batch-status", "batch-status"]);
    execute.mockClear();
    await expect(fast.write("/task", "/staging", entry, Readable.from(["n"]))).rejects.toThrow("size changed");
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects links out of a work folder on scan and download", async () => {
    const dir = await root();
    const outside = await root();
    await writeFile(path.join(outside, "credential"), "private");
    await symlink(path.join(outside, "credential"), path.join(dir, "link"));
    await expect(transport.scan(dir)).rejects.toThrow("symlink_not_allowed");
    const stream = transport.read(dir, "link", 7);
    await expect((async () => { for await (const _chunk of stream) { /* consume */ } })()).rejects.toThrow("symlink_not_allowed");
  });
  it("includes uncommitted tracked and nonignored files plus Git state, excluding credentials and caches", async () => {
    const dir = await root();
    await exec("git", ["init", dir]);
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
    await writeFile(path.join(dir, "tracked"), "initial");
    await exec("git", ["-C", dir, "add", "."]);
    await exec("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
    await writeFile(path.join(dir, "tracked"), "unstaged");
    // A tracked path remains durable even when a later ignore rule matches it.
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\ntracked\n");
    await mkdir(path.join(dir, "nested"));
    await writeFile(path.join(dir, "nested/.gitignore"), "cache/\n*.generated\n");
    await mkdir(path.join(dir, "nested/cache"));
    await writeFile(path.join(dir, "nested/cache/dependency"), "local cache");
    await writeFile(path.join(dir, "nested/result.generated"), "generated");
    await writeFile(path.join(dir, "nested/keep"), "new durable work");
    await writeFile(path.join(dir, ".git/info/exclude"), "local-only\n");
    await writeFile(path.join(dir, "local-only"), "local secret cache");
    await writeFile(path.join(dir, "untracked"), "new");
    await mkdir(path.join(dir, "node_modules"));
    await writeFile(path.join(dir, "node_modules/cache"), "ignored");
    const paths = (await transport.scan(dir, true)).map((entry) => entry.path);
    expect(paths).toContain("tracked");
    expect(paths).toContain("untracked");
    expect(paths).toContain("nested/keep");
    expect(paths).toContain("nested/.gitignore");
    expect(paths).toContain(".git/info/exclude");
    expect(paths).not.toContain("local-only");
    expect(paths).not.toContain("nested/result.generated");
    expect(paths.some((entry) => entry.startsWith("nested/cache/"))).toBe(false);
    expect(paths).toContain(".git/index");
    expect(paths).toContain(".git/HEAD");
    expect(paths).not.toContain(".git/config");
    expect(paths.some((entry) => entry.startsWith("node_modules/"))).toBe(false);
  });
  it("excludes nested Git repositories in private runner state before validating their trailing slash", async () => {
    const dir = await root();
    await exec("git", ["init", dir]);
    const privateRepo = path.join(dir, ".paperclip-runtime/session/codex-home/.tmp/plugins");
    await mkdir(privateRepo, { recursive: true });
    await exec("git", ["init", privateRepo]);
    await writeFile(path.join(privateRepo, "private-config"), "not durable");
    await writeFile(path.join(dir, "keep.txt"), "durable work");
    const listed = await exec("git", ["-C", dir, "ls-files", "--others", "--exclude-standard", "-z"]);
    expect(listed.stdout).toContain(".paperclip-runtime/session/codex-home/.tmp/plugins/\0");
    const paths = (await transport.scan(dir, true)).map((entry) => entry.path);
    expect(paths).toContain("keep.txt");
    expect(paths.some((entry) => entry.includes(".paperclip-runtime"))).toBe(false);
  });
});
