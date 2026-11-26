import { describe, expect, it } from "vitest";
import { activeNativeTurnStarted, nativeCancellationHasNoLaterWork, nativeWorkEvents } from "../stop-redirect-flow.js";
import { activeStopWorkBoundary, stoppedRunAccountingFinalized, STOP_REVISION_WAIT } from "./stop-redirect-evidence.js";
import { agentJourneyRunCountValid } from "./success-contract.js";

type Row = Record<string, any>;
const run = { id: "run", companyId: "company", agentId: "agent", nativeIssueId: "issue", runtimeMode: "native", status: "running",
  usageJson: { accountingReceiptSourceId: "receipt-source", accountingReceiptSequence: 5, accountingReceiptReady: false } };
function event(seq: number, eventType: string, payload = {}, turnId = "turn"): Row {
  return { seq, eventType, runId: run.id, companyId: run.companyId, agentId: run.agentId,
    protocolSchemaVersion: 1, sourceEventId: `event-${seq}`, sourceInstanceId: "runner", sourceSeq: seq,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, eventType, runId: run.id, turnId,
      sourceKind: "runner", sourceEventId: `event-${seq}`, sourceInstanceId: "runner", sourceSeq: seq, payload: structuredClone(payload) } } };
}
const command = { schema: "paperclip.tool.execution.v1", executionId: "sleep", transport: "builtin", operation: "unknown",
  name: "bash", namespace: null, readOnly: false, status: "running" };
const usage = { kind: "usage", usage: { runDeltaComplete: true, runDelta: { inputTokens: 120, outputTokens: 10 } } };
const events = () => [event(1, "turn.started"), event(2, "item.completed", usage), event(3, "tool.execution.started", command)];
const before = () => activeStopWorkBoundary(run, events())!;
const settled = () => ({ ...structuredClone(run), status: "cancelled", costAccountingPending: false,
  finishedAt: "2026-01-01T00:00:01Z", costAccountedAt: "2026-01-01T00:00:02Z",
  usageJson: { ...run.usageJson, accountingReceiptReady: true, accountingReceiptId: "receipt", accountingReceiptSequence: 6 } });

