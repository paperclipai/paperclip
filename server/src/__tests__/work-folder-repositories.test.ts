import { runWithSandboxPerformanceTrace, type SandboxPerformanceRecord } from "../services/sandbox-performance.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localTestWorkFolderRunner } from "./helpers/work-folder-runner.js";
import { workFolderTransport } from "../services/work-folder-transport.js";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, issues, startEmbeddedPostgresTestDatabase,
  taskRepositoryBindings, workFolderObjects, type Db } from "@paperclipai/db";
import * as garbage from "../services/work-folder-garbage.js";
import { workFolderRepositoryService } from "../services/work-folder-repositories.js";
import type { WorkFolderTransport, WorkTreeEntry } from "../services/work-folder-transport.js";
import type { PutObjectInput, StorageProvider } from "../storage/types.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("bounded repository checkpoint transfers", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const companyId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-repository-pool-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Checkpoint pool" });
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(batched = false) {
    const taskId = randomUUID();
    await db.insert(issues).values({ id: taskId, companyId, title: "Checkpoint" });
    const [binding] = await db.insert(taskRepositoryBindings).values({ companyId, taskId,
      workspaceId: randomUUID(), name: "repository" }).returning();
    const contents = new Map<string, Buffer>();
    const objects = new Map<string, Buffer>();
    const sources: Readable[] = [];
    let entries: WorkTreeEntry[] = [];
    const scan = vi.fn(async () => entries);
    const transport: WorkFolderTransport = {
      home: async () => "/home/runner", scan,
      readBatch: batched ? vi.fn(async (_root, entries) => entries.map((entry) => contents.get(entry.path)!)) : undefined,
      read: vi.fn((_root, filePath) => {
        const source = Readable.from([contents.get(filePath)!]);
        sources.push(source);
        return source;
      }),
      write: vi.fn(async () => {}),
      writeMany: vi.fn(async (_root, _stagingRoot, transfers) => {
        for await (const { body } of transfers) {
          if (body) for await (const chunk of body) { void chunk; }
        }
      }),
      moveRoot: vi.fn(async () => {}),
      symlink: vi.fn(async () => {}), mkdirRoot: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    };
    const putObject = vi.fn(async (input: PutObjectInput) => {
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(input.body)) chunks.push(input.body);
      else for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      objects.set(input.objectKey, Buffer.concat(chunks));
    });
    const headObject = vi.fn(async ({ objectKey }: { objectKey: string }) => ({ exists: objects.has(objectKey) }));
    const storage: StorageProvider = {
      id: "local_disk", putObject, headObject,
      getObject: async ({ objectKey }) => ({ stream: Readable.from([objects.get(objectKey)!]) }),
      deleteObject: async ({ objectKey }) => { objects.delete(objectKey); },
    };
    function file(filePath: string, text = filePath): WorkTreeEntry {
      const bytes = Buffer.from(text);
      contents.set(filePath, bytes);
      return { path: filePath, kind: "file", byteSize: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), executable: false };
    }
    const service = workFolderRepositoryService(db, storage, transport);
    return { binding: binding!, file, objects, sources, scan, transport, storage, putObject, headObject,
      setEntries: (next: WorkTreeEntry[]) => { entries = next; },
      save: () => service.checkpoint(binding!, "/repository"),
      current: async () => (await db.select().from(taskRepositoryBindings).where(eq(taskRepositoryBindings.id, binding!.id)))[0]!,
    };
  }

  it("checkpoints Git ignore policy without uploading or removing local ignored dependencies", async () => {
    const f = await fixture();
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "repository-ignore-")));
    const root = path.join(base, "source"), restored = path.join(base, "restored"), staging = path.join(base, "staging");
    const git = promisify(execFile);
    try {
      await git("git", ["init", root]);
      await writeFile(path.join(root, "tracked"), "tracked original");
      await git("git", ["-C", root, "add", "tracked"]);
      await git("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
      await writeFile(path.join(root, ".gitignore"), "node_modules/\ntracked\n");
      await mkdir(path.join(root, "nested/cache"), { recursive: true });
      await mkdir(path.join(root, "node_modules"));
      await writeFile(path.join(root, "nested/.gitignore"), "cache/\n");
      await writeFile(path.join(root, ".git/info/exclude"), "local-only\n");
      const ignored = ["node_modules/dependency", "nested/cache/dependency", "local-only"];
      for (const file of ignored) await writeFile(path.join(root, file), `ignored:${file}`);
      await writeFile(path.join(root, "tracked"), "tracked changed");
      await writeFile(path.join(root, "nested/keep"), "untracked work");
      const actual = workFolderTransport({ ...localTestWorkFolderRunner, supportsSingleStreamStdinProgress: true });
      const service = workFolderRepositoryService(db, f.storage, actual);
      const records: SandboxPerformanceRecord[] = [];
      const trace = { runId: "repository-ignore", enabled: true, onBatch: async (batch: { records: SandboxPerformanceRecord[] }) => { records.push(...batch.records); } };
      await runWithSandboxPerformanceTrace(trace, () => service.checkpoint(f.binding, root));
      const current = await f.current();
      const manifest = JSON.parse(f.objects.get(current.checkpointKey!)!.toString());
      const durablePaths = manifest.files.map((entry: { path: string }) => entry.path);
      expect(durablePaths).toContain("tracked");
      expect(durablePaths).toContain("nested/keep");
      expect(durablePaths).toContain(".git/info/exclude");
      for (const file of ignored) {
        expect(durablePaths).not.toContain(file);
        expect(await readFile(path.join(root, file), "utf8")).toBe(`ignored:${file}`);
        expect([...f.objects.values()].some((body) => body.toString() === `ignored:${file}`)).toBe(false);
      }
      await mkdir(staging);
      await runWithSandboxPerformanceTrace(trace, () => service.restore(current, restored, staging));
      for (const phase of ["lookup", "object_intent", "object_head", "object_upload", "manifest_upload", "publish_lock", "protect_objects", "publish_pointer", "manifest_download", "manifest_body", "manifest_decode", "object_download"]) {
        expect(records.some((record) => record.name === `work_folder.repository.${phase}`)).toBe(true);
      }
      for (const secret of [root, restored, f.binding.id, companyId, "tracked changed"]) expect(JSON.stringify(records)).not.toContain(secret);
      expect(await readFile(path.join(restored, "tracked"), "utf8")).toBe("tracked changed");
      expect(await readFile(path.join(restored, "nested/keep"), "utf8")).toBe("untracked work");
      for (const file of ignored) await expect(readFile(path.join(restored, file))).rejects.toMatchObject({ code: "ENOENT" });
      // Restoring into the existing workspace must preserve reusable ignored caches.
      await service.restore(current, root, staging);
      for (const file of ignored) expect(await readFile(path.join(root, file), "utf8")).toBe(`ignored:${file}`);
      const listed = await git("git", ["-C", restored, "ls-files", "--cached", "--others", "--exclude-standard"]);
      expect(listed.stdout).toContain("tracked");
    } finally { await rm(base, { recursive: true, force: true }); }
  }, 60_000);
  it("bounds HEADs and streaming PUTs to four, deduplicates content, and preserves manifest order", async () => {
    const f = await fixture();
    const entries = [f.file("z"), f.file("b"), f.file("same-z", "z"),
      f.file("c"), f.file("a"), f.file("fifth"), f.file("empty", "")];
    entries[2]!.executable = true;
    f.setEntries(entries);
    const registered = vi.spyOn(garbage, "registerWorkFolderObject");
    const heads = gate(), puts = gate();
    let activeHeads = 0, maximumHeads = 0, activePuts = 0, maximumPuts = 0;
    f.headObject.mockImplementation(async () => {
      activeHeads++;
      maximumHeads = Math.max(maximumHeads, activeHeads);
      try { await heads.promise; return { exists: false }; } finally { activeHeads--; }
    });
    const put = f.putObject.getMockImplementation()!;
    f.putObject.mockImplementation(async (input) => {
      if (!input.objectKey.includes("/blobs/")) return put(input);
      activePuts++;
      maximumPuts = Math.max(maximumPuts, activePuts);
      try { await puts.promise; await put(input); } finally { activePuts--; }
    });
    const saving = f.save();
    try {
      await vi.waitFor(() => expect(activeHeads).toBe(4));
      expect(f.headObject).toHaveBeenCalledTimes(4);
      expect(registered).toHaveBeenCalledTimes(4);
      heads.release();
      await vi.waitFor(() => expect(activePuts).toBe(4));
      expect(f.headObject).toHaveBeenCalledTimes(4);
      expect(registered).toHaveBeenCalledTimes(4);
      expect((await f.current()).checkpointKey).toBeNull();
    } finally { heads.release(); puts.release(); }
    await saving;
    expect(maximumHeads).toBe(4);
    expect(maximumPuts).toBe(4);
    expect(f.headObject).toHaveBeenCalledTimes(6);
    const blobPuts = f.putObject.mock.calls.filter(([input]) => input.objectKey.includes("/blobs/"));
    expect(blobPuts).toHaveLength(6);
    expect(new Set(blobPuts.map(([input]) => input.objectKey)).size).toBe(6);
    expect(registered.mock.calls.filter(([, , input]) => input.objectKey.includes("/blobs/"))).toHaveLength(6);
    const manifest = JSON.parse(f.objects.get(f.binding.checkpointKey!)!.toString("utf8"));
    expect(manifest.files.map(({ objectKey: _key, ...entry }: WorkTreeEntry & { objectKey: string }) => entry)).toEqual(entries);
    expect(manifest.files[0].objectKey).toBe(manifest.files[2].objectKey);
    expect(f.sources.every((source) => source.destroyed)).toBe(true);
  });

  it("overlaps sixteen batch-readable blobs while keeping large streams bounded to four", async () => {
    const f = await fixture(true);
    const entries = Array.from({ length: 24 }, (_, i) => f.file(`small-${i}`));
    entries.splice(1, 0, ...Array.from({ length: 6 }, (_, i) => f.file(`large-${i}`, `${i}`.repeat(1024 * 1024 + 1))));
    const largeKeys = new Set(entries.filter((entry) => entry.byteSize > 1024 * 1024).map((entry) => entry.sha256));
    f.setEntries(entries);
    const headGate = gate(), putGate = gate();
    const activeHeads = [0, 0], activePuts = [0, 0], maxHeads = [0, 0], maxPuts = [0, 0];
    const lane = (key: string) => largeKeys.has(key.split("/").at(-1)!) ? 1 : 0;
    f.headObject.mockImplementation(async ({ objectKey }) => {
      const index = lane(objectKey);
      activeHeads[index]!++;
      maxHeads[index] = Math.max(maxHeads[index]!, activeHeads[index]!);
      try { await headGate.promise; return { exists: false }; } finally { activeHeads[index]!--; }
    });
    const put = f.putObject.getMockImplementation()!;
    f.putObject.mockImplementation(async (input) => {
      if (!input.objectKey.includes("/blobs/")) return put(input);
      const index = lane(input.objectKey);
      activePuts[index]!++;
      maxPuts[index] = Math.max(maxPuts[index]!, activePuts[index]!);
      try { await putGate.promise; await put(input); } finally { activePuts[index]!--; }
    });
    const saving = f.save();
    try {
      await vi.waitFor(() => expect(activeHeads).toEqual([16, 4]));
      expect(f.headObject).toHaveBeenCalledTimes(20);
      headGate.release();
      await vi.waitFor(() => expect(activePuts).toEqual([16, 4]));
      expect(f.headObject).toHaveBeenCalledTimes(20);
      expect((await f.current()).checkpointKey).toBeNull();
    } finally { headGate.release(); putGate.release(); }
    await saving;
    expect(maxHeads).toEqual([16, 4]);
    expect(maxPuts).toEqual([16, 4]);
    expect(f.headObject).toHaveBeenCalledTimes(30);
    const manifest = JSON.parse(f.objects.get(f.binding.checkpointKey!)!.toString("utf8"));
    expect(manifest.files.map(({ objectKey: _key, ...entry }: WorkTreeEntry & { objectKey: string }) => entry)).toEqual(entries);
    expect(f.transport.read).toHaveBeenCalledTimes(6);
    expect(f.sources.every((source) => source.destroyed)).toBe(true);
    for (const [, group] of vi.mocked(f.transport.readBatch!).mock.calls) {
      expect(group.reduce((size, entry) => size + entry.byteSize, 0)).toBeLessThanOrEqual(1024 * 1024);
      expect(group).toHaveLength(24);
    }
  });

  it.each([false, true])("drains in-flight PUTs after failure without replacing the checkpoint (batched=%s)", async (batched) => {
    const f = await fixture(batched);
    const parallelism = batched ? 16 : 4;
    const original = f.file("saved");
    f.setEntries([original]);
    await f.save();
    const previous = await f.current();
    const failed = f.file("fail"), queued = f.file("must-not-start");
    f.setEntries([original, failed, ...Array.from({ length: parallelism - 1 }, (_, i) => f.file(`held-${i}`)), queued]);
    const failedKey = `${companyId}/task-repositories/${f.binding.id}/blobs/${failed.sha256}`;
    const queuedKey = `${companyId}/task-repositories/${f.binding.id}/blobs/${queued.sha256}`;
    const fail = gate(), held = gate();
    const error = new Error("Injected permanent PUT failure");
    const put = f.putObject.getMockImplementation()!;
    let active = 0, settled = false;
    f.putObject.mockClear();
    f.headObject.mockClear();
    f.scan.mockClear();
    f.putObject.mockImplementation(async (input) => {
      active++;
      try {
        if (input.objectKey === failedKey) { await fail.promise; throw error; }
        await held.promise;
        await put(input);
      } finally { active--; }
    });
    const outcome = f.save().then(() => ({ error: null }), (failure: unknown) => ({ error: failure }))
      .finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(active).toBe(parallelism));
      fail.release();
      await vi.waitFor(() => expect(active).toBe(parallelism - 1));
      await setImmediate();
      expect(settled).toBe(false);
      expect((await f.current()).checkpointKey).toBe(previous.checkpointKey);
      expect(f.headObject.mock.calls.some(([input]) => input.objectKey === queuedKey)).toBe(false);
      expect(f.putObject.mock.calls.some(([input]) => input.objectKey.includes("/checkpoints/"))).toBe(false);
    } finally { fail.release(); held.release(); }
    expect((await outcome).error).toBe(error);
    expect(active).toBe(0);
    expect(f.sources.every((source) => source.destroyed)).toBe(true);
    expect(f.scan).toHaveBeenCalledTimes(1);
    expect((await f.current()).checkpointKey).toBe(previous.checkpointKey);
    const tracked = await db.select().from(workFolderObjects).where(eq(workFolderObjects.repositoryBindingId, f.binding.id));
    expect(tracked.find((object) => object.objectKey === previous.checkpointKey)!.deleteAfter).toBeNull();
    expect(tracked.find((object) => object.objectKey.endsWith(`/blobs/${original.sha256}`))!.deleteAfter).toBeNull();
    expect(tracked.filter((object) => object.deleteAfter !== null)).toHaveLength(parallelism);
  });

  it.each([false, true])("drains failed concurrent HEADs without opening streams (batched=%s)", async (batched) => {
    const f = await fixture(batched);
    const parallelism = batched ? 16 : 4;
    const first = f.file("fail-head");
    f.setEntries([first, ...Array.from({ length: parallelism - 1 }, (_, i) => f.file(`held-${i}`)), f.file("queued")]);
    const fail = gate(), held = gate();
    const error = new Error("HEAD unavailable");
    let active = 0, settled = false;
    f.headObject.mockImplementation(async ({ objectKey }) => {
      active++;
      try {
        if (objectKey.endsWith(`/blobs/${first.sha256}`)) { await fail.promise; throw error; }
        await held.promise;
        return { exists: false };
      } finally { active--; }
    });
    const outcome = f.save().then(() => ({ error: null }), (failure: unknown) => ({ error: failure }))
      .finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(active).toBe(parallelism));
      fail.release();
      await vi.waitFor(() => expect(active).toBe(parallelism - 1));
      await setImmediate();
      expect(settled).toBe(false);
      expect(f.sources).toHaveLength(0);
    } finally { fail.release(); held.release(); }
    expect((await outcome).error).toBe(error);
    expect(active).toBe(0);
    expect(f.headObject).toHaveBeenCalledTimes(parallelism);
    expect(f.sources).toHaveLength(0);
    expect(f.putObject).not.toHaveBeenCalled();
    expect((await f.current()).checkpointKey).toBeNull();
  });

  it("rejects a changed second scan even after every concurrent blob transfer succeeds", async () => {
    const f = await fixture();
    const entries = [f.file("one"), f.file("two"), f.file("three"), f.file("four"), f.file("five")];
    f.scan.mockResolvedValueOnce(entries).mockResolvedValueOnce([...entries, f.file("changed")]);
    await expect(f.save()).rejects.toThrow("Repository changed during checkpoint");
    expect(f.putObject).toHaveBeenCalledTimes(5);
    expect(f.putObject.mock.calls.every(([input]) => input.objectKey.includes("/blobs/"))).toBe(true);
    expect((await f.current()).checkpointKey).toBeNull();
    expect(f.sources.every((source) => source.destroyed)).toBe(true);
  });
});
