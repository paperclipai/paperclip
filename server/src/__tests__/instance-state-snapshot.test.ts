import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { StateClassEntry } from "@paperclipai/shared";
import type { StorageProvider } from "../storage/types.js";
import { createAesStateSnapshotEncryptionProvider, createInstanceStateSnapshotService } from "../services/instance-state-snapshot.js";

const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe("instance state snapshots", () => {
  it("encrypts, stores, and restores manifest state", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-state-test-"));
    tempDirs.push(homeDir);
    const source = path.join(homeDir, "instances", "test", "config.json");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "before");
    const objects = new Map<string, Buffer>();
    const provider: StorageProvider = {
      id: "local_disk",
      async putObject(input) {
        if (Buffer.isBuffer(input.body)) objects.set(input.objectKey, input.body);
        else {
          const chunks: Buffer[] = [];
          for await (const chunk of input.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          objects.set(input.objectKey, Buffer.concat(chunks));
        }
      },
      async getObject(input) { const body = objects.get(input.objectKey); if (!body) throw new Error("missing"); return { stream: Readable.from(body), contentLength: body.length }; },
      async headObject(input) { const body = objects.get(input.objectKey); return { exists: Boolean(body), contentLength: body?.length }; },
      async deleteObject(input) { objects.delete(input.objectKey); },
    };
    const manifest: StateClassEntry[] = [{ id: "config", resolve: () => [source], disposition: "s3_secret", redact: "forbid", consistency: "plain" }];
    const service = createInstanceStateSnapshotService({
      storageProvider: provider,
      encryptionProvider: createAesStateSnapshotEncryptionProvider(Buffer.alloc(32, 7)),
      context: { homeDir, instanceId: "test" },
      markerDir: path.join(homeDir, "markers"),
      manifest,
    });

    const result = await service.runSnapshot();
    expect(objects.get(result.objectKey)?.subarray(0, 8).toString()).toBe("PCSTATE1");
    await fs.writeFile(source, "after");
    await service.restoreSnapshot(result.objectKey);
    expect(await fs.readFile(source, "utf8")).toBe("before");
    expect(JSON.parse(await fs.readFile(path.join(homeDir, "markers", "state-snapshot.success.json"), "utf8"))).toMatchObject({ objectKey: result.objectKey });
  });

  it("stores nested transcript glob matches in a retention-specific object", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-retention-test-"));
    tempDirs.push(homeDir);
    const transcript = path.join(homeDir, "claude", "projects", "company", "agent", "session.jsonl");
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(transcript, "transcript");
    const objects = new Map<string, Buffer>();
    const provider: StorageProvider = {
      id: "s3",
      async putObject(input) {
        const chunks: Buffer[] = [];
        if (Buffer.isBuffer(input.body)) chunks.push(input.body);
        else for await (const chunk of input.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        objects.set(input.objectKey, Buffer.concat(chunks));
      },
      async getObject(input) { const body = objects.get(input.objectKey); if (!body) throw new Error("missing"); return { stream: Readable.from(body), contentLength: body.length }; },
      async headObject(input) { const body = objects.get(input.objectKey); return { exists: Boolean(body), contentLength: body?.length }; },
      async deleteObject(input) { objects.delete(input.objectKey); },
    };
    const manifest: StateClassEntry[] = [{ id: "transcripts", resolve: () => [path.join(homeDir, "claude", "projects", "**", "*.jsonl")], disposition: "s3_bulk", redact: "secret_refs", consistency: "plain", retention: { days: 90 } }];
    const service = createInstanceStateSnapshotService({ storageProvider: provider, encryptionProvider: createAesStateSnapshotEncryptionProvider(Buffer.alloc(32, 9)), context: { homeDir, instanceId: "test" }, manifest });

    const result = await service.runSnapshot();

    expect(result.retentionObjects).toHaveLength(1);
    expect(result.retentionObjects[0]).toMatchObject({ retentionDays: 90, entryCount: 1 });
    expect(result.retentionObjects[0]?.objectKey).toContain("retention/90-days/");
    expect(objects.has(result.retentionObjects[0]!.objectKey)).toBe(true);
  });
});
