import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { bootstrapReadExecutionId, withoutProvenBootstrapReads, type BootstrapReadNotice } from "./native-bootstrap-read-proof.js";
const actionFile = `.paperclip-eval-action-${"a".repeat(36)}.txt`;
const origin: BootstrapReadNotice = { runId: "run", sessionId: "session", turnId: "turn", toolCallId: "tested", stage: "tool", operation: "execute", status: "pending", seq: 20 };
function read(status = "completed", seq = 1): BootstrapReadNotice { return { ...origin, toolCallId: "bootstrap", operation: "read", readTargetSha256: `sha256:${createHash("sha256").update(actionFile).digest("hex")}`, status, seq }; }
function receipt(type = "completed", status = "completed", seq = 2) {
  return { runId: "run", seq, protocolSchemaVersion: 1, eventType: `tool.execution.${type}`, payload: { prpEvent: {
    schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: "run", turnId: "turn", eventType: `tool.execution.${type}`, emittedAt: new Date(seq).toISOString(),
    payload: { schema: "paperclip.tool.execution.v1", executionId: "bootstrap", transport: "builtin", operation: "read", target: actionFile, status },
  } } };
}
it.each(["completed", "failed"])("accepts an exact %s read even when the first native event is terminal", status => {
  expect(withoutProvenBootstrapReads([read(status), origin], origin, { actionFile, events: [receipt("completed", status)] })).toEqual([origin]);
});
it("accepts a complete started/progressed/failed lifecycle, including failed unpublished-file reads", () => {
  const rows = [read("pending", 1), read("in_progress", 3), read("failed", 5), origin];
  const events = [receipt("started", "running", 2), receipt("progressed", "running", 4), receipt("completed", "failed", 6)];
  expect(withoutProvenBootstrapReads(rows, origin, { actionFile, events })).toEqual([origin]);
});
it.each([
  "wrong-target", "missing-target", "foreign-run", "foreign-turn", "foreign-row-run", "wrong-source", "wrong-schema", "wrong-payload", "wrong-transport", "wrong-operation", "wrong-event-type", "invalid-date", "duplicate-row", "duplicate-seq", "conflicting-target", "missing-row", "missing-terminal", "late-row", "unknown-read-origin",
])("rejects %s durable proof", variant => {
  const row = receipt(), rows = [row]; const notices = [read(), origin]; const event = row.payload.prpEvent;
  if (variant === "wrong-target") event.payload.target = "private.txt";
  if (variant === "missing-target") delete (event.payload as any).target;
  if (variant === "foreign-run") event.runId = "other";
  if (variant === "foreign-row-run") row.runId = "other";
  if (variant === "foreign-turn") event.turnId = "other";
  if (variant === "wrong-source") event.sourceKind = "provider";
  if (variant === "wrong-schema") event.schemaVersion = 2;
  if (variant === "wrong-payload") event.payload.schema = "unknown";
  if (variant === "wrong-transport") event.payload.transport = "mcp";
  if (variant === "wrong-operation") event.payload.operation = "edit";
  if (variant === "wrong-event-type") event.eventType = "tool.execution.progressed";
  if (variant === "invalid-date") event.emittedAt = "unknown";
  if (variant === "duplicate-row") rows.push(structuredClone(row));
  if (variant === "duplicate-seq") row.seq = 1;
  if (variant === "conflicting-target") { const other = receipt("completed", "completed", 3); other.payload.prpEvent.payload.target = "foreign.txt"; rows.push(other); }
  if (variant === "missing-row") rows.length = 0;
  if (variant === "missing-terminal") { rows[0] = receipt("started", "running"); notices[0] = read("pending"); }
  if (variant === "late-row") row.seq = 21;
  if (variant === "unknown-read-origin") event.payload.executionId = "unobserved-native-origin";
  expect(() => withoutProvenBootstrapReads(notices, origin, { actionFile, events: rows })).toThrow(/proof/);
});
it("does not exempt unrelated earlier reads or infer a path from a title", () => {
  const unrelated = { ...read(), toolCallId: "private-read", seq: 3 };
  const wrong = receipt("completed", "completed", 4); wrong.payload.prpEvent.payload.executionId = "private-read"; wrong.payload.prpEvent.payload.target = "secrets.txt";
  Object.assign(wrong.payload.prpEvent.payload, { name: `Read ${actionFile}` });
  expect(() => withoutProvenBootstrapReads([read(), unrelated, origin], origin, { actionFile, events: [receipt(), wrong] })).toThrow();
  expect(withoutProvenBootstrapReads([read(), unrelated, origin], origin)).toHaveLength(3);
});
it("rejects reused native IDs, cross-session notices and ambiguous completion ordering", () => {
  for (const notices of [[read(), read("completed", 3), origin], [{ ...read(), sessionId: "other" }, origin], [read(), { ...read(), seq: 30 }, origin]]) {
    expect(() => withoutProvenBootstrapReads(notices, origin, { actionFile, events: [receipt()] })).toThrow();
  }
  expect(() => withoutProvenBootstrapReads([read(), origin], origin, { actionFile: "guessed-nonce.txt", events: [receipt()] })).toThrow();
});
it("preserves later reads and unknown native kinds for the caller's extra-operation rejection", () => {
  for (const n of [{ ...read(), seq: 21 }, { ...read(), operation: undefined }, { ...read(), operation: "edit" }]) {
    expect(withoutProvenBootstrapReads([n, origin], origin, { actionFile, events: [] })).toEqual([n, origin]);
  }
});
it("mirrors stable ASCII bounds and rejects invalid native identities", () => {
  expect(bootstrapReadExecutionId("read:alpha-1")).toBe("read:alpha-1");
  expect(bootstrapReadExecutionId("a".repeat(160))).toBe("a".repeat(160));
  expect(bootstrapReadExecutionId("a".repeat(161))).toBe("acpx-tool-c4b0cf58ad5787f270b446a5eb28905e09d8e0aa06e7f577e27aed951d573406");
  expect(bootstrapReadExecutionId("tool / é")).toBe("acpx-tool-c870bde596691facb0dc508859665ab3ee9de278e7d49adecaab0fa600feaff0");
  expect(bootstrapReadExecutionId("é".repeat(121))).toBe("acpx-tool-9e1e0f61749be86786959ac0384b636ca4b9e00c78e9d77161f0432871edf151");
  for (const id of ["", "a".repeat(241), "read\nnext", "[REDACTED]"]) expect(() => bootstrapReadExecutionId(id)).toThrow();
});

