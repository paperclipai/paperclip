import { describe, expect, it } from "vitest";
import { activeNativeTurnStarted } from "../stop-redirect-flow.js";
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
  it("retains the bounded command and exact three-run contract", () => {
    expect(STOP_REVISION_WAIT).toContain("sleep 90 exactly once");
    expect(STOP_REVISION_WAIT).toContain("Before changing any file");
    expect(agentJourneyRunCountValid("stop-redirect", 3)).toBe(true);
    for (const count of [0, 1, 2, 4]) expect(agentJourneyRunCountValid("stop-redirect", count)).toBe(false);
  });
});
