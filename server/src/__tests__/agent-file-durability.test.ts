import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentFileRoots, authUsers, companies, companyMemberships, principalPermissionGrants, heartbeatRuns, createDb, closeFileStorageDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentFileStore, adoptAgentFiles, fileHash } from "../services/agent-file-store.js";
import { invalidateAgentFileProjection, persistDurableAgentFiles } from "../services/agent-file-durability.js";
import { materializeInstructionBytes } from "../services/agent-instruction-files.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { AGENT_FILE_OBJECT_GRACE_MS, collectAgentFileObjects, migrateAgentFiles } from "../services/agent-file-maintenance.js";
import { getStorageService } from "../storage/index.js";

const objects = vi.hoisted(() => ({ bytes: new Map<string, Buffer>(), rejectWrites: false, corruptReads: false }));
vi.mock("../storage/index.js", () => ({ getStorageService: () => ({
  provider: "s3",
  async putFile(input: { companyId: string; namespace: string; body: Readable; byteSize: number; sha256: string }) {
    if (objects.rejectWrites) throw new Error("fixture object-store outage");
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    expect(body.length).toBe(input.byteSize);
    expect(fileHash(body)).toBe(input.sha256);
    const objectKey = `${input.companyId}/${input.namespace}/${randomUUID()}`;
    objects.bytes.set(objectKey, body);
    return { objectKey };
  },
  async getObject(companyId: string, objectKey: string) {
    expect(objectKey.startsWith(`${companyId}/`)).toBe(true);
    const body = objects.bytes.get(objectKey);
    if (!body) throw new Error("fixture object missing");
    return { stream: Readable.from([objects.corruptReads ? Buffer.from("wrong bytes") : body]) };
  },
  async headObject(_companyId: string, key: string) { return { exists: objects.bytes.has(key), lastModified: new Date(0) }; },
  async deleteObject(companyId: string, key: string, options: { allVersions: boolean }) {
    expect(key.startsWith(`${companyId}/`)).toBe(true);
    expect(options.allVersions).toBe(true);
    objects.bytes.delete(key);
  },
}) }));

