import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agentFileRoots, agents, authUsers, closeFileStorageDb, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentFileStore, fileHash } from "../services/agent-file-store.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";

const objects = vi.hoisted(() => ({
  bytes: new Map<string, Buffer>(),
  downloads: [] as Array<{ objectKey: string; agentRowLocked: boolean | null }>,
  probe: null as null | (() => Promise<boolean>),
  gate: null as null | { opened: Promise<void>; reached: () => void },
  delayMs: 0,
}));
vi.mock("../storage/index.js", () => ({ getStorageService: () => ({
  provider: "s3",
  async putFile(input: { companyId: string; namespace: string; body: Readable }) {
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    const objectKey = `${input.companyId}/${input.namespace}/${randomUUID()}`;
    objects.bytes.set(objectKey, Buffer.concat(chunks));
    return { objectKey };
  },
  async getObject(_companyId: string, objectKey: string) {
    const body = objects.bytes.get(objectKey);
    if (!body) throw new Error("fixture object missing");
    objects.downloads.push({ objectKey, agentRowLocked: objects.probe ? await objects.probe() : null });
    const gate = objects.gate;
    if (gate) { objects.gate = null; gate.reached(); await gate.opened; }
    if (objects.delayMs) await new Promise(resolve => setTimeout(resolve, objects.delayMs));
    return { stream: Readable.from([body]) };
  },
}) }));

