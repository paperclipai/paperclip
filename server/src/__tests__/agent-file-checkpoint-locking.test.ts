import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agentFileRoots, agents, authUsers, closeFileStorageDb, companies, companyMemberships, createDb, fileStorageDb, heartbeatRuns,
  issueThreadInteractions, issues, principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentFileStore, fileHash } from "../services/agent-file-store.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";

/** Object storage fixture. Each upload records whether the agent row was locked while it ran. */
const objects = vi.hoisted(() => ({
  bytes: new Map<string, Buffer>(),
  uploads: [] as Array<{ objectKey: string; sha256: string; agentRowLocked: boolean | null }>,
  probe: null as null | (() => Promise<boolean>),
  gate: null as null | Promise<void>,
  started: null as null | (() => void),
  delayMs: 0,
}));
vi.mock("../storage/index.js", () => ({ getStorageService: () => ({
  provider: "s3",
  async putFile(input: { companyId: string; namespace: string; body: Readable; byteSize: number; sha256: string }) {
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    expect(body.length).toBe(input.byteSize);
    expect(fileHash(body)).toBe(input.sha256);
    const agentRowLocked = objects.probe ? await objects.probe() : null;
    objects.started?.();
    if (objects.gate) await objects.gate;
    if (objects.delayMs) await new Promise(resolve => setTimeout(resolve, objects.delayMs));
    const objectKey = `${input.companyId}/${input.namespace}/${randomUUID()}`;
    objects.bytes.set(objectKey, body);
    objects.uploads.push({ objectKey, sha256: input.sha256, agentRowLocked });
    return { objectKey };
  },
  async getObject(_companyId: string, objectKey: string) {
    const body = objects.bytes.get(objectKey);
    if (!body) throw new Error("fixture object missing");
    return { stream: Readable.from([body]) };
  },
}) }));