describe("durable agent file authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string, root: string, companyId: string, agentId: string, userId: string;
  const actor = () => ({ type: "board" as const, userId, source: "session" as const });
  const store = () => agentFileStore(db);
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("durable-agent-files-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    if (db) { await closeFileStorageDb(db, 1); await db.$client.end({ timeout: 1 }); }
    await database?.cleanup();
  });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "durable-agent-files-")));
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
    objects.bytes.clear(); objects.rejectWrites = false; objects.corruptReads = false;
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "File authority", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId, name: "File owner" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "operator" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
      permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    root = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "File owner", adapterConfig: {} });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });
  async function replaceFilesystem() {
    await fs.rm(home, { recursive: true, force: true });
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "durable-agent-replacement-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    root = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "File owner", adapterConfig: {} });
  }

  it("imports legacy bytes, modes and empty entries, then restores without any old filesystem", async () => {
    const binary = Buffer.alloc(2 * 1024 * 1024, 0x81);
    await materializeInstructionBytes(root, "AGENTS.md", Buffer.from("Original"));
    await materializeInstructionBytes(root, "nested/data.bin", binary);
    await materializeInstructionBytes(root, "empty.txt", Buffer.alloc(0));
    await materializeInstructionBytes(root, "script.sh", Buffer.from("#!/bin/sh\n"));
    await fs.chmod(path.join(root, "script.sh"), 0o755);
    await fs.mkdir(path.join(root, "empty-folder"));
    await db.update(agents).set({ adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root } }).where(eq(agents.id, agentId));
    expect(await store().read(companyId, agentId, "AGENTS.md", actor())).toEqual(Buffer.from("Original"));
    await replaceFilesystem();
    vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "false");
    expect(await store().read(companyId, agentId, "nested/data.bin", actor())).toEqual(binary);
    expect(await store().read(companyId, agentId, "empty.txt", actor())).toEqual(Buffer.alloc(0));
    expect((await fs.stat(path.join(root, "script.sh"))).mode & 0o777).toBe(0o755);
    expect((await fs.stat(path.join(root, "empty-folder"))).isDirectory()).toBe(true);
  });

  it("does not promote a rejected first save through subsequent local adoption", async () => {
    objects.rejectWrites = true;
    await expect(store().write({ companyId, agentId, path: "failed.txt", bytes: Buffer.from("uncommitted"), baseHash: null }, actor()))
      .rejects.toThrow("fixture object-store outage");
    expect(await db.select().from(agentFileRoots).where(eq(agentFileRoots.agentId, agentId))).toEqual([]);
    objects.rejectWrites = false;
    expect(await store().read(companyId, agentId, "failed.txt", actor())).toBeNull();
    await replaceFilesystem();
    expect(await store().read(companyId, agentId, "failed.txt", actor())).toBeNull();
  });

  it("dry-runs migration without adopting files and requires stopped writers for publication", async () => {
    await materializeInstructionBytes(root, "AGENTS.md", Buffer.from("Legacy"));
    const input = { companyId, apply: false, writersStopped: false };
    expect(await migrateAgentFiles(db, input)).toMatchObject({ results: [{ agentId, state: "needs_import" }], pageReady: false });
    expect(await db.select().from(agentFileRoots).where(eq(agentFileRoots.agentId, agentId))).toEqual([]);
    await expect(migrateAgentFiles(db, { ...input, apply: true })).rejects.toThrow("stopped writers");
    expect(await migrateAgentFiles(db, { ...input, apply: true, writersStopped: true })).toMatchObject({ pageReady: true });
    await replaceFilesystem();
    expect(await store().read(companyId, agentId, "AGENTS.md", actor())).toEqual(Buffer.from("Legacy"));
  });

  it("refuses migration while the agent has queued or running execution", async () => {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
    for (const status of ["running", "queued"]) {
      await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, run!.id));
      expect(await migrateAgentFiles(db, { companyId, apply: true, writersStopped: true }))
        .toMatchObject({ results: [{ agentId, state: "active_execution" }], pageReady: false });
      expect(await db.select().from(agentFileRoots).where(eq(agentFileRoots.agentId, agentId))).toEqual([]);
    }
  });

  it("retains current and unadopted objects, then collects expired unreferenced and deleted-owner objects", async () => {
    const prefix = `${companyId}/agent-files/${agentId}/`;
    const abandoned = `${prefix}abandoned`;
    objects.bytes.set(abandoned, Buffer.from("uncertain upload"));
    const provider = { id: "s3" as const, listObjects: async () => ({ keys: [...objects.bytes.keys()].filter(key => key.startsWith(prefix)) }) };
    const input = { companyId, agentId, apply: true, now: AGENT_FILE_OBJECT_GRACE_MS + 1 };
    const collect = (options = input) => collectAgentFileObjects(db, provider, getStorageService(), options);
    expect(await collect()).toMatchObject({ retained: 1, deleted: 0 });
    await store().write({ companyId, agentId, path: "AGENTS.md", bytes: Buffer.from("Current"), baseHash: null }, actor());
    expect(await collect({ ...input, now: 1 })).toMatchObject({ retained: 2, deleted: 0 });
    expect(await collect({ ...input, apply: false })).toMatchObject({ retained: 1, eligible: 1, deleted: 0 });
    expect(objects.bytes.has(abandoned)).toBe(true);
    expect(await collect()).toMatchObject({ retained: 1, deleted: 1 });
    await replaceFilesystem();
    expect(await store().read(companyId, agentId, "AGENTS.md", actor())).toEqual(Buffer.from("Current"));
    await db.delete(agents).where(eq(agents.id, agentId));
    expect(await collect()).toMatchObject({ retained: 0, deleted: 1 });
    expect(objects.bytes.size).toBe(0);
  });

  it("refuses to treat a missing legacy filesystem as an empty durable folder", async () => {
    await materializeInstructionBytes(root, "AGENTS.md", Buffer.from("Not migrated yet"));
    await db.update(agents).set({ adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root } }).where(eq(agents.id, agentId));
    await replaceFilesystem();
    await expect(store().read(companyId, agentId, "AGENTS.md", actor()))
      .rejects.toMatchObject({ status: 503, details: { code: "AGENT_FILES_MIGRATION_REQUIRED" } });
    expect(await db.select().from(agentFileRoots).where(eq(agentFileRoots.agentId, agentId))).toEqual([]);
  });

  it("restores the committed head after SQL rollback and rejects corrupted object bytes", async () => {
    await store().write({ companyId, agentId, path: "AGENTS.md", bytes: Buffer.from("Committed"), baseHash: null }, actor());
    await expect(db.transaction(async tx => {
      const [owner] = await tx.select().from(agents).where(eq(agents.id, agentId)).for("update");
      await adoptAgentFiles(tx, owner!);
      await invalidateAgentFileProjection(root);
      await materializeInstructionBytes(root, "AGENTS.md", Buffer.from("Rolled back"));
      await persistDurableAgentFiles(tx, owner!, root);
      throw new Error("fixture transaction rollback");
    })).rejects.toThrow("fixture transaction rollback");
    expect(await store().read(companyId, agentId, "AGENTS.md", actor())).toEqual(Buffer.from("Committed"));
    await replaceFilesystem(); objects.corruptReads = true;
    await expect(store().read(companyId, agentId, "AGENTS.md", actor())).rejects.toThrow(/committed (size|digest)/);
    objects.corruptReads = false;
    expect(await store().read(companyId, agentId, "AGENTS.md", actor())).toEqual(Buffer.from("Committed"));
  });
});