describe("Stop work and redirect admission evidence", () => {
  it("rejects the observed startup-only incident before and after cancellation", () => {
    // Closed event metadata only. Synthetic identities replace the private run.
    // The observed stream had93 contiguous rows and no usage or command event.
    const rows: Row[] = Array.from({ length: 93 }, (_, i) => ({ seq: i + 1, eventType: "adapter.message" }));
    rows[73] = event(74, "turn.started");
    rows[77] = event(78, "turn.accepted");
    rows[79] = event(80, "item.completed", { kind: "interrupt_acknowledgement" });
    rows[81] = event(82, "turn.cancelled");
    expect(activeNativeTurnStarted(run, rows.slice(0, 79))).toBe(true);
    expect(activeStopWorkBoundary(run, rows.slice(0, 79))).toBeNull();
    expect(activeStopWorkBoundary({ ...run, status: "cancelled" }, rows)).toBeNull();
  });
  it("requires the same current native turn's genuine usage and still-active command", () => {
    expect(before()).toMatchObject({ runId: "run", executionId: "sleep", turnId: "turn", usageSeq: 2,
      accountingSourceId: "receipt-source", accountingSequence: 5 });
    const missing = [events().slice(0, 1), [event(1, "turn.started"), event(2, "tool.execution.started", command)],
      [event(1, "turn.started"), event(2, "item.completed", usage)],
      [...events(), event(4, "tool.execution.completed", { ...command, status: "completed" })],
      [...events(), event(4, "turn.started", {}, "new-turn")], [...events(), event(4, "turn.cancelled")]];
    for (const rows of missing) expect(activeStopWorkBoundary(run, rows)).toBeNull();
  });
  it("does not Stop a hold whose first usage report arrives only after the command ends", () => {
    const rows = [event(1, "turn.started"), event(2, "tool.execution.started", command),
      event(3, "tool.execution.progressed", command), event(4, "tool.execution.completed", { ...command, status: "completed" }),
      event(5, "item.completed", { kind: "usage" }), event(6, "item.completed", usage), event(7, "turn.completed")];
    for (let end = 1; end <= rows.length; end++) expect(activeStopWorkBoundary(run, rows.slice(0, end))).toBeNull();
    expect(activeStopWorkBoundary({ ...run, status: "succeeded" }, rows)).toBeNull();
  });
  it("observes complete readiness usage and a separate still-active hold in the same turn", () => {
    const ready = { ...command, executionId: "readiness" };
    const rows = [event(1, "turn.started"), event(2, "tool.execution.started", ready),
      event(3, "tool.execution.completed", { ...ready, status: "completed" }), event(4, "item.completed", { kind: "usage" }),
      event(5, "item.completed", usage), event(6, "tool.execution.started", command)];
    for (let end = 1; end < rows.length; end++) expect(activeStopWorkBoundary(run, rows.slice(0, end))).toBeNull();
    expect(activeStopWorkBoundary(run, rows)).toMatchObject({ executionId: "sleep", startedSeq: 6, usageSeq: 5, turnId: "turn" });
    expect(activeStopWorkBoundary(run, [...rows, event(7, "tool.execution.completed", { ...command, status: "completed" })])).toBeNull();
  });
  it.each(["foreign-company", "foreign-agent", "foreign-run", "foreign-turn", "foreign-runner", "bad-source", "bad-envelope",
    "partial", "missing-count", "negative-count", "fractional-count", "placeholder-zero", "session-total", "semantic-tool", "read-only"])("rejects %s proof", kind => {
    const rows = events(), row = rows[1]!, envelope = row.payload.prpEvent;
    if (kind === "foreign-company") row.companyId = "foreign";
    if (kind === "foreign-agent") row.agentId = "foreign";
    if (kind === "foreign-run") { row.runId = "foreign"; envelope.runId = "foreign"; }
    if (kind === "foreign-turn") envelope.turnId = "old-turn";
    if (kind === "foreign-runner") { row.sourceInstanceId = "foreign"; envelope.sourceInstanceId = "foreign"; }
    if (kind === "bad-source") row.sourceSeq++;
    if (kind === "bad-envelope") row.protocolSchemaVersion = 2;
    if (kind === "partial") envelope.payload.usage.runDeltaComplete = false;
    if (kind === "missing-count") delete envelope.payload.usage.runDelta.outputTokens;
    if (kind === "negative-count") envelope.payload.usage.runDelta.outputTokens = -1;
    if (kind === "fractional-count") envelope.payload.usage.runDelta.outputTokens = 1.5;
    if (kind === "placeholder-zero") envelope.payload.usage.runDelta = { inputTokens: 0, outputTokens: 0 };
    if (kind === "session-total") envelope.payload.usage.usageBasis = "session_cumulative";
    if (kind === "semantic-tool") rows[2]!.payload.prpEvent.payload = { ...command, name: "paperclip_finish" };
    if (kind === "read-only") rows[2]!.payload.prpEvent.payload = { ...command, readOnly: true };
    expect(activeStopWorkBoundary(run, rows)).toBeNull();
  });
  it("rejects stale usage from before the current turn, even with a live command", () => {
    const rows = [event(1, "item.completed", usage, "old-turn"), event(2, "turn.started"), event(3, "tool.execution.started", command)];
    expect(activeStopWorkBoundary(run, rows)).toBeNull();
    expect(activeStopWorkBoundary(run, [event(1, "turn.started", {}, "old-turn"), event(2, "item.completed", usage, "old-turn"),
      event(3, "turn.started"), event(4, "tool.execution.started", command, "old-turn")])).toBeNull();
    expect(activeStopWorkBoundary(run, [...events(), event(4, "item.completed", { kind: "usage", usage: {
      ...usage.usage, runDeltaComplete: false,
    } })])).toBeNull();
  });
  it("requires the stopped run's settled API receipt without assuming controller or clock order", () => {
    expect(stoppedRunAccountingFinalized(settled(), before())).toBe(true);
    const reconciled = settled();
    Object.assign(reconciled.usageJson, { accountingReceiptSourceId: "reconciled-source", accountingReceiptSequence: 5 });
    reconciled.costAccountedAt = "2026-01-01T00:00:00Z";
    expect(stoppedRunAccountingFinalized(reconciled, before())).toBe(true);
    const changes: Array<(r: Row) => void> = [r => { r.id = "foreign"; }, r => { r.companyId = "foreign"; },
      r => { r.agentId = "foreign"; }, r => { r.nativeIssueId = "foreign"; }, r => { r.runtimeMode = "legacy"; },
      r => { r.status = "succeeded"; }, r => { r.costAccountingPending = true; }, r => { delete r.costAccountingPending; },
      r => { r.costAccountedAt = null; }, r => { r.costAccountedAt = "invalid"; },
      r => { r.usageJson.accountingReceiptReady = false; }, r => { delete r.usageJson.accountingReceiptId; },
      r => { delete r.usageJson.accountingReceiptSourceId; }, r => { r.usageJson.accountingReceiptSequence = 0; }];
    for (const change of changes) { const r = settled(); change(r); expect(stoppedRunAccountingFinalized(r, before())).toBe(false); }
  });
  it("accepts a previously ready receipt only when the exact stopped run is actually settled", () => {
    const ready = { ...structuredClone(run), usageJson: { ...run.usageJson,
      accountingReceiptReady: true, accountingReceiptId: "existing-receipt" } };
    const boundary = activeStopWorkBoundary(ready, events())!;
    expect(boundary).not.toBeNull();
    const cancelled = { ...ready, status: "cancelled", costAccountingPending: false,
      costAccountedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z" };
    expect(stoppedRunAccountingFinalized(cancelled, boundary)).toBe(true);
    for (const patch of [{ status: "running" }, { costAccountingPending: true },
      { costAccountedAt: null }, { usageJson: { ...ready.usageJson, accountingReceiptReady: false } }]) {
      expect(stoppedRunAccountingFinalized({ ...cancelled, ...patch }, boundary)).toBe(false);
    }
  });
  it("permits canonical usage at either snapshot without changing the productive work history", () => {
    const stopped = [...events(), event(4, "turn.cancelled")];
    const accounted = [...stopped, event(5, "item.completed", usage)];
    for (const rows of [stopped, accounted]) expect(nativeCancellationHasNoLaterWork(rows, before())).toBe(true);
    expect(nativeWorkEvents(accounted, before())).toEqual(nativeWorkEvents(stopped, before()));
    expect(nativeWorkEvents([...accounted, event(6, "item.completed", usage)], before())).toEqual(nativeWorkEvents(accounted, before()));
  });
  it.each(["raw", "partial", "complete"].flatMap(kind => [1, 2].map(version => ({ kind, version }))))("permits bound canonical $kind usage in schema$version", ({ kind, version }) => {
    const stopped = [...events(), event(4, "turn.cancelled")];
    const payload = kind === "raw" ? { kind: "usage", item: { type: "usage" }, text: "", channel: "usage" }
      : { kind: "usage", usage: { ...usage.usage, runDeltaComplete: kind === "complete" } };
    const row = event(5, "item.completed", payload);
    row.protocolSchemaVersion = version;
    Object.assign(row.payload.prpEvent, { schema: `paperclip.prp.event.v${version}`, schemaVersion: version });
    expect(nativeCancellationHasNoLaterWork([...stopped, row], before())).toBe(true);
    expect(nativeWorkEvents([...stopped, row], before())).toEqual(nativeWorkEvents(stopped, before()));
  });
  it.each(["raw", "partial", "complete"])("permits self-consistent %s billing from a new accounting source", kind => {
    const stopped = [...events(), event(4, "turn.cancelled")];
    const payload = kind === "raw" ? { kind: "usage", item: { type: "usage" } }
      : { kind: "usage", usage: { ...usage.usage, runDeltaComplete: kind === "complete" } };
    const row = event(5, "item.completed", payload);
    row.sourceInstanceId = row.payload.prpEvent.sourceInstanceId = "reconciler";
    expect(nativeCancellationHasNoLaterWork([...stopped, row], before())).toBe(true);
    expect(nativeWorkEvents([...stopped, row], before())).toEqual(nativeWorkEvents(stopped, before()));
  });
  it.each(["row-company", "row-agent", "row-run", "envelope-run", "row-instance", "envelope-instance", "missing-instance", "empty-instance",
    "source-event", "missing-source-event", "row-source-event", "source-sequence", "missing-sequence", "zero-sequence", "fractional-sequence", "source-kind"])("does not discard usage with an unbound %s", kind => {
    const stopped = [...events(), event(4, "turn.cancelled")], row = event(5, "item.completed", usage), envelope = row.payload.prpEvent;
    if (kind === "row-company") row.companyId = "foreign";
    if (kind === "row-agent") row.agentId = "foreign";
    if (kind === "row-run") row.runId = "foreign";
    if (kind === "envelope-run") envelope.runId = "foreign";
    if (kind === "row-instance") row.sourceInstanceId = "foreign";
    if (kind === "envelope-instance") envelope.sourceInstanceId = "foreign";
    if (kind === "missing-instance") delete envelope.sourceInstanceId;
    if (kind === "empty-instance") row.sourceInstanceId = envelope.sourceInstanceId = "";
    if (kind === "source-event") envelope.sourceEventId = "foreign";
    if (kind === "missing-source-event") delete envelope.sourceEventId;
    if (kind === "row-source-event") delete row.sourceEventId;
    if (kind === "source-sequence") envelope.sourceSeq++;
    if (kind === "missing-sequence") delete row.sourceSeq;
    if (kind === "zero-sequence") row.sourceSeq = envelope.sourceSeq = 0;
    if (kind === "fractional-sequence") row.sourceSeq = envelope.sourceSeq = 1.5;
    if (kind === "source-kind") envelope.sourceKind = "server";
    expect(nativeCancellationHasNoLaterWork([...stopped, row], before())).toBe(false);
    expect(nativeWorkEvents([...stopped, row], before())).not.toEqual(nativeWorkEvents(stopped, before()));
  });
  it("keeps usage strict when authoritative current-run context is absent", () => {
    const stopped = [...events(), event(4, "turn.cancelled")], accounted = [...stopped, event(5, "item.completed", usage)];
    expect(nativeCancellationHasNoLaterWork(accounted)).toBe(false);
    expect(nativeWorkEvents(accounted)).not.toEqual(nativeWorkEvents(stopped));
  });
  it.each(["tool.execution.started", "tool.execution.progressed", "turn.started", "message.delta", "item.delta", "item.completed"]
    .flatMap(kind => ["runner", "reconciler"].map(source => ({ kind, source }))))("rejects productive $kind from $source interleaved with post-Stop accounting", ({ kind, source }) => {
    const stopped = [...events(), event(4, "turn.cancelled")];
    const later = [...stopped, event(5, "item.completed", usage), event(6, kind, { kind: "message", text: "continued work" }),
      event(7, "item.completed", usage)];
    later[later.length - 2]!.sourceInstanceId = later[later.length - 2]!.payload.prpEvent.sourceInstanceId = source;
    expect(nativeCancellationHasNoLaterWork(later, before())).toBe(false);
    expect(nativeWorkEvents(later, before())).not.toEqual(nativeWorkEvents(stopped, before()));
  });
  it("does not hide a malformed or differently typed item behind a usage label", () => {
    const stopped = [...events(), event(4, "turn.cancelled")];
    const malformed = event(5, "item.completed", usage); malformed.protocolSchemaVersion = 2;
    const mismatched = event(5, "item.completed", usage); mismatched.eventType = "message.delta";
    for (const row of [malformed, mismatched, event(5, "item.delta", usage), event(5, "message.delta", usage)]) {
      expect(nativeCancellationHasNoLaterWork([...stopped, row], before())).toBe(false);
      expect(nativeWorkEvents([...stopped, row], before())).not.toEqual(nativeWorkEvents(stopped, before()));
    }
  });
  it("retains the bounded command and exact three-run contract", () => {
    expect(STOP_REVISION_WAIT).toContain("printf 'Ready for revision\\n'");
    expect(STOP_REVISION_WAIT).toContain("Wait for that command's result. Then, in a separate shell tool call");
    expect(STOP_REVISION_WAIT.indexOf("printf")).toBeLessThan(STOP_REVISION_WAIT.indexOf("sleep 90"));
    expect(STOP_REVISION_WAIT).toContain("sleep 90 exactly once");
    expect(STOP_REVISION_WAIT).toContain("Before changing any file");
    expect(agentJourneyRunCountValid("stop-redirect", 3)).toBe(true);
    for (const count of [0, 1, 2, 4]) expect(agentJourneyRunCountValid("stop-redirect", count)).toBe(false);
  });
});
