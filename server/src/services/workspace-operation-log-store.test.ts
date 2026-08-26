import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLocalFileWorkspaceOperationLogStore } from "./workspace-operation-log-store.js";

describe("local-file workspace operation log store", () => {
  let basePath = "";

  beforeEach(async () => {
    basePath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-wsop-log-store-"));
  });

  afterEach(async () => {
    await fs.rm(basePath, { recursive: true, force: true });
  });

  it("begin touches nothing on disk — no per-operation file, no per-company dir", async () => {
    const store = createLocalFileWorkspaceOperationLogStore(basePath);
    const handle = await store.begin({ companyId: "company-a", operationId: "op-1" });

    expect(handle).toEqual({ store: "local_file", logRef: path.join("company-a", "op-1.ndjson") });
    await expect(fs.readdir(basePath)).resolves.toEqual([]);
  });

  it("a never-appended log finalizes as zero bytes and reads as empty", async () => {
    const store = createLocalFileWorkspaceOperationLogStore(basePath);
    const handle = await store.begin({ companyId: "company-a", operationId: "op-1" });

    await expect(store.finalize(handle)).resolves.toEqual({ bytes: 0, compressed: false });
    await expect(store.read(handle)).resolves.toEqual({ content: "" });
    await expect(fs.readdir(basePath)).resolves.toEqual([]);
  });

  it("first append creates the company dir and file; the round trip is unchanged", async () => {
    const store = createLocalFileWorkspaceOperationLogStore(basePath);
    const handle = await store.begin({ companyId: "company-a", operationId: "op-1" });

    await store.append(handle, { stream: "stdout", chunk: "hello", ts: "2026-08-26T18:00:00.000Z" });
    await store.append(handle, { stream: "stderr", chunk: "warn", ts: "2026-08-26T18:00:01.000Z" });

    const raw = await fs.readFile(path.resolve(basePath, handle.logRef), "utf8");
    const lines = raw.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { ts: "2026-08-26T18:00:00.000Z", stream: "stdout", chunk: "hello" },
      { ts: "2026-08-26T18:00:01.000Z", stream: "stderr", chunk: "warn" },
    ]);

    const finalized = await store.finalize(handle);
    expect(finalized.bytes).toBe(Buffer.byteLength(raw));
    expect(finalized.sha256).toMatch(/^[0-9a-f]{64}$/);

    const read = await store.read(handle);
    expect(read.content).toBe(raw);
    expect(read.nextOffset).toBeUndefined();
  });

  it("append still works when the log file was pruned out from under the handle", async () => {
    const store = createLocalFileWorkspaceOperationLogStore(basePath);
    const handle = await store.begin({ companyId: "company-a", operationId: "op-1" });

    await store.append(handle, { stream: "stdout", chunk: "before", ts: "2026-08-26T18:00:00.000Z" });
    await fs.rm(path.resolve(basePath, "company-a"), { recursive: true, force: true });
    await store.append(handle, { stream: "system", chunk: "after prune", ts: "2026-08-26T18:05:00.000Z" });

    const read = await store.read(handle);
    expect(read.content).toContain("after prune");
  });

  it("rejects path traversal in identifiers at begin time", async () => {
    const store = createLocalFileWorkspaceOperationLogStore(basePath);
    const handle = await store.begin({ companyId: "../escape", operationId: "../../op" });
    // Traversal characters are sanitized, so the ref stays inside the base path.
    expect(path.resolve(basePath, handle.logRef).startsWith(path.resolve(basePath) + path.sep)).toBe(true);
  });
});
