import { randomBytes, randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { readLegacyDispositionSource } from "./legacy-disposition-read.js";
import { recoveryService } from "./service.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("legacy disposition source reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-disposition-read-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Legacy disposition fixture", issuePrefix: "LDF" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Disposition agent", adapterType: "process" }).returning();
    companyId = company.id;
    agentId = agent.id;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  it("declines native input below the byte budget and keeps complete legacy evidence", async () => {
    const issueId = randomUUID(), bulk = randomBytes(128 * 1024).toString("base64");
    const context = { issueId, savedInput: bulk, executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 1 } };
    const [before] = await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "native", status: "succeeded",
      contextSnapshot: context, runnerProfileJson: { savedInput: bulk }, stdoutExcerpt: bulk, stderrExcerpt: bulk,
      errorCode: "adapter_failed", resultJson: { executionRecovery: { providerWorkStarted: true }, stdout: bulk } }).returning();
    const events: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
    try {
      expect(await readLegacyDispositionSource(db, { companyId, issueId, runId: before.id }))
        .toEqual({ kind: "skip", decision: { kind: "skip", reason: "native_finalization" } });
    } finally { capture.flush(); }
    expect(events.at(-1)).toMatchObject({ completedQueries: 1, groups: 1 });
    expect(Number(events.at(-1)?.responseValueBytes)).toBeLessThan(1024);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, before.id)))[0]).toEqual(before);
    expect(JSON.stringify(events)).not.toContain(bulk.slice(0, 64));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, before.id));
    const legacy = await readLegacyDispositionSource(db, { companyId, issueId, runId: before.id });
    expect(legacy.kind).toBe("full");
    if (legacy.kind !== "full") throw new Error("expected complete legacy input");
    expect(legacy.run).toEqual({ ...before, runtimeMode: "legacy" });
    expect((await readLegacyDispositionSource(db, { companyId: randomUUID(), issueId, runId: before.id })))
      .toMatchObject({ kind: "full", run: undefined });
  });

  it.each([
    { context: { issueId: "  target  " }, issueId: "target", reason: "invalid_issue_binding" },
    { context: { issueId: "   ", taskId: "target" }, issueId: "target", reason: "native_finalization" },
    { context: { taskId: " target " }, issueId: "target", reason: "invalid_issue_binding" },
    { context: { issueId: 42, taskId: "target" }, issueId: "target", reason: "native_finalization" },
    { context: { issueId: "other", taskId: "target" }, issueId: "target", reason: "invalid_issue_binding" },
    { context: { issueId: null, taskId: false }, issueId: "target", reason: "invalid_issue_binding" },
    { context: null, issueId: "target", reason: "invalid_issue_binding" },
  ])("keeps native binding decisions for $context", async ({ context, issueId, reason }) => {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "native", contextSnapshot: context }).returning();
    expect(await readLegacyDispositionSource(db, { companyId, issueId, runId: run.id }))
      .toEqual({ kind: "skip", decision: { kind: "skip", reason } });
  });

  it("skips native continuation in SQL without loading or rewriting its saved input", async () => {
    const bulk = randomBytes(128 * 1024).toString("base64");
    const [before] = await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "native", status: "succeeded",
      contextSnapshot: { issueId: randomUUID(), savedInput: bulk }, runnerProfileJson: { savedInput: bulk } }).returning();
    const enqueueWakeup = vi.fn(async () => { throw new Error("native work must not enter legacy recovery"); });
    const service = recoveryService(db, { enqueueWakeup });
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
    try { expect(await service.reconcileLegacyContinuation(before.id)).toBe("skipped"); }
    finally { capture.flush(); }
    expect(events.at(-1)).toMatchObject({ completedQueries: 1, responseValueBytes: 0 });
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, before.id)))[0]).toEqual(before);
  });
});
