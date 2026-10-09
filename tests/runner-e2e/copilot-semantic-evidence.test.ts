import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { onlyCopilotAttachedOperations, readCopilotSemanticCompletion } from "./copilot-semantic-evidence.js";
import { readCopilotToolEvidence } from "./copilot-evidence.js";
import { validatePrpStructuredRunResult } from "../../packages/paperclip-runner/src/protocol/replay-contract.js";
import { runnerSuites, suiteDefinitionHash } from "./catalog.js";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const rawInput = { summary: "EXACT-MARKER", reportedWorkDisposition: "done", completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] }, evidence: [], verification: [] };
const validation = validatePrpStructuredRunResult(rawInput);
if (!validation.ok) throw new Error("Semantic fixture input must pass the production validator");
const result = validation.result;
const receipt = { schema: "paperclip.semantic_tool_receipt.v2", operationId: "paperclip_finish", callIdentitySha256: hash("3"), inputSha256: hash(canonical(rawInput)), normalizedInputSha256: hash(canonical(result)), resultSha256: hash("opaque original returned encoding"), outcome: "returned" };
function row(seq: number, eventType: string, payload: any, overrides: any = {}) {
  const e = { schema: "paperclip.prp.event.v1", eventType, runId: "run", turnId: "turn", normalizedSessionId: "normalized", sourceInstanceId: "source", sourceKind: "runner", sourceSeq: seq, emittedAt: "2026-09-30T12:00:00Z", payload, ...overrides };
  return { companyId: "company", runId: "run", seq, eventType, sourceInstanceId: e.sourceInstanceId, sourceSeq: e.sourceSeq, payload: { prpEvent: e } };
}
function notice(seq: number, toolCallId: string, status: string, fields: any = {}) {
  return row(seq, "provider.notice.recorded", { schema: "paperclip.provider.notice.v1", category: "copilot_tool_evidence_v1", scope: "turn", provenance: { method: "session/update", eventType: "tool", sessionId: "native", turnId: "turn" }, details: Object.entries({ stage: "tool", toolCallId, status, ...fields }).map(([name, value]) => ({ name, value: String(value) })) });
}
function fixture() {
  const rows = [notice(1, "command", "pending", { operation: "execute" }), notice(2, "finish-native", "pending"), row(3, "run.result.proposed", structuredClone(result), { itemId: "item-run" }),
    row(4, "provider.notice.recorded", { schema: "paperclip.provider.notice.v1", category: "paperclip_semantic_tool_receipt_v2", scope: "turn", provenance: { method: "paperclip/semantic_tool_result", eventType: "semantic_result", sessionId: "native", turnId: "turn" }, details: Object.entries({ stage: "semantic_result", ...receipt }).map(([name, value]) => ({ name, value })) }),
    notice(5, "finish-native", "completed", { semanticOperationId: receipt.operationId, semanticCallIdentitySha256: receipt.callIdentitySha256, semanticInputSha256: receipt.inputSha256, semanticNormalizedInputSha256: receipt.normalizedInputSha256, semanticResultSha256: receipt.resultSha256, semanticOutcome: receipt.outcome }),
    row(6, "turn.completed", {}), row(7, "run.result.accepted", { result: structuredClone(result) }, { sourceKind: "control_plane", sourceInstanceId: "source:control", sourceSeq: 1 })];
  const expected = { companyId: "company", runId: "run", turnId: "turn", nativeSessionId: "native", command: readCopilotToolEvidence(rows, "run")[0]!, summary: "EXACT-MARKER" };
  return { rows, expected };
}
const frame = (r: any) => r.payload.prpEvent;
function setField(r: any, key: string, value: string) { frame(r).payload.details.find((d: any) => d.name === key).value = value; }
describe("Copilot semantic completion public-event oracle", () => {
  it("versions the actual Copilot suite oracle without changing denial settlement", () => {
    const suite = runnerSuites.find(s => s.id === "copilot-protection")!;
    expect(suite.definitionMetadata).toMatchObject({ version: 9, semanticCompletionEvidence: "paperclip.e2e.copilot-semantic-completion.v2", denialSettlementEvidence: "paperclip.e2e.copilot-denial-settlement.v3" });
    expect(suiteDefinitionHash(suite)).not.toBe(suiteDefinitionHash({ ...suite, definitionMetadata: { ...suite.definitionMetadata, version: 7 } }));
  });
  it("joins exact native lifecycle, authoritative callback, proposed content and accepted control-plane result", () => {
    const { rows, expected } = fixture(); const proof = readCopilotSemanticCompletion(rows, expected);
    expect(proof.nativeToolCallId).toBe("finish-native"); expect(proof.acceptedSeq).toBe(7); expect(proof.summarySha256).toBe(hash("EXACT-MARKER"));
    expect(JSON.stringify(proof)).not.toContain("EXACT-MARKER");
  });
  it("binds distinct raw and production-normalized input digests without filling defaults in the oracle", () => {
    const { rows, expected } = fixture();
    expect(rawInput).not.toHaveProperty("schema");
    expect(rawInput).not.toHaveProperty("artifacts");
    expect(rawInput).not.toHaveProperty("attentionRequests");
    expect(result).toMatchObject({ schema: "paperclip.run_result.v1", artifacts: [], attentionRequests: [] });
    expect(receipt.inputSha256).not.toBe(receipt.normalizedInputSha256);
    expect(readCopilotSemanticCompletion(rows, expected)).toMatchObject({
      schema: "paperclip.e2e.copilot-semantic-completion.v2",
      inputSha256: receipt.inputSha256, normalizedInputSha256: receipt.normalizedInputSha256,
    });
    // Same authenticated raw/native join is necessary but cannot substitute for
    // the invocation-captured normalized body digest.
    setField(rows[3], "normalizedInputSha256", receipt.inputSha256);
    setField(rows[4], "semanticNormalizedInputSha256", receipt.inputSha256);
    expect(() => readCopilotSemanticCompletion(rows, expected)).toThrow("canonical accepted result");
  });
  it.each(["missing", "null", "wrong", "uppercase", "malformed"])("rejects %s normalized finish digest", value => {
    const f = fixture();
    if (value === "missing") {
      frame(f.rows[3]!).payload.details = frame(f.rows[3]!).payload.details.filter((d: any) => d.name !== "normalizedInputSha256");
      frame(f.rows[4]!).payload.details = frame(f.rows[4]!).payload.details.filter((d: any) => d.name !== "semanticNormalizedInputSha256");
    } else {
      const digest = value === "null" ? "null" : value === "wrong" ? hash("foreign-normalized-input") : value === "uppercase" ? "A".repeat(64) : "not-a-digest";
      setField(f.rows[3], "normalizedInputSha256", digest); setField(f.rows[4], "semanticNormalizedInputSha256", digest);
    }
    expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow();
  });
  it("allows an explicit null native digest as diagnostic data, never as successful finish authority", () => {
    const f = fixture(); setField(f.rows[4], "semanticNormalizedInputSha256", "null");
    expect(readCopilotToolEvidence(f.rows, "run").at(-1)?.semanticNormalizedInputSha256).toBeNull();
    expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow("native receipt mismatch");
  });
  it.each(["only", "alongside-v2"])("rejects legacy v1 authority %s as fresh qualification", mode => {
    const f = fixture(), old = structuredClone(f.rows[3]!);
    frame(old).payload.category = "paperclip_semantic_tool_receipt_v1";
    setField(old, "schema", "paperclip.semantic_tool_receipt.v1");
    frame(old).payload.details = frame(old).payload.details.filter((d: any) => d.name !== "normalizedInputSha256");
    if (mode === "only") f.rows[3] = old; else f.rows.push(old);
    expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow();
  });
  it("does not repair an unnormalized proposed and accepted body by adding defaults", () => {
    const f = fixture(); frame(f.rows[2]!).payload = structuredClone(rawInput); frame(f.rows[6]!).payload.result = structuredClone(rawInput);
    expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow("canonical accepted result");
  });
  it.each([0, 1, 2, 3, 4, 5, 6])("rejects missing required row %s", index => { const f = fixture(); f.rows.splice(index, 1); expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow(); });
  it.each([1, 2, 3, 4, 5, 6])("rejects duplicate required row %s", index => { const f = fixture(); f.rows.push(structuredClone(f.rows[index]!)); expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow(); });
  it.each(["companyId", "runId"])("rejects foreign durable %s", key => { const f = fixture(); (f.rows[3] as any)[key] = "foreign"; expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow(); });
  it.each(["turnId", "normalizedSessionId", "sourceInstanceId", "sourceKind", "eventType", "schema"])("rejects foreign or malformed envelope %s", key => {
    for (const index of [1, 2, 3, 4, 5, 6]) { const f = fixture(); (frame(f.rows[index]!))[key] = "foreign"; expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow(); }
  });
  it.each([null, undefined])("rejects missing envelope turn %s even with native provenance intact", turn => { const f = fixture(); frame(f.rows[4]!).turnId = turn; expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow(); });
  it.each(["sessionId", "turnId", "method", "eventType"])("rejects authoritative provenance %s mismatch", key => { const f = fixture(); frame(f.rows[3]!).payload.provenance[key] = "foreign"; expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow(); });
  it.each(["callIdentitySha256", "inputSha256", "normalizedInputSha256", "resultSha256", "operationId", "outcome"])("rejects native %s disagreement", key => { const f = fixture(); setField(f.rows[4], `semantic${key[0]!.toUpperCase()}${key.slice(1)}`, key.endsWith("Sha256") ? "a".repeat(64) : "wrong"); expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow(); });
  it("does not infer acceptance from returned receipt or a tool named paperclip_finish", () => {
    const f = fixture(); frame(f.rows[6]!).payload.result = { accepted: false, summary: "EXACT-MARKER" }; expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow();
    const g = fixture(); frame(g.rows[4]!).payload.title = "paperclip_finish"; frame(g.rows[4]!).payload.details = frame(g.rows[4]!).payload.details.filter((d: any) => !d.name.startsWith("semantic")); expect(() => readCopilotSemanticCompletion(g.rows, g.expected)).toThrow();
  });
  it.each(["failed", "cancelled", "interrupted"])("rejects %s terminal", status => { const f = fixture(); f.rows[5]!.eventType = `turn.${status}`; frame(f.rows[5]!).eventType = `turn.${status}`; expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow(); });
  it("rejects changed accepted body, forged call ID, wrong summary and rejected result", () => {
    for (const mutate of [(f: ReturnType<typeof fixture>) => { frame(f.rows[6]!).payload.result.completionClaim.remainingWork.push("unfinished"); }, (f: ReturnType<typeof fixture>) => { setField(f.rows[3], "callIdentitySha256", hash("foreign-call")); }, (f: ReturnType<typeof fixture>) => { f.expected.summary = "other"; }, (f: ReturnType<typeof fixture>) => { f.rows.push(row(8, "run.result.rejected", {})); }]) { const f = fixture(); mutate(f); expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow(); }
  });
  it("rejects duplicate/unknown/oversized receipt details and partial native fields", () => {
    for (const mutate of [(r: any) => frame(r).payload.details.push({ name: "secret", value: "untrusted" }), (r: any) => frame(r).payload.details.push(frame(r).payload.details[0]), (r: any) => setField(r, "operationId", "x".repeat(300))]) { const f = fixture(); mutate(f.rows[3]); expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow(); }
    const f = fixture(); frame(f.rows[4]!).payload.details.pop(); expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow();
  });
  it("rejects mutation metadata, extra lifecycle, reordered receipt and source sequence drift", () => {
    for (const mutate of [(f: ReturnType<typeof fixture>) => frame(f.rows[1]!).payload.details.push({ name: "operation", value: "edit" }), (f: ReturnType<typeof fixture>) => f.rows.push(notice(8, "finish-native", "pending")), (f: ReturnType<typeof fixture>) => { f.rows[3]!.seq = 8; }, (f: ReturnType<typeof fixture>) => { frame(f.rows[3]!).sourceSeq = 20; f.rows[3]!.sourceSeq = 20; }, (f: ReturnType<typeof fixture>) => { frame(f.rows[1]!).sourceSeq = 20; f.rows[1]!.sourceSeq = 20; }]) { const f = fixture(); mutate(f); expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow(); }
  });
  it("does not treat canonical run-level itemId as semantic call identity", () => {
    for (const itemId of ["item-run", "3", "unrelated-item", null]) {
      const f = fixture(); frame(f.rows[2]!).itemId = itemId;
      expect(readCopilotSemanticCompletion(f.rows, f.expected).callIdentitySha256).toBe(receipt.callIdentitySha256);
    }
  });
  it("rejects a different finish input even when proposal and acceptance agree", () => {
    const f = fixture(); frame(f.rows[2]!).payload.completionClaim.criteria[0].evidenceRefs.push("different");
    frame(f.rows[6]!).payload.result = structuredClone(frame(f.rows[2]!).payload);
    expect(() => readCopilotSemanticCompletion(f.rows, f.expected)).toThrow();
  });
  it("accepts the retained shell-read ordering: pending has shellId only, completion gains command identity after finish", () => {
    const f = attachedFixture();
    expect(f.notices.find(n => n.toolCallId === "shell-read" && n.status === "pending")?.commandToolCallId).toBeUndefined();
    expect(onlyCopilotAttachedOperations(f.notices, f.command, f.proof)).toBe(true);
  });
  it("accepts bounded in-progress shell updates without inventing terminal command identity", () => {
    const f = attachedFixture(), pending = f.notices.find(n => n.toolCallId === "shell-read" && n.status === "pending")!;
    f.notices.push({ ...pending, status: "in_progress", seq: 53 });
    expect(onlyCopilotAttachedOperations(f.notices, f.command, f.proof)).toBe(true);
  });
  it("rejects shell-read evidence from a different durable stream despite matching native identity", () => {
    const f = attachedFixture(), r = f.rows.find(r => r.seq === 52)!;
    frame(r).sourceInstanceId = "foreign"; r.sourceInstanceId = "foreign";
    expect(() => readCopilotSemanticCompletion(f.rows, { companyId: "company", runId: "run", turnId: "turn", nativeSessionId: "native", command: f.command, summary: "EXACT-MARKER" })).toThrow();
  });
  it.each(["missing-pending", "missing-terminal", "duplicate-pending", "duplicate-terminal", "extra-completed-only", "extra-complete-read", "wrong-shell", "wrong-command", "failed", "nonzero", "reordered", "late", "wrong-operation", "mutation", "read-path", "foreign-session", "foreign-turn", "foreign-run", "permission", "semantic-fields", "normalized-semantic-field"])("rejects invalid shell-read lifecycle: %s", failure => {
    const f = attachedFixture(), start = f.notices.find(n => n.toolCallId === "shell-read" && n.status === "pending")!, end = f.notices.find(n => n.toolCallId === "shell-read" && n.status === "completed")!;
    if (failure === "missing-pending") f.notices.splice(f.notices.indexOf(start), 1);
    if (failure === "missing-terminal") f.notices.splice(f.notices.indexOf(end), 1);
    if (failure === "duplicate-pending") f.notices.push({ ...start, seq: 53 });
    if (failure === "duplicate-terminal") f.notices.push({ ...end, seq: 56 });
    if (failure === "extra-completed-only") f.notices.push({ ...end, toolCallId: "extra", seq: 57 });
    if (failure === "extra-complete-read") f.notices.push({ ...start, toolCallId: "extra", seq: 56 }, { ...end, toolCallId: "extra", seq: 57 });
    if (failure === "wrong-shell") start.shellId = "foreign";
    if (failure === "wrong-command") end.commandToolCallId = "foreign";
    if (failure === "failed") end.status = "failed";
    if (failure === "nonzero") end.exitCode = 1;
    if (failure === "reordered") start.seq = 14;
    if (failure === "late") end.seq = 61;
    if (failure === "wrong-operation") start.operation = "execute";
    if (failure === "mutation") end.target = "file.txt";
    if (failure === "read-path") start.readTargetSha256 = `sha256:${"a".repeat(64)}`;
    if (failure === "foreign-session") start.sessionId = "foreign";
    if (failure === "foreign-turn") start.turnId = "foreign";
    if (failure === "foreign-run") start.runId = "foreign";
    if (failure === "permission") start.stage = "permission_requested";
    if (failure === "semantic-fields") end.semanticCallIdentitySha256 = receipt.callIdentitySha256;
    if (failure === "normalized-semantic-field") end.semanticNormalizedInputSha256 = receipt.normalizedInputSha256;
    expect(onlyCopilotAttachedOperations(f.notices, f.command, f.proof)).toBe(false);
  });
  it("rejects duplicate shell origins and arbitrary extra operations", () => {
    const f = attachedFixture();
    const started = f.notices.find(n => n.shellState === "started")!;
    expect(onlyCopilotAttachedOperations([...f.notices, { ...started, seq: 16 }], f.command, f.proof)).toBe(false);
    for (const operation of [undefined, "read", "edit", "execute"] as const) expect(onlyCopilotAttachedOperations([...f.notices, { ...f.command, toolCallId: "extra", operation, seq: 17 }], f.command, f.proof)).toBe(false);
  });
  it("keeps actual flow correlation before no-extra-operation gate and keeps visible marker independent", async () => {
    const source = await readFile(new URL("./copilot-protection-flow.ts", import.meta.url), "utf8");
    expect(source.indexOf("readCopilotSemanticCompletion(runEvents")).toBeLessThan(source.indexOf('check("no-extra-native-operation", onlyCopilotAttachedOperations('));
    expect(source).toContain("undefined), call!, semantic)");
    expect(source).toContain('check("exact-completion-marker", comments.filter');
    expect(source).not.toContain('if (remote) check("no-extra-native-operation"');
  });
});

// Mirrors retained native order: command pending→shell started; finish; then
// read_bash pending(shellId only)→completed(commandToolCallId), before turn end.
function attachedFixture() {
  const f = fixture(); frame(f.rows[2]!).itemId = "3";
  for (const r of f.rows) { r.seq *= 10; if (frame(r).sourceKind === "runner") { r.sourceSeq *= 10; frame(r).sourceSeq *= 10; } }
  const fields = { operation: "execute", commandSha256: `sha256:${"a".repeat(64)}`, mode: "async", detach: false };
  f.rows[0] = notice(10, "command", "pending", fields);
  f.rows.push(notice(15, "command", "completed", { ...fields, shellId: "0", commandToolCallId: "command", shellState: "started" }),
    notice(52, "shell-read", "pending", { operation: "read", shellId: "0" }),
    notice(55, "shell-read", "completed", { operation: "read", shellId: "0", commandToolCallId: "command", shellState: "completed", exitCode: 0 }));
  const notices = readCopilotToolEvidence(f.rows, "run"), command = notices.find(n => n.seq === 10)!;
  const proof = readCopilotSemanticCompletion(f.rows, { ...f.expected, command });
  return { rows: f.rows, notices, command, proof };
}
