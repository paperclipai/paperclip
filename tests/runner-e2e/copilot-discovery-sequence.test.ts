import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COPILOT_CONTEXT_DISCOVERY_LIMIT, isCopilotContextDiscoveryProgress, readCopilotContextRead } from "./copilot-context-evidence.js";
import { readCopilotToolEvidence } from "./copilot-evidence.js";
import { onlyCopilotAttachedOperations, readCopilotSemanticCompletion } from "./copilot-semantic-evidence.js";

const retained = JSON.parse(readFileSync(new URL("./fixtures/copilot-attached-discovery-sequence-v15.json", import.meta.url), "utf8"));
function fixture() {
  const rows = structuredClone(retained.rows);
  const proposed = rows.find((r: any) => r.eventType === "run.result.proposed");
  const frame = proposed.payload.prpEvent;
  const notices = readCopilotToolEvidence(rows, proposed.runId);
  const command = notices.find(n => n.stage === "tool" && n.status === "pending" && n.mode === "async")!;
  const expected = { companyId: proposed.companyId, runId: proposed.runId, turnId: frame.turnId,
    nativeSessionId: command.sessionId, command, summary: frame.payload.summary, requireContextRead: true };
  return { rows, notices, command, expected };
}
const payload = (r: any) => r.payload.prpEvent.payload;
const detail = (r: any, name: string, value: string) => { payload(r).details.find((d: any) => d.name === name).value = value; };
describe("bounded individually attested context discovery sequence", () => {
  it("calibrates the retained two-discovery completion without treating the failed live attempt as qualified", () => {
    const f = fixture(), context = readCopilotContextRead(f.rows, f.command, true)!;
    expect(context.discoveries).toHaveLength(2);
    expect(context.discoveries[0]!.canonicalSeqs.at(-1)!).toBeLessThan(context.discoveries[1]!.pendingSeq);
    expect(context.discoveries[1]!.canonicalSeqs.at(-1)!).toBeLessThan(context.pendingSeq);
    const proof = readCopilotSemanticCompletion(f.rows, f.expected);
    expect(proof.contextRead?.discoveries).toHaveLength(2);
    expect(onlyCopilotAttachedOperations(f.notices, f.command, proof)).toBe(true);
    expect(retained.outcome).toContain("calibration only");
  });
  it.each(["get_task_context", "get task context", "dedicated get_task_context tool", "get_task_context paperclip_finish"])("admits bounded context metadata query %s", query => {
    expect(isCopilotContextDiscoveryProgress(`paperclip-search_api (pending): ${query}`)).toBe(true);
  });
  it.each(["create_task", "get task context call_api", "get task context create_task", "get task context; paperclip_finish", "get_task_context call_api", "get_task_context get_task_context", "get_task_context; paperclip_finish", "get_task_context " + "tool ".repeat(100)])("refuses another search scope: %s", query => {
    expect(isCopilotContextDiscoveryProgress(`paperclip-search_api (pending): ${query}`)).toBe(false);
  });
  it.each(["duplicate-receipt", "missing-receipt", "borrowed-identity", "foreign-session", "mutation", "another-query", "native-result-mismatch", "late-discovery"])("refuses %s in a multi-call sequence", kind => {
    const f = fixture();
    const receipts = f.rows.filter((r: any) => payload(r).category === "paperclip_semantic_tool_receipt_v2" && payload(r).details.some((d: any) => d.name === "operationId" && d.value === "search_api"));
    const second = receipts[1]!;
    const start = f.rows.find((r: any) => r.eventType === "tool.execution.started" && payload(r).name === "paperclip-search_api");
    if (kind === "duplicate-receipt") f.rows.push(structuredClone(second));
    if (kind === "missing-receipt") f.rows.splice(f.rows.indexOf(second), 1);
    if (kind === "borrowed-identity") detail(second, "callIdentitySha256", payload(receipts[0]).details.find((d: any) => d.name === "callIdentitySha256").value);
    if (kind === "foreign-session") second.payload.prpEvent.normalizedSessionId = "foreign";
    if (kind === "mutation") payload(start).readOnly = false;
    if (kind === "another-query") payload(start).progress = "paperclip-search_api (pending): create_task";
    if (kind === "native-result-mismatch") detail(second, "resultSha256", "f".repeat(64));
    if (kind === "late-discovery") second.seq = f.command.seq + 1;
    expect(() => readCopilotContextRead(f.rows, f.command, true)).toThrow();
  });
  it("refuses an unbounded discovery campaign", () => {
    const f = fixture(), receipt = f.rows.find((r: any) => payload(r).category === "paperclip_semantic_tool_receipt_v2" && payload(r).details.some((d: any) => d.name === "operationId" && d.value === "search_api"));
    for (let i = 0; i < COPILOT_CONTEXT_DISCOVERY_LIMIT; i++) f.rows.push(structuredClone(receipt));
    expect(() => readCopilotContextRead(f.rows, f.command, true)).toThrow(/unbounded/);
  });
});
