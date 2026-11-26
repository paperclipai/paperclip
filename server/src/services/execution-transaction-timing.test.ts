import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { companies, createDb, executionWorkspaces, issueComments, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { measureRunTransaction } from "./execution-transaction-timing.js";
import { withRunExecutionTiming } from "./execution-preparation-timing.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { lockExecutionWorkspaceRootProvenance } from "./execution-workspace-repositories.js";
import { assertTaskWorkspaceAccess } from "./task-workspace-source-access.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("execution timing with real database waits", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string, workspaceId: string;
  let exporter: InMemorySpanExporter, provider: TracerProvider, manager: AsyncLocalStorageContextManager;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-execution-timing-");
    db = createDb(temporary.connectionString);
    const [company] = await db.insert(companies).values({ name: "Timing fixture", issuePrefix: "TIME" }).returning();
    companyId = company.id;
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Files", mode: "shared_workspace", strategyType: "task_directory" }).returning();
    workspaceId = workspace.id;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  beforeEach(() => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    exporter = new InMemorySpanExporter();
    provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    manager = new AsyncLocalStorageContextManager().enable();
    expect(context.setGlobalContextManager(manager)).toBe(true);
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    trace.disable(); context.disable(); manager.disable();
    await provider.shutdown();
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it.each(["advisory", "row"] as const)("attributes a controlled %s lock wait to its leaf and commits the original update", async kind => {
    let release!: () => void, acquired!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const blocker = db.transaction(async tx => {
      if (kind === "advisory") await lockExecutionWorkspaceRootProvenance(tx, companyId);
      else await tx.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)).for("update");
      acquired();
      await released;
    });
    await ready;
    const update = withRunExecutionTiming(`wait-${kind}`, () => executionWorkspaceService(db).update(workspaceId, { metadata: { verified: kind } }));
    try {
      await vi.waitFor(async () => {
        const pending = await db.execute(sql`select count(*)::int as count from pg_locks where not granted and locktype = ${kind === "advisory" ? "advisory" : "transactionid"}`);
        expect(pending[0]?.count).toBeGreaterThan(0);
      });
      expect(exporter.getFinishedSpans().some(span => span.name === (kind === "advisory" ? "workspace.provenance_lock" : "workspace.row_lock"))).toBe(false);
    } finally {
      release();
      await blocker;
      await update;
    }
    const [saved] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    expect(saved.metadata).toMatchObject({ verified: kind });
    const spans = exporter.getFinishedSpans();
    const transaction = spans.find(span => span.name === "workspace.transaction")!;
    const wait = spans.find(span => span.name === (kind === "advisory" ? "workspace.provenance_lock" : "workspace.row_lock"))!;
    expect(wait.parentSpanContext?.spanId).toBe(transaction.spanContext().spanId);
    expect(wait.duration[0] * 1e9 + wait.duration[1]).toBeGreaterThan(0);
    expect(spans.map(span => span.name)).toEqual(expect.arrayContaining(["workspace.transaction.entry", "workspace.transaction.commit", "workspace.notification", "workspace.write"]));
    expect(spans.some(span => span.name === "workspace.transaction.rollback")).toBe(false);
    expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain(workspaceId);
  });

  it("preserves transaction rollback and the original error without replaying writes", async () => {
    const [before] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    const failure = new Error("private rollback fixture");
    let calls = 0;
    await expect(withRunExecutionTiming("rollback", () => measureRunTransaction(db, "workspace", async tx => {
      calls++;
      await tx.update(executionWorkspaces).set({ metadata: { rolledBack: true } }).where(eq(executionWorkspaces.id, workspaceId));
      throw failure;
    }))).rejects.toBe(failure);
    expect(calls).toBe(1);
    const [after] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    expect(after.metadata).toEqual(before.metadata);
    const spans = exporter.getFinishedSpans();
    expect(spans.find(span => span.name === "workspace.transaction.rollback")?.status.code).toBe(2);
    expect(spans.some(span => span.name === "workspace.transaction.commit")).toBe(false);
    expect(JSON.stringify(spans.map(span => ({ attributes: span.attributes, events: span.events })))).not.toContain(failure.message);
  });

  it("records durable response commit and server publication under the same attempt", async () => {
    const [issue] = await db.insert(issues).values({ companyId, title: "Response timing" }).returning();
    const body = "Private response fixture";
    const comment = await withRunExecutionTiming("response", async () => {
      const saved = await issueService(db).addComment(issue.id, body, { userId: "local-board" });
      await logActivity(db, { companyId, actorType: "user", actorId: "local-board", action: "issue.comment_added", entityType: "issue", entityId: issue.id });
      return saved;
    });
    const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, comment.id));
    expect(stored.body).toBe(body);
    const spans = exporter.getFinishedSpans();
    const attempt = spans.find(span => span.name === "task.execution_attempt")!;
    const transaction = spans.find(span => span.name === "response.transaction")!;
    const commit = spans.find(span => span.name === "response.transaction.commit")!;
    expect(transaction.parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
    expect(commit.parentSpanContext?.spanId).toBe(transaction.spanContext().spanId);
    expect(spans.map(span => span.name)).toEqual(expect.arrayContaining(["response.row_lock", "response.write", "execution.realtime"]));
    expect(spans.every(span => span.spanContext().traceId === attempt.spanContext().traceId)).toBe(true);
    expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain(body);
  });

  it("preserves a real access denial and exports only failed status", async () => {
    await expect(withRunExecutionTiming("denied", () => assertTaskWorkspaceAccess(db,
      { type: "board", userId: "not-a-company-member" }, companyId, workspaceId,
    ))).rejects.toMatchObject({ status: 403 });
    const spans = exporter.getFinishedSpans();
    expect(spans.find(span => span.name === "task.execution_attempt")?.status.code).toBe(2);
    expect(JSON.stringify(spans.map(span => ({ attributes: span.attributes, events: span.events })))).not.toContain("not-a-company-member");
  });
});