it("accepts omitted terminal path/kind only with the retained single-path origin attestation", () => {
  const started = receipt("started", "running", 2), completed = receipt("completed", "failed", 4);
  Object.assign(completed.payload.prpEvent.payload, { target: null, operation: "unknown" });
  const notices = [read("pending", 1), read("failed", 3), origin], proof = { actionFile, events: [started, completed] };
  expect(withoutProvenBootstrapReads(notices, origin, proof)).toEqual([origin]);
  for (const digest of [undefined, `sha256:${"0".repeat(64)}`]) {
    expect(() => withoutProvenBootstrapReads([{ ...notices[0]!, readTargetSha256: digest }, ...notices.slice(1)], origin, proof)).toThrow();
    expect(() => withoutProvenBootstrapReads([notices[0]!, { ...notices[1]!, readTargetSha256: digest }, origin], origin, proof)).toThrow();
  }
});

it.each(["cursor"] as const)("correlates actual %s passive notices through the public reader and canonical omitted-field updates", async provider => {
  const { createCursorToolEvidence } = await import("../../packages/paperclip-runner/src/drivers/acpx/cursor-tool-evidence.js");
  const { readCursorToolEvidence } = await import("./cursor-native-evidence.js");
  const create = createCursorToolEvidence;
  for (const variant of ["exact", "wrong-path", "multi-path", "ambiguous-update"]) {
    const rows: any[] = [];
    const projector = create({ sessionId: "session", turnId: "turn", workingDirectory: "/workspace", active: () => true,
      emit: event => rows.push({ runId: "run", seq: rows.length * 2 + 1, protocolSchemaVersion: 1, eventType: event.eventType, payload: { prpEvent: {
        schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: "run", turnId: "turn", emittedAt: new Date(1).toISOString(), eventType: event.eventType, payload: event.payload,
      } } }),
    });
    const path = variant === "wrong-path" ? "private.txt" : actionFile;
    projector.tool({ type: "tool_call", tag: "tool_call", toolCallId: "bootstrap", kind: "read", status: "pending", rawInput: variant === "multi-path" ? { paths: [path, "private.txt"] } : { path }, locations: [{ path }] });
    projector.tool({ type: "tool_call", tag: "tool_call_update", toolCallId: "bootstrap", status: "failed", ...(variant === "ambiguous-update" ? { rawInput: { path, paths: [path, "private.txt"] } } : {}) });
    const evaluate = () => {
      const readNotices = readCursorToolEvidence(rows, "run");
      const started = receipt("started", "running", 2), end = receipt("completed", "failed", 4);
      Object.assign(end.payload.prpEvent.payload, { target: null, operation: "unknown" });
      return withoutProvenBootstrapReads([...readNotices, origin], origin, { actionFile, events: [...rows, started, end] });
    };
    if (variant === "exact") expect(evaluate()).toEqual([origin]); else expect(evaluate).toThrow();
  }
});

it("accepts bounded correlated progress for status-omitting native content updates", () => {
  const notices = [read("pending", 1), read("completed", 5), origin];
  const progressed = receipt("progressed", "running", 3); Object.assign(progressed.payload.prpEvent.payload, { target: null, operation: "unknown" });
  const events = [receipt("started", "running", 2), progressed, receipt("completed", "completed", 6)];
  expect(withoutProvenBootstrapReads(notices, origin, { actionFile, events })).toEqual([origin]);
  progressed.payload.prpEvent.payload.target = "other.txt";
  expect(() => withoutProvenBootstrapReads(notices, origin, { actionFile, events })).toThrow();
});
