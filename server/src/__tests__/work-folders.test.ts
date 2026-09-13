import { runWithSandboxPerformanceTrace, type SandboxPerformanceRecord } from "../services/sandbox-performance.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { agents, workFolderObjects, workFolders, companies, createDb, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { validateWorkFilePath } from "@paperclipai/shared";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { collectWorkFolderGarbage } from "../services/work-folder-garbage.js";
import { workFolderService } from "../services/work-folders.js";
import { assertWorkFolderAccess } from "../services/work-folder-access.js";

describe("durable work folders", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let root: string;
  let storage: ReturnType<typeof createLocalDiskStorageProvider>;
  let svc: ReturnType<typeof workFolderService>;
  const companyId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-work-folders-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Work folders test" });
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-work-folders-"));
    storage = createLocalDiskStorageProvider(root);
    svc = workFolderService(db, storage);
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });
  const folder = async () => {
    const ownerId = randomUUID();
    await db.insert(agents).values({ id: ownerId, companyId, name: "File owner" });
    return svc.ensure({ companyId, scope: "agent", ownerId });
  };
  async function textContent(f: Awaited<ReturnType<typeof folder>>, filePath: string) {
    const { stream } = await svc.content(f, filePath);
    const buffers: Buffer[] = [];
    for await (const chunk of stream) buffers.push(Buffer.from(chunk));
    return Buffer.concat(buffers).toString();
  }
  it("measures metadata, response wait, body bytes and progress without private paths", async () => {
    const records: SandboxPerformanceRecord[] = [];
    await runWithSandboxPerformanceTrace({ runId: randomUUID(), enabled: true,
      onBatch: async (batch) => { records.push(...batch.records); } }, async () => {
      const f = await folder();
      await svc.write(f, { path: "private-observed-file", body: Buffer.from("private-observed-content"), operationId: "private-operation-id" });
      const opened = await svc.content(f, "private-observed-file", 7);
      let text = ""; for await (const chunk of opened.stream) text += String(chunk);
      expect(text).toBe("private-observed-content");
      await svc.list(f);
    });
    const names = records.map((record) => record.name);
    for (const name of ["work_folder.scope.ensure", "work_folder.metadata.get", "work_folder.object.get_response", "work_folder.object.body", "work_folder.spool.consume", "work_folder.metadata.mutate", "work_folder.db.query"]) expect(names).toContain(name);
    const response = records.find((record) => record.name === "work_folder.object.get_response")!;
    const body = records.find((record) => record.name === "work_folder.object.body")!;
    expect(response.attributes.requestCount).toBe(1);
    expect(body.attributes.bytes).toBe(Buffer.byteLength("private-observed-content"));
    expect(body.attributes.fileIndex).toBe(7);
    expect(response.attributes.fileIndex).toBe(7);
    expect(body.startedAtMs).toBeGreaterThanOrEqual(response.startedAtMs);
    expect(records.filter((record) => record.name === "work_folder.db.query").every((record) => typeof record.attributes.operation === "string")).toBe(true);
    for (const secret of [companyId, root, "private-observed-file", "private-observed-content", "private-operation-id"]) expect(JSON.stringify(records)).not.toContain(secret);
  });
  it("streams nested executable and empty files into durable storage", async () => {
    const f = await folder();
    await svc.write(f, { path: "bin/run", body: Readable.from(["#!/bin/sh\n", "true\n"]), executable: true, operationId: "first" });
    await svc.write(f, { path: "empty", body: Buffer.alloc(0), operationId: "empty" });
    expect(await textContent(f, "bin/run")).toBe("#!/bin/sh\ntrue\n");
    expect(await textContent(f, "empty")).toBe("");
    expect((await svc.get(f, "bin/run")).executable).toBe(true);
    expect((await svc.get(f, "bin")).kind).toBe("directory");
  });
  it("does not replay an older accepted write over newer content", async () => {
    const f = await folder();
    const first = { path: "memory.md", body: Buffer.from("first"), operationId: "first" };
    await svc.write(f, first);
    await svc.write(f, { ...first, body: Buffer.from("second"), operationId: "second" });
    expect(await svc.write(f, first)).toEqual({ applied: false });
    expect(await textContent(f, "memory.md")).toBe("second");
    await expect(svc.write(f, { ...first, body: Buffer.from("different") })).rejects.toMatchObject({ status: 409 });
  });
  it("retains the last accepted operation time after all files are removed", async () => {
    const f = await folder();
    expect((await svc.list(f)).lastOperationAt).toBeNull();
    await svc.write(f, { path: "note", body: Buffer.from("saved"), operationId: "write" });
    const saved = (await svc.list(f)).lastOperationAt;
    expect(saved).toEqual(expect.any(String));
    await svc.remove(f, "note", "delete");
    const listing = await svc.list(f);
    expect(listing.files).toEqual([]);
    expect(Date.parse(listing.lastOperationAt!)).toBeGreaterThanOrEqual(Date.parse(saved!));
    expect((await svc.list(f, { trash: true })).lastOperationAt).toBe(listing.lastOperationAt);
  });
  it("retains a deleted copy after the same path is recreated", async () => {
    const f = await folder();
    await svc.write(f, { path: "note", body: Buffer.from("deleted"), operationId: "one" });
    await svc.remove(f, "note", "delete");
    const [trashed] = (await svc.list(f, { trash: true })).files;
    await svc.write(f, { path: "note", body: Buffer.from("replacement"), operationId: "two" });
    await expect(svc.restore(f, trashed!.id, "restore")).rejects.toMatchObject({ status: 409 });
    await svc.remove(f, "note", "delete-replacement");
    await svc.restore(f, trashed!.id, "restore");
    expect(await textContent(f, "note")).toBe("deleted");
    expect((await svc.list(f, { trash: true })).files).toHaveLength(1);
  });
  it("restores a deleted directory as one recoverable subtree", async () => {
    const f = await folder();
    await svc.write(f, { path: "notes/nested/one", body: Buffer.from("one"), operationId: "seed" });
    await svc.remove(f, "notes", "remove-subtree");
    const trash = (await svc.list(f, { trash: true })).files;
    await svc.restore(f, trash.find((file) => file.path === "notes")!.id, "restore-subtree");
    expect(await textContent(f, "notes/nested/one")).toBe("one");
    expect((await svc.list(f, { trash: true })).files).toHaveLength(0);
  });
  it("does not publish interrupted or oversized uploads", async () => {
    const f = await folder();
    const body = Readable.from((async function* () { yield Buffer.from("partial"); throw new Error("Disconnected"); })());
    await expect(svc.write(f, { path: "partial", body, operationId: "partial" })).rejects.toThrow("Disconnected");
    await expect(svc.write(f, { path: "large", body: Buffer.from("large"), maxBytes: 2, operationId: "large" })).rejects.toMatchObject({ status: 413 });
    expect((await svc.list(f)).files).toHaveLength(0);
  });
  it("replays a failed spool upload without publishing a receipt or replacing the previous file", async () => {
    const f = await folder();
    await svc.write(f, { path: "note", body: Buffer.from("old"), operationId: "old" });
    const old = await svc.get(f, "note");
    const put = storage.putObject.bind(storage);
    const bodies: Readable[] = [];
    const failed = vi.spyOn(storage, "putObject").mockImplementation(async (input) => {
      bodies.push(input.body as Readable);
      for await (const _chunk of input.body as Readable) { /* Consume the uncertain request. */ }
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    try {
      await expect(svc.write(f, { path: "note", body: Buffer.from("new"), operationId: "new" })).rejects.toThrow("socket hang up");
      expect(failed).toHaveBeenCalledTimes(3);
      expect(new Set(bodies).size).toBe(3);
      expect(bodies.every((body) => body.destroyed)).toBe(true);
      expect((await svc.get(f, "note")).objectKey).toBe(old.objectKey);
      expect(await textContent(f, "note")).toBe("old");
    } finally { failed.mockRestore(); }
    let attempts = 0;
    const recovered = vi.spyOn(storage, "putObject").mockImplementation(async (input) => {
      await put(input);
      if (++attempts === 1) throw Object.assign(new Error("lost response"), { code: "ECONNRESET" });
    });
    try {
      expect(await svc.write(f, { path: "note", body: Buffer.from("new"), operationId: "new" })).toEqual({ applied: true });
      expect(recovered).toHaveBeenCalledTimes(2);
      expect(await textContent(f, "note")).toBe("new");
    } finally { recovered.mockRestore(); }
  });
  it("serializes conflicting parent/file creation", async () => {
    const f = await folder();
    const results = await Promise.allSettled([
      svc.write(f, { path: "parent", body: Buffer.from("file"), operationId: "parent" }),
      svc.write(f, { path: "parent/child", body: Buffer.from("child"), operationId: "child" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("collects overwrites and purged trash but keeps recoverable deleted content", async () => {
    const f = await folder();
    await svc.write(f, { path: "note", body: Buffer.from("old"), operationId: "old" });
    const old = await svc.get(f, "note");
    await svc.write(f, { path: "note", body: Buffer.from("new"), operationId: "new" });
    const current = await svc.get(f, "note");
    await svc.remove(f, "note", "trash");
    await collectWorkFolderGarbage(db, storage);
    expect((await storage.headObject({ objectKey: old.objectKey! })).exists).toBe(false);
    expect((await storage.headObject({ objectKey: current.objectKey! })).exists).toBe(true);
    await svc.purge(f, current.id, "purge");
    await collectWorkFolderGarbage(db, storage);
    expect((await storage.headObject({ objectKey: current.objectKey! })).exists).toBe(false);
    expect((await svc.list(f, { trash: true })).files).toHaveLength(0);
  });
  it("removes scoped files after permanent owner deletion", async () => {
    const f = await folder();
    await svc.write(f, { path: "note", body: Buffer.from("private"), operationId: "private" });
    const file = await svc.get(f, "note");
    await db.delete(agents).where(eq(agents.id, f.ownerId));
    await collectWorkFolderGarbage(db, storage);
    expect(await db.select().from(workFolders).where(eq(workFolders.id, f.id))).toHaveLength(0);
    expect((await storage.headObject({ objectKey: file.objectKey! })).exists).toBe(false);
    expect(await db.select().from(workFolderObjects).where(and(eq(workFolderObjects.folderId, f.id), eq(workFolderObjects.companyId, companyId)))).toHaveLength(0);
  });
  it("hard-denies private user files to another user or an unbound agent", async () => {
    const owner = { companyId, scope: "user" as const, ownerId: "owner" };
    await expect(assertWorkFolderAccess(db, { type: "board", source: "local_implicit", userId: "another" }, owner, false)).rejects.toMatchObject({ status: 404 });
    await expect(assertWorkFolderAccess(db, { type: "agent", source: "agent_key", companyId, agentId: randomUUID() }, owner, false)).rejects.toMatchObject({ status: 404 });
    await expect(assertWorkFolderAccess(db, { type: "board", source: "local_implicit", userId: "owner" }, owner, true)).resolves.toBeUndefined();
  });
  it.each(["../secret", "/absolute", "a/../../x", "a//b", "a\\b", "a\u0000b", ".paperclip-runtime/secret"])("rejects unsafe path %j", (filePath) => {
    expect(() => validateWorkFilePath(filePath)).toThrow();
  });
});
