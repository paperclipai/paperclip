import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { S3Client, CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, agentFileRoots, agentInstructionWorkingCopies, companies, createDb, closeFileStorageDb, heartbeatRuns, providerTraceRecords } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { migrateEphemeralServerData } from "../maintenance/ephemeral-migration-data.js";
import { agentFileStore } from "../services/agent-file-store.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { materializeInstructionBytes } from "../services/agent-instruction-files.js";
import { verifyAgentFileObjects } from "../services/agent-file-maintenance.js";
import { getStorageService } from "../storage/index.js";
import { resolveDecisionSigningSecret } from "../services/decision-signing.js";

// Explicit real-dependency qualification. Never contacts off-host storage in
// the default test path; use a disposable S3-compatible service and PostgreSQL.
describe.skipIf(!process.env.PAPERCLIP_TEST_S3_ENDPOINT)("existing-volume enrollment with PostgreSQL and S3", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, s3: S3Client;
  let home: string, companyId: string, bucket: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("ephemeral-migration-"); db = createDb(database.connectionString);
    s3 = new S3Client({ endpoint: process.env.PAPERCLIP_TEST_S3_ENDPOINT, region: "us-east-1", forcePathStyle: true });
  }, 90_000);
  beforeEach(async () => {
    companyId = randomUUID(); bucket = `enrollment-${randomUUID()}`;
    home = await fs.mkdtemp(path.join(os.tmpdir(), "ephemeral-migration-"));
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "false"); vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", bucket); vi.stubEnv("PAPERCLIP_STORAGE_S3_REGION", "us-east-1");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_ENDPOINT", process.env.PAPERCLIP_TEST_S3_ENDPOINT!);
    vi.stubEnv("PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE", "true");
    await db.insert(companies).values({ id: companyId, name: "Enrollment fixture", issuePrefix: "MIG" });
  });
  afterEach(async () => {
    await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
      if (page.Contents?.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: page.Contents.map(row => ({ Key: row.Key! })) } }));
      token = page.NextContinuationToken;
    } while (token);
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    await fs.rm(home, { recursive: true, force: true }); vi.unstubAllEnvs();
  });
  afterAll(async () => {
    if (db) { await closeFileStorageDb(db, 1); await db.$client.end({ timeout: 1 }); }
    await database?.cleanup(); s3?.destroy();
  });
  const migrate = () => migrateEphemeralServerData(db, { signal: AbortSignal.timeout(120_000), phase: () => {} });
  async function agent(index = 0) {
    const row = { id: randomUUID(), companyId, name: `Migrated ${index}`, adapterConfig: {} };
    const root = resolveManagedInstructionsRoot(row);
    await materializeInstructionBytes(root, "AGENTS.md", Buffer.from(`Original ${index}`));
    await db.insert(agents).values({ ...row, adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root } });
    return { ...row, root };
  }
  it("migrates every page, verifies object bytes, and reads after deleting the entire predecessor filesystem", async () => {
    const rows = [];
    for (let index = 0; index < 26; index++) rows.push(await agent(index));
    const binary = Buffer.alloc(2 * 1024 * 1024, 0x81);
    await materializeInstructionBytes(rows[0]!.root, "nested/data.bin", binary);
    await materializeInstructionBytes(rows[0]!.root, "empty.txt", Buffer.alloc(0));
    expect(await migrate()).toMatchObject({ eligibility: { eligible: true }, counts: { agentFiles: 26, verifiedAgentObjects: 28 } });
    await fs.rm(home, { recursive: true, force: true });
    home = await fs.mkdtemp(path.join(os.tmpdir(), "ephemeral-successor-")); vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true"); vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "false");
    // The service's normal board actor uses instance-operator authority.
    const actor = { type: "board" as const, source: "local_implicit" as const, userId: "local-board" };
    const store = agentFileStore(db);
    for (let index = 0; index < rows.length; index++) {
      expect(await store.read(companyId, rows[index]!.id, "AGENTS.md", actor)).toEqual(Buffer.from(`Original ${index}`));
    }
    expect(await store.read(companyId, rows[0]!.id, "nested/data.bin", actor)).toEqual(binary);
    const [head] = await db.select().from(agentFileRoots).where(eq(agentFileRoots.agentId, rows[0]!.id));
    const file = head!.entries.find(entry => entry.kind === "file" && entry.objectKey !== null)!;
    if (file.kind !== "file" || !file.objectKey) throw new Error("Missing object");
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: file.objectKey, Body: "corrupt" }));
    await expect(verifyAgentFileObjects(db, getStorageService(), AbortSignal.timeout(30_000))).rejects.toThrow(/agent_file_object_(size|digest)_mismatch/);
  }, 120_000);
  const entry = fileURLToPath(new URL("../../dist-runtime/ephemeral-migration.mjs", import.meta.url));
  it.skipIf(!existsSync(entry))("runs the actual bundled maintenance entry with plain Node and exits cleanly", async () => {
    await agent();
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "");
    const original = resolveDecisionSigningSecret();
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const id = randomUUID(), token = randomBytes(32).toString("base64url");
    const stamp = JSON.parse(await fs.readFile(new URL("../../dist/build-info.json", import.meta.url), "utf8"));
    const child = spawn(process.execPath, [entry], { env: { ...process.env, DATABASE_URL: database.connectionString,
      PAPERCLIP_DATABASE_LISTEN_URL: database.connectionString, PAPERCLIP_SECRETS_MASTER_KEY: randomBytes(32).toString("hex"),
      PAPERCLIP_SHARED_UI_ASSETS: "true", PAPERCLIP_EPHEMERAL_MIGRATION: "true", PAPERCLIP_EPHEMERAL_MIGRATION_ID: id,
      PAPERCLIP_EPHEMERAL_MIGRATION_TOKEN: token, PORT: String(address.port) }, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostic = "";
    child.stderr.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-8_192); });
    child.stdout.resume();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: `Bearer ${token}` };
    try {
      let status: Record<string, unknown> | undefined;
      for (const until = Date.now() + 45_000; Date.now() < until;) {
        if (child.exitCode !== null) throw new Error(`Maintenance exited: ${diagnostic}`);
        status = await fetch(`${origin}/status`, { headers, signal: AbortSignal.timeout(1_000) }).then(r => r.json() as Promise<Record<string, unknown>>).catch(() => undefined);
        if (status?.state === "ready" || status?.state === "blocked") break;
        await delay(100);
      }
      expect(status).toMatchObject({ id, commit: stamp.commit, state: "ready", eligibility: { eligible: true } });
      expect(JSON.stringify(status)).not.toContain(original);
      const exported = await fetch(`${origin}/export`, { method: "POST", headers }).then(r => r.json());
      expect(exported).toMatchObject({ id, commit: stamp.commit, decisionSigningSecret: original });
      expect((await fetch(`${origin}/api/companies`, { headers })).status).toBe(404);
      child.kill("SIGTERM");
      expect(await Promise.race([exited, delay(12_000).then(() => { throw new Error("Maintenance did not exit gracefully"); })])).toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }, 60_000);

  it("refuses active executions and missing predecessor bytes without publishing an empty head", async () => {
    const row = await agent();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: row.id, status: "running" }).returning();
    await expect(migrate()).rejects.toThrow("active_execution_requires_drain");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run!.id));
    await fs.rm(home, { recursive: true, force: true });
    await expect(migrate()).rejects.toThrow();
    expect(await db.select().from(agentFileRoots).where(eq(agentFileRoots.agentId, row.id))).toEqual([]);
  });

  it("retains unsaved terminal-run working copies until their owner records settlement", async () => {
    const row = await agent();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: row.id, status: "succeeded" }).returning();
    const privateRoot = path.join(home, "private-copy");
    await materializeInstructionBytes(privateRoot, "AGENTS.md", Buffer.from("Unsaved work"));
    await db.insert(agentInstructionWorkingCopies).values({ runId: run!.id, companyId, agentId: row.id,
      responsibleUserId: "fixture", entryFile: "AGENTS.md", baseHash: "fixture", localRoot: privateRoot,
      executionRoot: privateRoot, location: "local", state: "pending_collection" });
    await expect(migrate()).rejects.toThrow("local_instruction_copies_require_settlement");
    expect(await fs.readFile(path.join(privateRoot, "AGENTS.md"), "utf8")).toBe("Unsaved work");
    expect(await db.select().from(agentFileRoots).where(eq(agentFileRoots.agentId, row.id))).toEqual([]);
    // Simulate only the owning service's completed collection receipt. The
    // enrollment coordinator must not fabricate that save or erase the copy.
    await materializeInstructionBytes(row.root, "AGENTS.md", Buffer.from("Unsaved work"));
    await db.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date() })
      .where(eq(agentInstructionWorkingCopies.runId, run!.id));
    expect((await migrate()).eligibility.eligible).toBe(true);
  });

  it("expires every page of local traces through their owner before final eligibility", async () => {
    const row = await agent();
    const runs = await db.insert(heartbeatRuns).values(Array.from({ length: 101 }, () => ({
      companyId, agentId: row.id, status: "succeeded",
    }))).returning();
    await db.insert(providerTraceRecords).values(runs.map(run => ({ companyId, runId: run.id, provider: "codex",
      traceRef: `${randomUUID()}.ndjson`, status: "complete", requestedBy: "fixture", expiresAt: new Date(0) })));
    expect(await migrate()).toMatchObject({ eligibility: { eligible: true }, counts: { expiredTraces: 101 } });
    expect((await db.select().from(providerTraceRecords).where(eq(providerTraceRecords.companyId, companyId)))
      .every(trace => trace.status === "expired" && trace.deletedAt !== null)).toBe(true);
  }, 120_000);

  it("accepts an unavailable directory only after its owner confirms stop and no-save cleanup", async () => {
    const row = await agent();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: row.id, status: "succeeded" }).returning();
    await db.insert(agentInstructionWorkingCopies).values({ runId: run!.id, companyId, agentId: row.id,
      responsibleUserId: "fixture", entryFile: "AGENTS.md", baseHash: "fixture", localRoot: path.join(home, "rejected-copy"),
      executionRoot: path.join(home, "rejected-copy"), location: "local", state: "unavailable",
      errorCode: "AGENT_FILES_LIMIT_EXCEEDED", receipt: { schema: "paperclip.agent-files.v1", cleanupPending: true } });
    await expect(migrate()).rejects.toThrow("local_instruction_copies_require_settlement");
    await db.update(agentInstructionWorkingCopies).set({ receipt: { schema: "paperclip.agent-files.v1", cleanupPending: false } })
      .where(eq(agentInstructionWorkingCopies.runId, run!.id));
    await expect(migrate()).rejects.toThrow("local_instruction_copies_require_settlement");
    await db.update(agentInstructionWorkingCopies).set({ processStoppedAt: new Date() })
      .where(eq(agentInstructionWorkingCopies.runId, run!.id));
    expect((await migrate()).eligibility.eligible).toBe(true);
  });
});