describe("agent file restore locking", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let observer: ReturnType<typeof createDb>;
  let home: string, companyId: string, agentId: string, userId: string, root: string;
  const entryFile = "AGENTS.md";
  const board = () => ({ type: "board" as const, userId, source: "session" as const });
  const target = () => ({ companyId, agentId });

  const lockCheckQuery = () => sql`select id from agents where id = ${agentId} for share nowait`;
  async function agentRowLocked(): Promise<boolean> {
    try {
      await observer.transaction(async tx => { await tx.execute(lockCheckQuery()); });
      return false;
    } catch (error) {
      const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
      if (code === "55P03") return true;
      throw error;
    }
  }
  async function head() {
    const [row] = await db.select().from(agentFileRoots).where(and(eq(agentFileRoots.companyId, companyId), eq(agentFileRoots.agentId, agentId)));
    return row!;
  }
  async function loseLocalProjection() {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.join(path.dirname(root), "file-sync", "durable-generation"), { force: true });
  }
  async function stagingLeftovers() {
    return (await fs.readdir(path.dirname(root))).filter(name => name.startsWith(".agent-files-"));
  }

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-file-restore-locking-");
    db = createDb(database.connectionString);
    observer = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await observer?.$client.end({ timeout: 1 });
    if (db) { await closeFileStorageDb(db, 1); await db.$client.end({ timeout: 1 }); }
    await database?.cleanup();
  });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-file-restore-locking-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
    objects.bytes.clear(); objects.downloads.length = 0; objects.probe = null; objects.gate = null; objects.delayMs = 0;
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    root = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "Owner", adapterConfig: {} });
    await db.insert(companies).values({ id: companyId, name: "Restore locking", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner",
      adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
      permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, entryFile), "# Policy\n");
    expect((await agentInstructionRevisionService(db).readCommittedForRuntime(target()))?.content).toBe("# Policy\n");
    expect((await head()).entries.map(entry => entry.path)).toEqual([entryFile]);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  async function whileHolding(lock: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>, check: () => Promise<void>) {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let holding!: () => void;
    const held = new Promise<void>(resolve => { holding = resolve; });
    const holder = db.transaction(async tx => { await lock(tx); holding(); await released; });
    await Promise.race([held, holder]);
    try { await check(); } finally { release(); }
    await holder;
  }

  it("a lock check does not block another lock check", async () => {
    await whileHolding(tx => tx.execute(lockCheckQuery()), async () => {
      expect(await agentRowLocked()).toBe(false);
    });
  });

  it("a lock check detects the product's agent row lock", async () => {
    await whileHolding(tx => tx.select().from(agents).where(eq(agents.id, agentId)).for("update"), async () => {
      expect(await agentRowLocked()).toBe(true);
    });
    expect(await agentRowLocked()).toBe(false);
  });

  it("downloads a stale projection without holding the agent row lock", async () => {
    await loseLocalProjection();
    objects.probe = agentRowLocked;
    objects.delayMs = 300;
    let lockedMs = 0;
    let sampling = true;
    const sampler = (async () => {
      let last = performance.now();
      while (sampling) {
        const locked = await agentRowLocked();
        const now = performance.now();
        if (locked) lockedMs += now - last;
        last = now;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();
    const startedAt = performance.now();
    let current: Awaited<ReturnType<ReturnType<typeof agentInstructionRevisionService>["readCommittedForRuntime"]>>;
    let elapsedMs: number;
    try {
      current = await agentInstructionRevisionService(db).readCommittedForRuntime(target());
      elapsedMs = performance.now() - startedAt;
    } finally {
      sampling = false;
      await sampler;
    }
    console.info(JSON.stringify({ metric: "agent_file_restore_row_lock", downloads: objects.downloads.length,
      downloadsWhileLocked: objects.downloads.filter(download => download.agentRowLocked).length, lockedMs: Math.round(lockedMs), elapsedMs: Math.round(elapsedMs) }));
    expect(current?.content).toBe("# Policy\n");
    expect(objects.downloads).toEqual([{ objectKey: expect.any(String), agentRowLocked: false }]);
    expect(lockedMs).toBeLessThan(150);
    expect(await fs.readFile(path.join(path.dirname(root), "file-sync", "durable-generation"), "utf8")).toBe((await head()).generation);
    expect(await stagingLeftovers()).toEqual([]);
  });

  it("lets a writer commit during the download and then serves the writer's head, not the stale download", async () => {
    await loseLocalProjection();
    let open!: () => void, reached!: () => void;
    const opened = new Promise<void>(resolve => { open = resolve; });
    const reachedPromise = new Promise<void>(resolve => { reached = resolve; });
    objects.gate = { opened, reached };
    const before = (await head()).generation;
    const reader = agentInstructionRevisionService(db).readCommittedForRuntime(target());
    await reachedPromise;
    try {
      const written = await Promise.race([
        agentFileStore(db).write({ companyId, agentId, path: entryFile, bytes: Buffer.from("# Policy v2\n"), baseHash: fileHash(Buffer.from("# Policy\n")) }, board()),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the writer waited for the reader's download")), 5_000)),
      ]);
      expect(written).toMatchObject({ changed: true });
    } finally { open(); }
    const current = await reader;
    const after = await head();
    expect(after.generation).not.toBe(before);
    expect(current?.content).toBe("# Policy v2\n");
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe("# Policy v2\n");
    expect(await fs.readFile(path.join(path.dirname(root), "file-sync", "durable-generation"), "utf8")).toBe(after.generation);
    expect(await stagingLeftovers()).toEqual([]);
  });

  it("fails once, without the row lock and without retrying, when the staged download fails", async () => {
    await loseLocalProjection();
    const attempts: boolean[] = [];
    objects.probe = async () => {
      attempts.push(await agentRowLocked());
      throw new Error("object storage unavailable");
    };
    await expect(agentInstructionRevisionService(db).readCommittedForRuntime(target())).rejects.toThrow("object storage unavailable");
    expect(attempts).toEqual([false]);
    expect(await stagingLeftovers()).toEqual([]);
  });

  it("restores under the lock as before when the head keeps changing during every download", async () => {
    await loseLocalProjection();
    const store = agentFileStore(db);
    let version = 0;
    const realGet = objects.probe;
    objects.probe = async () => {
      if (version < 2) {
        version++;
        await db.update(agentFileRoots).set({ generation: randomUUID() })
          .where(and(eq(agentFileRoots.companyId, companyId), eq(agentFileRoots.agentId, agentId)));
      }
      return realGet ? realGet() : false;
    };
    expect((await store.read(companyId, agentId, entryFile, board()))?.toString("utf8")).toBe("# Policy\n");
    expect(objects.downloads).toHaveLength(3);
    expect(await fs.readFile(path.join(path.dirname(root), "file-sync", "durable-generation"), "utf8")).toBe((await head()).generation);
    expect(await stagingLeftovers()).toEqual([]);
  });
});
