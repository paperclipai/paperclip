import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { StorageProvider } from "../storage/types.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { uniqueIssuePrefix } from "../__tests__/helpers/issue-prefix.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());
const mirrors = vi.hoisted(() => new Map<string, Buffer>());
const etag = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const provider = vi.hoisted((): StorageProvider => {
  const digest = async (bytes: Buffer) => (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  return {
    id: "s3",
    async putObject() { throw new Error("unexpected unconditional write"); },
    async putObjectConditional(input) {
      const old = objects.get(input.objectKey);
      if (input.ifNoneMatch ? old : !old || await digest(old) !== input.ifMatch)
        throw Object.assign(new Error("conflict"), { name: "PreconditionFailed" });
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(input.body)) chunks.push(input.body);
      else for await (const chunk of input.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      objects.set(input.objectKey, bytes);
      return { etag: await digest(bytes) };
    },
    async getObject(input) {
      const bytes = objects.get(input.objectKey);
      if (!bytes) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      const { Readable: ReadableStream } = await import("node:stream");
      return { stream: ReadableStream.from([bytes]), etag: await digest(bytes), contentLength: bytes.length };
    },
    async headObject(input) { return { exists: objects.has(input.objectKey) }; },
    async deleteObject(input) { objects.delete(input.objectKey); },
    async listObjects(input) { return { keys: [...objects.keys()].filter(key => key.startsWith(input.prefix)) }; },
  };
});
vi.mock("./run-evidence-storage.js", () => ({
  resolveRunEvidenceStorage: () => ({ provider, keyPrefix: "run-logs", tracePrefix: "provider-traces" }),
}));
vi.mock("./run-log-store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./run-log-store.js")>();
  const { Readable } = await import("node:stream");
  return {
    ...actual,
    openLegacyRunLogForMigration: async (logRef: string, options?: { requireCanonicalLocalFile?: boolean }) => {
      const mirror = mirrors.get(logRef);
      if (!mirror) return actual.openLegacyRunLogForMigration(logRef, options);
      return { stream: Readable.from([mirror]), bytes: mirror.length, source: "mirror" as const };
    },
  };
});

