import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatRunCompletion, type CompleteHeartbeatRunInput, type HeartbeatRunCompletionDependencies } from "./run-completion.js";
import { findHeartbeatRunCompletionComment, resolveHeartbeatRunResponse } from "../heartbeat-run-summary.js";

beforeEach(() => vi.stubGlobal("fetch", () => { throw new Error("No network in completion truth controls"); }));
afterEach(() => vi.unstubAllGlobals());
const generated = { id: "prepared-comment", body: "Prepared Public report for this response." };
function receipt(disposition = "applied") {
  return { operationId: "register_deliverable", input: { filename: "report.txt" }, result: { commandId: "deliverable-prepared:attachment", disposition, attachmentId: "attachment", entityRefs: ["attachment", "product", generated.id] } };
}
function reader(encoding = "UTF8") {
  const full = { semanticToolReceipts: { file: receipt() }, durableServerMetadata: { marker: "canonical" } };
  const projected = { truncated: true, truncationReason: "oversized_result_json", originalSizeBytes: 132398 };
  const run = { id: "run", companyId: "company", agentId: "agent", status: "running", runtimeMode: "native", contextSnapshot: {} };
  const columns: Record<string, unknown>[] = [];
  const db = { execute: vi.fn(async () => [{ server_encoding: encoding }]), select: vi.fn((selection: Record<string, unknown>) => {
    columns.push(selection);
    const resultJson = selection.resultJson === heartbeatRuns.resultJson ? full
      : encoding === "SQL_ASCII" ? null : projected;
    const q = { from: () => q, where: () => q, then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([{ ...run, resultJson }]).then(resolve) };
    return q;
  }) } as unknown as Db;
  return { db, run, full, projected, columns, state: createHeartbeatRunState(db) };
}
it("completion merges canonical server receipts rather than the oversized display projection", async () => {
  const r = reader(); let patch: Record<string, unknown> | undefined;
  const stop = new Error("Controlled terminal-write boundary: no database mutation");
  const dependencies = {
    getRun: r.state.getRun,
    resolveNormalizedUsageForSession: async () => ({ normalizedUsage: null, derivedFromSessionTotals: false }),
    mergeRunStopMetadataForAgent: (_agent: unknown, _outcome: unknown, value: { resultJson: unknown }) => value.resultJson,
    setRunStatusIfRunning: async (_id: string, _status: string, value: Record<string, unknown>) => { patch = value; throw stop; },
    processRunCancellationSettlements: new Map(), failedProcessRunCancellations: new Map(),
  } as unknown as HeartbeatRunCompletionDependencies;
  const input = { run: r.run, agent: { id: "agent", companyId: "company", adapterType: "process", adapterConfig: {} }, signal: new AbortController().signal,
    issueId: null, issueRef: null, output: { handle: null, outputProgressState: {}, flushOutputProgress: async () => {} },
    session: { runtimeForAdapter: { sessionId: null, sessionDisplayId: null }, previousSessionParams: null, taskKey: null, configuredModel: null },
    sessionCodec: { serialize: (x: unknown) => x, deserialize: (x: unknown) => x }, sessionCompaction: { rotate: false, reason: null },
    adapterResult: { exitCode: 0, signal: null, timedOut: false, summary: "The report is attached; credentials are excluded and must be configured separately.",
      resultJson: { nativeResult: { schema: "paperclip.run_result.v1", summary: "The report is attached; credentials are excluded and must be configured separately." } },
      nativeFinalization: { terminal: { runTerminalState: "succeeded" } } },
    readFailureReportSecrets: () => [], configFreshnessResultMetadata: {}, runLedgerScope: {}, currentUserRedactionOptions: { enabled: false }, providerTraceCapture: false,
  } as unknown as CompleteHeartbeatRunInput;
  await expect(createHeartbeatRunCompletion(r.db, dependencies).completeRun(input)).rejects.toBe(stop);
  const merged = patch!.resultJson as Record<string, unknown>;
  expect(merged.semanticToolReceipts).toEqual(r.full.semanticToolReceipts);
  expect(merged.durableServerMetadata).toEqual(r.full.durableServerMetadata);
  expect(merged.truncated).toBeUndefined();
  expect(resolveHeartbeatRunResponse({ resultJson: merged, existingComment: findHeartbeatRunCompletionComment([generated], merged) }))
    .toMatchObject({ text: input.adapterResult.summary, decision: { commentAction: "create" } });
});
it.each(["UTF8", "SQL_ASCII"])("ordinary %s run reads retain their safe default projection", async encoding => {
  const r = reader(encoding); const result = await r.state.getRun("run");
  const selected = r.columns[0]!.resultJson as SQL.Aliased;
  const sql = new PgDialect().sqlToQuery(selected.sql).sql;
  if (encoding === "UTF8") { expect(sql).toContain("pg_column_size"); expect(result!.resultJson).toEqual(r.projected); }
  else { expect(sql).toBe("NULL"); expect(result!.resultJson).toBeNull(); }
});
it.each(["applied", "duplicate"])("actual %s file receipt does not consume the final answer slot", disposition => {
  const resultJson = { semanticToolReceipts: { file: receipt(disposition) }, nativeResult: { schema: "paperclip.run_result.v1", summary: "Completed explanation with setup prerequisites." } };
  const existing = findHeartbeatRunCompletionComment([generated], resultJson);
  expect(existing).toBeNull(); expect(resolveHeartbeatRunResponse({ resultJson, existingComment: existing })).toMatchObject({ text: resultJson.nativeResult.summary, decision: { commentAction: "create" } });
  const final = { id: "explicit", body: "An intentional final reply." };
  expect(findHeartbeatRunCompletionComment([generated, final], resultJson)).toEqual(final);
  expect(findHeartbeatRunCompletionComment([generated], {})).toEqual(generated);
});
