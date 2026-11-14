import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableRecoveryIdentity, PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { createNativeRecoveryUsageDelivery } from "./native-recovery-usage-delivery.js";

const accounting = vi.hoisted(() => ({ open: vi.fn(), capture: vi.fn() }));
vi.mock("./native-usage-delivery.js", () => ({ createNativeUsageContinuationDelivery: accounting.open }));
beforeEach(() => { vi.clearAllMocks(); accounting.capture.mockResolvedValue(undefined); accounting.open.mockResolvedValue({ capture: accounting.capture }); });

function fixture() {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID();
  const source: DurableRecoveryIdentity = { runId: randomUUID(), runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(),
    normalizedSessionId: sessionId, turnId: randomUUID(), itemId: randomUUID() };
  const build = (runId: string) => buildNativeExecutionInput({ companyId, agentId, runId, normalizedSessionId: sessionId,
    provider: "codex", issue: { id: issueId, identifier: "REC-1", title: "Continue", description: null, workMode: "standard" },
    taskPrompt: "Continue once", workspace: { id: randomUUID(), cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
      contract: { revision: "1", objective: "Continue", criteria: [{ id: "objective", requirement: "Preserve the result" }] } },
    runtimeContext: nativeRuntimeContextFixture() });
  const execution = build(randomUUID()), previous = build(source.runId);
  const row = { run: { status: "succeeded", finishedAt: new Date() as Date | null, runtimeMode: "native", runnerInstanceId: source.runnerInstanceId,
    nativeSessionId: sessionId, runnerProfileJson: { nativeExecutionInput: previous } },
    owner: { phase: "committed", resultId: randomUUID() as string | null, leaseOwner: null as string | null, companyId, issueId } };
  const where = vi.fn(async (_predicate: SQL) => [row]);
  const select = vi.fn(() => ({ from: () => ({ innerJoin: () => ({ where }) }) }));
  const db = { select } as unknown as Db;
  const matchesExecution = vi.fn(() => true);
  const deliver = () => createNativeRecoveryUsageDelivery({ db, execution, sourceIdentity: { ...source }, matchesExecution });
  const event: PrpEvent = { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceInstanceId: source.runnerInstanceId,
    sourceEventId: "source-usage", sourceSeq: 1, runId: source.runId, normalizedSessionId: sessionId, turnId: source.turnId,
    eventType: "usage.reported", priority: 0, emittedAt: new Date().toISOString(), payload: {} };
  return { source, execution, previous, row, select, where, matchesExecution, deliver, event };
}

describe("source accounting recovery authority", () => {
  it("pins the relational source tuple and hydrates once without binding target accounting", async () => {
    const f = fixture(), deliver = f.deliver();
    await deliver(f.event, f.source);
    await deliver({ ...f.event, sourceEventId: "source-terminal", sourceSeq: 2, eventType: "turn.completed" }, f.source);
    expect(f.select).toHaveBeenCalledOnce();
    expect(new PgDialect().sqlToQuery(f.where.mock.calls[0][0]).params).toEqual([
      f.source.runId, f.execution.binding.companyId, f.execution.binding.agentId, f.execution.binding.issueId,
    ]);
    expect(f.matchesExecution).toHaveBeenCalledWith(f.previous);
    expect(accounting.open).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      companyId: f.execution.binding.companyId, runId: f.source.runId, runnerInstanceId: f.source.runnerInstanceId, provider: f.previous.provider,
    });
    expect(accounting.capture).toHaveBeenCalledTimes(2);
    expect(accounting.capture).toHaveBeenCalledWith(f.event);
  });

  it.each(["runId", "runnerInstanceId", "environmentLeaseId", "normalizedSessionId", "turnId", "itemId"] as const)(
    "rejects a changed pinned %s before source hydration", async key => {
      const f = fixture();
      await expect(f.deliver()(f.event, { ...f.source, [key]: randomUUID() })).rejects.toThrow("native_recovery_usage_source_unproven");
      expect(f.select).not.toHaveBeenCalled();
      expect(accounting.open).not.toHaveBeenCalled();
    });

  it.each(["runId", "sourceInstanceId", "normalizedSessionId"] as const)("rejects mismatched event %s before source hydration", async key => {
    const f = fixture();
    await expect(f.deliver()({ ...f.event, [key]: randomUUID() }, f.source)).rejects.toThrow("native_recovery_usage_source_unproven");
    expect(f.select).not.toHaveBeenCalled();
  });

  it.each(["nonterminal", "unfinished", "uncommitted", "no-result", "held", "company", "issue", "scope"])(
    "keeps an unproven source held: %s", async change => {
      const f = fixture();
      if (change === "nonterminal") f.row.run.status = "running";
      if (change === "unfinished") f.row.run.finishedAt = null;
      if (change === "uncommitted") f.row.owner.phase = "observed";
      if (change === "no-result") f.row.owner.resultId = null;
      if (change === "held") f.row.owner.leaseOwner = "live-owner";
      if (change === "company") f.row.owner.companyId = randomUUID();
      if (change === "issue") f.row.owner.issueId = randomUUID();
      if (change === "scope") f.matchesExecution.mockReturnValue(false);
      await expect(f.deliver()(f.event, f.source)).rejects.toThrow("native_recovery_usage_source_unproven");
      expect(accounting.open).not.toHaveBeenCalled();
      expect(accounting.capture).not.toHaveBeenCalled();
    });

  it("keeps a durable source receipt failure unacknowledged", async () => {
    const f = fixture();
    accounting.capture.mockRejectedValue(new Error("native_usage_after_finalization_requires_reconciliation"));
    await expect(f.deliver()(f.event, f.source)).rejects.toThrow("native_usage_after_finalization_requires_reconciliation");
  });
});