const { migrateRunEvidence } = await import("./run-evidence-migration.js");
const { migrateRunEvidencePage } = await import("./run-evidence-migration-page.js");
const { createObjectRunLogStore } = await import("./object-run-log-store.js");
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("run log migration after a retry appended to a finalized log", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let directory = "";
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-log-appended-");
    db = createDb(tempDb.connectionString);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-appended-"));
    vi.stubEnv("RUN_LOG_BASE_PATH", directory);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end();
    await tempDb?.cleanup();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  async function seed(prefix: string, file: string, recordedSha256 = etag(Buffer.from(prefix)), runtimeMode = "legacy") {
    const [company] = await db.insert(companies).values({ name: "Logs", issuePrefix: uniqueIssuePrefix("L") }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Worker" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, status: "failed", runtimeMode }).returning();
    const logRef = `${company!.id}/${agent!.id}/${run!.id}.ndjson`;
    await fs.mkdir(path.dirname(path.join(directory, logRef)), { recursive: true });
    await fs.writeFile(path.join(directory, logRef), file);
    await db.update(heartbeatRuns).set({ logStore: "local_file", logRef, logBytes: Buffer.byteLength(prefix), logSha256: recordedSha256 })
      .where(eq(heartbeatRuns.id, run!.id));
    return { companyId: company!.id, agentId: agent!.id, runId: run!.id, logRef };
  }

  it.each([
    ["online", "legacy", (_companyId: string, runId: string) => migrateRunEvidencePage(db, { kinds: ["log"], limit: 100 })
      .then(page => ({ items: page.items.filter(item => item.id === runId) }))],
    ["offline", "native", (companyId: string) => {
      vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
      return migrateRunEvidence(db, { apply: true, companyId, kinds: ["log"], preserveHistoricalFiles: true })
        .finally(() => vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "false"));
    }],
  ] as const)("archives every current byte when the recorded log is a prefix, keeping both proofs (%s)", async (_path, runtimeMode, migrate) => {
    const first = '{"seq":1,"stream":"stdout","chunk":"first attempt"}\n';
    const retry = '{"seq":2,"stream":"stdout","chunk":"retry 再開"}\n';
    const f = await seed(first, first + retry, undefined, runtimeMode);
    const result = await migrate(f.companyId, f.runId);
    const full = Buffer.from(first + retry);
    expect(result.items).toEqual([expect.objectContaining({ id: f.runId, state: "migrated", historicalArchive: true,
      bytes: full.length, sha256: etag(full) })]);
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(row).toMatchObject({ logStore: "s3_archive", logRef: `${f.companyId}/${f.agentId}/${f.runId}.archive`,
      logBytes: full.length, logSha256: etag(full) });
    await fs.rm(path.join(directory, f.logRef));
    const store = createObjectRunLogStore({ provider, keyPrefix: "run-logs", assertWriterAuthority: async () => undefined });
    expect((await store.read({ store: "s3_archive", logRef: row!.logRef! })).content).toBe(first + retry);
    const entries = await db.select({ action: activityLog.action, details: activityLog.details }).from(activityLog)
      .where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, f.runId)));
    expect(entries).toEqual([{ action: "run.historical_log_archived", details: {
      reason: "output_appended_after_finalize",
      recorded: { bytes: Buffer.byteLength(first), sha256: etag(Buffer.from(first)) },
      bytes: full.length, sha256: etag(full),
    } }]);
  });

  it("keeps an extended log on the volume while the same run still has an attempt pending", async () => {
    const first = "first attempt\n";
    const f = await seed(first, `${first}retry output\n`, undefined, "native");
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Retrying" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue!.id }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId, issueId: issue!.id,
      phase: "retryable_failure", nextAttemptAt: new Date(Date.now() + 60_000) });
    const online = await migrateRunEvidencePage(db, { kinds: ["log"], limit: 100 });
    expect(online.items.filter(item => item.id === f.runId)).toEqual([expect.objectContaining({ state: "blocked", reason: "legacy_writer_retry_pending" })]);
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    const offline = await migrateRunEvidence(db, { apply: true, companyId: f.companyId, kinds: ["log"], preserveHistoricalFiles: true })
      .finally(() => vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "false"));
    expect(offline.items).toEqual([expect.objectContaining({ id: f.runId, state: "blocked", reason: "legacy_writer_retry_pending" })]);
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(row).toMatchObject({ logStore: "local_file", logRef: f.logRef, logBytes: Buffer.byteLength(first) });
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toEqual([]);
  });

  it("does not treat a longer mirror copy as the complete log", async () => {
    const first = "first attempt\n";
    const f = await seed(first, first);
    await fs.rm(path.join(directory, f.logRef));
    mirrors.set(f.logRef, Buffer.from(`${first}partial retry`));
    try {
      const result = await migrateRunEvidence(db, { apply: true, companyId: f.companyId, kinds: ["log"] });
      expect(result.items).toEqual([expect.objectContaining({ id: f.runId, state: "blocked", reason: "mirror_completeness_unproven" })]);
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(row).toMatchObject({ logStore: "local_file", logRef: f.logRef });
    } finally {
      mirrors.delete(f.logRef);
    }
  });

  it("keeps a log blocked under its own name when the recorded digest is not a prefix of the file", async () => {
    const longer = await seed("original output\n", "different output\nand more\n");
    const shorter = await seed("original output that was longer\n", "original output\n");
    const same = await seed("original output\n", "originaX output\n");
    for (const f of [longer, shorter, same]) {
      const online = await migrateRunEvidencePage(db, { kinds: ["log"], limit: 100 });
      expect(online.items.filter(item => item.id === f.runId)).toEqual([expect.objectContaining({ state: "blocked", reason: "legacy_recorded_log_not_a_prefix" })]);
      vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
      const offline = await migrateRunEvidence(db, { apply: true, companyId: f.companyId, kinds: ["log"], preserveHistoricalFiles: true });
      vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "false");
      expect(offline.items).toEqual([expect.objectContaining({ id: f.runId, state: "blocked", reason: "legacy_recorded_log_not_a_prefix" })]);
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(row).toMatchObject({ logStore: "local_file", logRef: f.logRef });
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toEqual([]);
    }
  });
});
