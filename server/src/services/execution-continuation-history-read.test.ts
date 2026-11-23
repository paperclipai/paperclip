import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, applyPendingMigrations, companies, createDb, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { buildExecutionContinuation } from "./execution-continuation.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_EXECUTION_CONTINUATION_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("continuation history PostgreSQL projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    if (externalUrl) {
      await applyPendingMigrations(externalUrl);
      database = { connectionString: externalUrl, cleanup: async () => {} };
    } else database = await startEmbeddedPostgresTestDatabase("continuation-history-read-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(result: unknown) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "History", issuePrefix: `H${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue", status: "in_progress", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", errorCode: "adapter_failed",
      contextSnapshot: { issueId }, createdAt: new Date("2020-01-01T00:00:00Z"), resultJson: result as Record<string, unknown> | null }).returning();
    return { companyId, agentId, issueId, run };
  }

  async function invoke(f: Awaited<ReturnType<typeof fixture>>, fullResult: boolean, context: Record<string, unknown> = {}) {
    const reads: Array<Array<Record<string, unknown>>> = [];
    const recorded = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const historyRead = Object.hasOwn(fields[0] ?? {}, "retryOfRunId");
        const builder = historyRead && fullResult
          ? target.select({ ...fields[0], result: heartbeatRuns.resultJson }) : target.select(...fields);
        const from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const query = from(...args), execute = query.execute.bind(query);
          if (historyRead) query.execute = async (...executeArgs: Parameters<typeof execute>) => {
            const rows = await execute(...executeArgs); reads.push(rows); return rows;
          };
          return query;
        }) as typeof builder.from;
        return builder;
      };
    }});
    const result = await buildExecutionContinuation({ db: recorded, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, context, summary: null, exposeLowTrustRaw: false });
    return { result, reads };
  }

  async function compare(f: Awaited<ReturnType<typeof fixture>>, context: Record<string, unknown> = {}) {
    const before = await invoke(f, true, context), after = await invoke(f, false, context);
    expect(after.result).toEqual(before.result);
    expect(after.reads).toHaveLength(1);
    expect(after.reads[0].map(({ result: _result, ...fields }) => fields)).toEqual(before.reads[0].map(({ result: _result, ...fields }) => fields));
    return { before, after };
  }

  it("keeps every completed receipt, its full result, missing values and receipt order", async () => {
    const payload = randomBytes(128 * 1024).toString("base64");
    const result = { nativeResult: { output: payload }, conversationContinuation: "continue_conversation_v1", apiToolReceipts: {
      "10": { state: "completed", operationId: "ten", result: null, unusedRequest: payload },
      "2": { state: "completed", operationId: "two", result: { nested: [payload, false, null] } },
      missing: { state: "completed", operationId: "" },
      pending: { state: "started", operationId: "pending", result: payload },
      invalid: { state: "completed", operationId: 42, result: payload },
      array: ["completed", "operation"],
      scalar: "completed", number: 42, null: null,
    } };
    const f = await fixture(result), { before, after } = await compare(f);
    assert.ok(after.result.completedActions);
    expect(after.result.completedActions.map(receipt => receipt.receiptId)).toEqual(["2", "10", "missing"]);
    expect(after.result.completedActions[0].result).toEqual(result.apiToolReceipts["2"].result);
    expect(after.result.completedActions[1].result).toBeNull();
    expect(after.result.completedActions[2].result).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(after.reads))).toBeLessThan(Buffer.byteLength(JSON.stringify(before.reads)) / 2);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].resultJson).toEqual(result);
  });

  const recovery = { schema: "paperclip.workspace-restore-recovery.v1" };
  it.each([
    { value: null, interrupted: false }, { value: [], interrupted: false }, { value: "scalar", interrupted: false }, { value: 42, interrupted: false },
    { value: {}, interrupted: false }, { value: { conversationContinuation: "continue_conversation_v1", apiToolReceipts: [1, 2] }, interrupted: true },
    { value: { conversationContinuation: 42, apiToolReceipts: "malformed" }, interrupted: false },
    ...["restore_permission_denied", "restore_lock_timeout", "restore_unsafe_archive", "restore_failed"].map(workspaceRestoreFailure => ({
      value: { conversationContinuation: "continue_conversation_v1", workspaceRestoreFailure, workspaceRestoreRecovery: recovery }, interrupted: false,
    })),
    { value: { conversationContinuation: "continue_conversation_v1", workspaceRestoreFailure: "restore_unsafe_archive" }, interrupted: false },
    { value: { conversationContinuation: "continue_conversation_v1", workspaceRestoreFailure: "custom", workspaceRestoreRecovery: recovery }, interrupted: true },
    ...[null, [], "schema", { schema: 42 }, { schema: "other" }].map(workspaceRestoreRecovery => ({
      value: { conversationContinuation: "continue_conversation_v1", workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery }, interrupted: true,
    })),
  ])("keeps continuation/recovery decisions for typed legacy JSON $value", async ({ value, interrupted }) => {
    const f = await fixture(value), { after } = await compare(f);
    expect(after.result.interruptedRunId).toBe(interrupted ? f.run.id : undefined);
    expect(after.result.completedActions).toEqual([]);
  });

  it("keeps full ordered history and source-agent scope without cross-company or cross-task receipts", async () => {
    const completed = (operationId: string) => ({ apiToolReceipts: { saved: { state: "completed", operationId, result: { operationId } } } });
    const f = await fixture({ ...completed("first"), conversationContinuation: "continue_conversation_v1" });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId: f.companyId, name: "Previous owner", adapterType: "paperclip_runner" });
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: otherAgentId, status: "succeeded",
      contextSnapshot: { issueId: f.issueId }, resultJson: completed("other-agent"), createdAt: new Date("2020-01-01T00:01:00Z") }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "cancelled", errorCode: "execution_reconciliation_required",
      contextSnapshot: { issueId: f.issueId }, resultJson: completed("cancelled"), createdAt: new Date("2020-01-01T00:02:00Z") });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed",
      contextSnapshot: { issueId: randomUUID() }, resultJson: completed("foreign-task") });
    const foreign = await fixture(completed("foreign-company"));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId } }).where(eq(heartbeatRuns.id, foreign.run.id));
    const ordinary = await compare(f);
    assert.ok(ordinary.after.result.completedActions);
    expect(ordinary.after.result.completedActions.map(receipt => receipt.operationId)).toEqual(["first", "cancelled"]);
    expect(ordinary.after.result.interruptedRunId).toBe(f.run.id);
    const resumed = await compare(f, { previousRunId: source.id });
    assert.ok(resumed.after.result.completedActions);
    expect(resumed.after.result.completedActions.map(receipt => receipt.operationId)).toEqual(["first", "other-agent", "cancelled"]);
    expect(resumed.after.result.interruptedRunId).toBeUndefined();
  });
});
