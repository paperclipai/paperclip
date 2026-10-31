import { randomBytes, randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { readReleaseRun } from "./release-run-read.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("wake release run reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("wake-release-read-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Wake release fixture", issuePrefix: "WRR" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Release agent", adapterType: "process" }).returning();
    companyId = company.id;
    agentId = agent.id;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  it("omits native bulk at the driver boundary and preserves the complete legacy fallback", async () => {
    const bulk = randomBytes(128 * 1024).toString("base64");
    const context = { issueId: randomUUID(), opaqueFutureContext: { savedInput: "keep this input" }, explicitUserContinuation: true };
    const evidence = { nativeCancellation: { schema: "paperclip.native-cancellation.v1", acknowledged: true }, unknownFutureReceipt: [true, null, 42] };
    const [before] = await db.insert(heartbeatRuns).values({
      companyId, agentId, runtimeMode: "native", status: "running", contextSnapshot: context,
      runnerProfileJson: { nativeExecutionInput: { savedInput: bulk } }, stdoutExcerpt: bulk, stderrExcerpt: bulk,
      resultJson: { ...evidence, stdout: bulk, stderr: bulk },
    }).returning();
    const scope = { companyId, runId: before.id };
    const events: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
    try {
      const native = await db.transaction(tx => readReleaseRun(tx as unknown as typeof db, scope));
      expect(native.kind).toBe("native");
      expect(native.run?.contextSnapshot).toEqual(context);
      expect(native.run?.resultJson).toEqual(evidence);
      expect(native.run).not.toHaveProperty("runnerProfileJson");
      expect(native.run).not.toHaveProperty("stdoutExcerpt");
      expect(native.run).not.toHaveProperty("stderrExcerpt");
    } finally { capture.flush(); }
    const summary = events.find(event => event.event === "paperclip.db_response_capture.summary.v1")!;
    expect(summary.completedQueries).toBe(1);
    expect(summary.responseValueBytes).toBeLessThan(8192);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, before.id)))[0]).toEqual(before);
    expect(JSON.stringify(events)).not.toContain(bulk.slice(0, 64));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, before.id));
    const legacy = await readReleaseRun(db, scope);
    expect(legacy.kind).toBe("complete");
    expect(legacy.run).toEqual({ ...before, runtimeMode: "legacy", resultJson: evidence });
    expect((await readReleaseRun(db, { ...scope, companyId: randomUUID() })).run).toBeUndefined();
    expect((await readReleaseRun(db, { companyId, runId: randomUUID() })).run).toBeUndefined();
  });

  it.each([null, ["stdout", { stderr: "evidence" }], "scalar", 42].map(result => ({ result })))(
    "preserves non-object native result evidence $result", async ({ result }) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "native",
        resultJson: result as Record<string, unknown> | null }).returning();
      expect((await readReleaseRun(db, { companyId, runId: run.id })).run?.resultJson).toEqual(result);
    },
  );

  it("keeps launch text in storage while releasing native runs with their control context", async () => {
    const bulk = randomBytes(128 * 1024).toString("base64");
    const context = {
      issueId: randomUUID(), taskId: randomUUID(), taskKey: "saved-task",
      retryReason: "execution_review_participant_recovery", wakeReason: "issue_commented",
      explicitUserContinuation: true,
      interactionId: randomUUID(), interactionKind: "review", interactionStatus: "resolved",
      wakeCommentIds: [randomUUID()], queuedCommentSourceWakeIds: [randomUUID()],
      chatConversationId: randomUUID(), executionPolicy: { requireApproval: true },
      opaqueFutureContext: { retained: [null, false, "input"] },
    };
    const launch = {
      executionContinuation: { instruction: bulk, state: "saved" },
      paperclipWake: { savedTask: bulk }, paperclipWakeComment: bulk, paperclipTaskMarkdown: bulk,
      paperclipTaskMarkdownCompact: bulk, paperclipTaskMarkdownAssignment: bulk,
      paperclipTaskMarkdownAssignmentCompact: bulk, paperclipWorkspace: { files: bulk },
      paperclipEnvironment: { input: bulk }, paperclipContinuationSummary: bulk,
    };
    const evidence = { nativeCancellation: { schema: "paperclip.native-cancellation.v1", dispatched: true },
      executionCancellation: { state: "acknowledged" }, workspaceRestoreRecovery: { leaseIds: [randomUUID()] },
      configurationIncomplete: { reason: "secret_binding_missing" }, unknownFutureReceipt: { retained: true } };
    const [before] = await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "native",
      contextSnapshot: { ...context, ...launch }, resultJson: evidence }).returning();
    const events: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
    let selected: Awaited<ReturnType<typeof readReleaseRun>>;
    try { selected = await db.transaction(tx => readReleaseRun(tx as unknown as typeof db, { companyId, runId: before.id })); }
    finally { capture.flush(); }
    const summary = events.find(event => event.event === "paperclip.db_response_capture.summary.v1")!;
    expect(summary.completedQueries).toBe(1);
    expect(summary.responseValueBytes).toBeLessThan(8192);
    expect(selected!.run?.contextSnapshot).toEqual(context);
    expect(selected!.run?.resultJson).toEqual(evidence);
    expect(JSON.stringify(events)).not.toContain(bulk.slice(0, 64));
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, before.id)))[0]).toEqual(before);
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, before.id));
    expect((await readReleaseRun(db, { companyId, runId: before.id })).run?.contextSnapshot).toEqual(before.contextSnapshot);
  });

  it.each([null, ["paperclipWake", { savedInput: "keep" }], "scalar", 42].map(context => ({ context })))(
    "preserves non-object native context $context", async ({ context }) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "native",
        contextSnapshot: context as Record<string, unknown> | null }).returning();
      expect((await readReleaseRun(db, { companyId, runId: run.id })).run?.contextSnapshot).toEqual(context);
    },
  );
});