describe("agent file checkpoint locking", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let observer: ReturnType<typeof createDb>;
  let copies: ReturnType<typeof agentInstructionWorkingCopyService>;
  let home: string, companyId: string, agentId: string, userId: string, root: string;
  const entryFile = "AGENTS.md";
  const board = () => ({ type: "board" as const, userId, source: "session" as const });

  /** True when another transaction holds the agent row lock. */
  async function agentRowLocked(): Promise<boolean> {
    try {
      await observer.transaction(async tx => { await tx.execute(sql`select id from agents where id = ${agentId} for update nowait`); });
      return false;
    } catch (error) {
      const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
      if (code === "55P03") return true;
      throw error;
    }
  }
  async function warmRun() {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    return (await copies.prepare({ companyId, agentId, runId, cwd: home, warm: true }))!;
  }
  async function head() {
    const [row] = await db.select().from(agentFileRoots).where(and(eq(agentFileRoots.companyId, companyId), eq(agentFileRoots.agentId, agentId)));
    return row!;
  }
  /** Every committed file must resolve to stored bytes with its digest. */
  async function expectHeadRestorable() {
    for (const entry of (await head()).entries) {
      if (entry.kind !== "file" || entry.size === 0) continue;
      const bytes = objects.bytes.get(entry.objectKey!);
      expect(bytes, entry.path).toBeDefined();
      expect(fileHash(bytes!)).toBe(entry.sha256);
    }
  }
  /** Statements sent by both pools while the callback runs. */
  async function recordStatements<T>(fn: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
    const statements: string[] = [];
    const clients = [db.$client, fileStorageDb(db).$client] as unknown as Array<{ options: { debug?: unknown } }>;
    for (const client of clients) client.options.debug = (_connection: number, query: string) => { statements.push(query); };
    try { return { result: await fn(), statements }; }
    finally { for (const client of clients) delete client.options.debug; }
  }

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-file-checkpoint-locking-");
    db = createDb(database.connectionString);
    observer = createDb(database.connectionString);
    copies = agentInstructionWorkingCopyService(db);
  }, 90_000);
  afterAll(async () => {
    await observer?.$client.end({ timeout: 1 });
    if (db) { await closeFileStorageDb(db, 1); await db.$client.end({ timeout: 1 }); }
    await database?.cleanup();
  });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-file-checkpoint-locking-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
    objects.bytes.clear(); objects.uploads.length = 0; objects.probe = null; objects.gate = null; objects.started = null; objects.delayMs = 0;
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    root = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "Owner", adapterConfig: {} });
    await db.insert(companies).values({ id: companyId, name: "Checkpoint locking", issuePrefix: randomUUID().slice(0, 8) });
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
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("saves an unchanged warm checkpoint without the agent row lock or a head write", async () => {
    const copy = await warmRun();
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    const generation = (await head()).generation;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>(resolve => { locked = resolve; });
    const holder = observer.transaction(async tx => {
      await tx.execute(sql`select id from agents where id = ${agentId} for update`);
      locked();
      await held;
    });
    await lockTaken;
    try {
      const { result, statements } = await recordStatements(() => Promise.race([
        copies.checkpointWarm({ companyId, runId: copy.runId }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("checkpoint waited for the agent row lock")), 5_000)),
      ]));
      expect(result?.state).toBe("warm_saved");
      expect(result?.receipt?.checkpointState).toBe("unchanged");
      expect(statements.filter(statement => /for (update|no key update|share)/i.test(statement))).toEqual([]);
      // One unlocked read of the head generation; no head write.
      expect(statements.filter(statement => statement.includes("agent_file_roots")).map(statement => statement.trim().split(/\s/)[0]!.toLowerCase())).toEqual(["select"]);
    } finally {
      release();
      await holder;
    }
    expect((await head()).generation).toBe(generation);
  });

  it("adopts the agent's files into a durable head on an unchanged checkpoint when no head exists", async () => {
    const copy = await warmRun();
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    // Durable files were turned on after this run started: the agent has local files and no head.
    await db.delete(agentFileRoots).where(and(eq(agentFileRoots.companyId, companyId), eq(agentFileRoots.agentId, agentId)));
    await fs.rm(path.join(path.dirname(root), "file-sync", "durable-adoption.json"), { force: true });
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    expect((await head())?.entries.map(entry => entry.path)).toContain(entryFile);
    await expectHeadRestorable();
  });

  it("takes the locked path for an unchanged checkpoint when the local projection is not marked at the head", async () => {
    const copy = await warmRun();
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    await fs.rm(path.join(path.dirname(root), "file-sync", "durable-generation"), { force: true });
    const { result, statements } = await recordStatements(() => copies.checkpointWarm({ companyId, runId: copy.runId }));
    expect(result?.state).toBe("warm_saved");
    expect(statements.some(statement => /for update/i.test(statement))).toBe(true);
    expect(await fs.readFile(path.join(path.dirname(root), "file-sync", "durable-generation"), "utf8")).toBe((await head()).generation);
  });

  it("uploads changed bytes before it takes the agent row lock, then commits the uploaded object", async () => {
    const copy = await warmRun();
    objects.uploads.length = 0;
    objects.probe = agentRowLocked;
    await fs.writeFile(path.join(copy.localRoot, "notes.md"), "turn one");
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    expect(objects.uploads).toEqual([{ objectKey: expect.any(String), sha256: fileHash(Buffer.from("turn one")), agentRowLocked: false }]);
    const entry = (await head()).entries.find(candidate => candidate.path === "notes.md");
    expect(entry).toMatchObject({ kind: "file", sha256: fileHash(Buffer.from("turn one")), objectKey: objects.uploads[0]!.objectKey });
    await expectHeadRestorable();
  });

  it("uploads nothing when the run lost its save permission before the checkpoint", async () => {
    const copy = await warmRun();
    const before = await head();
    objects.uploads.length = 0;
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(eq(companyMemberships.companyId, companyId));
    await fs.writeFile(path.join(copy.localRoot, "refused.md"), "must not upload");
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.errorCode).toBe("AGENT_FILES_CHECKPOINT_UNSTABLE");
    expect(objects.uploads).toEqual([]);
    expect((await head()).generation).toBe(before.generation);
  });

  it("consumes an accepted change confirmation once, in the commit of the changed checkpoint only", async () => {
    const copy = await warmRun();
    const sourceRunId = randomUUID(), issueId = randomUUID(), interactionId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, status: "succeeded" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review instructions" });
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(eq(companyMemberships.companyId, companyId));
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "agent", principalId: agentId, permissionKey: "agents:suggest-changes" },
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:suggest-changes" },
    ]);
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, kind: "request_confirmation", status: "accepted", sourceRunId, createdByAgentId: agentId,
      payload: { version: 1, prompt: "Apply the file change?", detailsMarkdown: "```diff\n+approved\n```", target: { type: "custom", key: `agent:${agentId}:instructions`, revisionId: "proposal" } },
      result: { version: 1, outcome: "accepted" }, resolvedByUserId: userId, resolvedAt: new Date(),
    });
    const confirmation = async () => (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId)))[0]!.result;
    // A turn that changes no file keeps the confirmation for the change it approves.
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))).toMatchObject({ state: "warm_saved", errorCode: null });
    expect(await confirmation()).not.toHaveProperty("consumedByRunId");
    objects.uploads.length = 0;
    await fs.writeFile(path.join(copy.localRoot, "approved.md"), "approved change");
    const saved = (await copies.checkpointWarm({ companyId, runId: copy.runId }))!;
    expect(saved).toMatchObject({ state: "warm_saved", errorCode: null });
    expect(await confirmation()).toMatchObject({ consumedByRunId: copy.runId });
    expect((await head()).entries.find(entry => entry.path === "approved.md")).toMatchObject({ sha256: fileHash(Buffer.from("approved change")) });
    expect(objects.uploads).toHaveLength(1);
    // The confirmation is spent: the next change is refused before it uploads.
    await fs.writeFile(path.join(copy.localRoot, "unapproved.md"), "second change");
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.errorCode).toBe("AGENT_FILES_CHECKPOINT_UNSTABLE");
    expect(objects.uploads).toHaveLength(1);
  });

  it("commits both runs when two warm checkpoints of one agent race", async () => {
    const first = await warmRun();
    const second = await warmRun();
    objects.uploads.length = 0;
    objects.probe = agentRowLocked;
    objects.delayMs = 100;
    await fs.writeFile(path.join(first.localRoot, "first.md"), "from the first run");
    await fs.writeFile(path.join(second.localRoot, "second.md"), "from the second run");
    const [a, b] = await Promise.all([
      copies.checkpointWarm({ companyId, runId: first.runId }),
      copies.checkpointWarm({ companyId, runId: second.runId }),
    ]);
    expect([a?.state, b?.state]).toEqual(["warm_saved", "warm_saved"]);
    expect(objects.uploads.map(upload => upload.agentRowLocked)).toEqual([false, false]);
    const paths = (await head()).entries.map(entry => entry.path);
    expect(paths).toEqual(expect.arrayContaining(["first.md", "second.md", entryFile]));
    expect(await fs.readFile(path.join(root, "first.md"), "utf8")).toBe("from the first run");
    expect(await fs.readFile(path.join(root, "second.md"), "utf8")).toBe("from the second run");
    await expectHeadRestorable();
  });

  it("lets an instruction edit commit while a checkpoint uploads, then keeps both changes", async () => {
    const copy = await warmRun();
    objects.uploads.length = 0;
    let open!: () => void;
    objects.gate = new Promise<void>(resolve => { open = resolve; });
    const uploading = new Promise<void>(resolve => { objects.started = resolve; });
    await fs.writeFile(path.join(copy.localRoot, "memory.md"), "from the run");
    const checkpoint = copies.checkpointWarm({ companyId, runId: copy.runId });
    await uploading;
    // The checkpoint waits inside its upload. The editor must not wait for it.
    objects.started = null;
    const editorGate = objects.gate;
    objects.gate = null;
    const edited = await Promise.race([
      agentFileStore(db).write({ companyId, agentId, path: entryFile, bytes: Buffer.from("# Edited policy\n"), baseHash: fileHash(Buffer.from("# Policy\n")) }, board()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("editor waited for the checkpoint upload")), 10_000)),
    ]);
    expect(edited.changed).toBe(true);
    open();
    await editorGate;
    expect((await checkpoint)?.state).toBe("warm_saved");
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe("# Edited policy\n");
    expect(await fs.readFile(path.join(root, "memory.md"), "utf8")).toBe("from the run");
    const entries = new Map((await head()).entries.map(entry => [entry.path, entry]));
    expect(entries.get(entryFile)).toMatchObject({ sha256: fileHash(Buffer.from("# Edited policy\n")) });
    expect(entries.get("memory.md")).toMatchObject({ sha256: fileHash(Buffer.from("from the run")) });
    await expectHeadRestorable();
  });

  it("keeps the committed files when the save stops between upload and commit", async () => {
    const copy = await warmRun();
    const before = await head();
    objects.uploads.length = 0;
    let open!: () => void;
    objects.gate = new Promise<void>(resolve => { open = resolve; });
    await fs.writeFile(path.join(copy.localRoot, "draft.md"), "uploaded but not committed");
    const uploading = new Promise<void>(resolve => { objects.started = resolve; });
    const checkpoint = copies.checkpointWarm({ companyId, runId: copy.runId });
    await Promise.race([uploading, checkpoint]);
    objects.started = null;
    // Change the instruction entry while the bytes upload. The commit then refuses the save.
    await db.update(agents).set({ adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "OTHER.md" } })
      .where(eq(agents.id, agentId));
    objects.gate = null;
    open();
    const failed = (await checkpoint)!;
    expect(failed.errorCode).toBe("AGENT_FILES_CHECKPOINT_UNSTABLE");
    expect(objects.uploads.length).toBeGreaterThan(0);
    const after = await head();
    expect(after.generation).toBe(before.generation);
    expect(after.entries.some(entry => entry.path === "draft.md")).toBe(false);
    await expectHeadRestorable();
    // The next save after the entry is restored commits the same change.
    await db.update(agents).set({ adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } })
      .where(eq(agents.id, agentId));
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    expect((await head()).entries.find(entry => entry.path === "draft.md")).toMatchObject({ sha256: fileHash(Buffer.from("uploaded but not committed")) });
    await expectHeadRestorable();
  });

  // Opt in: PAPERCLIP_AGENT_FILE_CHECKPOINT_BENCHMARK=1 pnpm exec vitest run src/__tests__/agent-file-checkpoint-locking.test.ts -t measures
  // Wall time shares the host's load; statement counts and lock observations are exact.
  it.skipIf(process.env.PAPERCLIP_AGENT_FILE_CHECKPOINT_BENCHMARK !== "1")("measures checkpoint statements and agent row lock time", async () => {
    const copy = await warmRun();
    for (let file = 0; file < 50; file += 1) await fs.writeFile(path.join(copy.localRoot, `file-${file}.md`), `content ${file}`);
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    const unchanged: Array<{ ms: number; statements: number; rowLocks: number }> = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const started = performance.now();
      const { statements } = await recordStatements(() => copies.checkpointWarm({ companyId, runId: copy.runId }));
      unchanged.push({ ms: performance.now() - started, statements: statements.length,
        rowLocks: statements.filter(statement => /for (update|no key update|share)/i.test(statement)).length });
    }
    // One changed file per save, with 250 ms object-store latency. Observe the agent row lock from another connection.
    objects.delayMs = 250;
    const changed: Array<{ ms: number; statements: number; lockedMs: number }> = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await fs.writeFile(path.join(copy.localRoot, "changed.md"), `changed ${attempt}`);
      let polling = true, firstLocked = 0, lastLocked = 0;
      const poller = (async () => {
        while (polling) {
          if (await agentRowLocked()) { const now = performance.now(); firstLocked ||= now; lastLocked = now; }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      })();
      const started = performance.now();
      const { statements } = await recordStatements(() => copies.checkpointWarm({ companyId, runId: copy.runId }));
      const ms = performance.now() - started;
      polling = false;
      await poller;
      changed.push({ ms, statements: statements.length, lockedMs: firstLocked ? lastLocked - firstLocked : 0 });
    }
    const median = (values: number[]) => Math.round([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!);
    console.info(JSON.stringify({
      unchanged: { medianMs: median(unchanged.map(value => value.ms)), statements: unchanged[0]!.statements, rowLockStatements: unchanged[0]!.rowLocks },
      changed: { medianMs: median(changed.map(value => value.ms)), statements: changed[0]!.statements,
        medianAgentRowLockObservedMs: median(changed.map(value => value.lockedMs)), lockObservedMs: changed.map(value => Math.round(value.lockedMs)) },
    }));
  }, 120_000);
});
