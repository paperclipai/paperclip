import { describe, expect, it } from "vitest";
import { gradeIntegratorCaseFacts } from "./integrator-case-facts.js";
function valid() {
  const original = { id: "case", workIssueId: "primary", handoffVersion: 1, fields: { browser: "Safari; device unknown", customer: "Acorn", severity: "normal", expected: "one order" } };
  const brief = { id: "brief", issueId: "primary", latestRevisionId: "v1", body: "Customer reproduction" };
  const fields = { ...original.fields, browser: "Mobile Safari only", supportEscalation: "support-123" };
  const base = { scenarioId: "cases.update-case-facts", origin: "https://fixture.test", companyId: "company", leadId: "ceo",
    state: { initialRunId: "initial", worker: { id: "morgan" }, case: original, brief, collaboratorValue: "support-123", reviewer: { id: "riley" } }, caseRecord: { ...original, fields }, brief,
    briefRevisions: [{ id: "v1", issueId: "primary", body: brief.body }], projects: [], tasks: [], goals: [], documents: [], revisions: [], comments: [], links: [], activity: [], humanQueries: [],
    reply: "The reproduction occurs exclusively on mobile Safari. Support escalation is support-123.",
    runs: [{ id: "initial", status: "cancelled", runtimeMode: "native", agentId: "morgan", contextSnapshot: { issueId: "primary", paperclipCase: { id: "case", taskId: "primary", data: "{}" } } }, { id: "review", status: "succeeded", runtimeMode: "native", agentId: "riley", contextSnapshot: { issueId: "primary", paperclipCase: { id: "case", taskId: "primary", data: JSON.stringify({ fields }) } } }] };
  return { ...base, caseRecord: { ...base.caseRecord, handoffVersion: 2 }, state: { ...base.state, firstCorrection: structuredClone(base), collaborationCheckpoint: structuredClone(base) } };
}
describe("current case facts and real subsequent context", () => {
  it("accepts a substantive correction, preserved collaborator field and actual native projection", () => {
    expect(gradeIntegratorCaseFacts(valid()).passed).toBe(true);
    expect(gradeIntegratorCaseFacts(undefined).passed).toBe(false);
    const natural = valid(); natural.state.collaborationCheckpoint.reply = "This affects mobile Safari only. The current support escalation is support-123.";
    expect(gradeIntegratorCaseFacts(natural).passed).toBe(true);
    const structured = valid(); structured.caseRecord.fields.browser = "mobile Safari"; expect(gradeIntegratorCaseFacts(structured).passed).toBe(true);
  });
  it("rejects lost unrelated fields and an initially wrong correction repaired later", () => {
    const lost = valid(); lost.caseRecord.fields.customer = "Other"; expect(gradeIntegratorCaseFacts(lost).passed).toBe(false);
    const repaired = valid(); repaired.state.firstCorrection.caseRecord.fields.browser = "Desktop Safari only"; expect(gradeIntegratorCaseFacts(repaired).passed).toBe(false);
    const stale = valid(); stale.state.collaborationCheckpoint.caseRecord.fields.supportEscalation = "stale"; expect(gradeIntegratorCaseFacts(stale).passed).toBe(false);
  });
  it("rejects stale handoff context, chat-only projection and moved document ownership", () => {
    const stale = valid(); stale.runs[1]!.contextSnapshot.paperclipCase.data = JSON.stringify({ fields: stale.state.case.fields }); expect(gradeIntegratorCaseFacts(stale).passed).toBe(false);
    const chat = valid(); chat.runs[1]!.contextSnapshot.issueId = "chat"; expect(gradeIntegratorCaseFacts(chat).passed).toBe(false);
    const moved = valid(); moved.brief.issueId = "case"; expect(gradeIntegratorCaseFacts(moved).passed).toBe(false);
    const missing = valid(); missing.briefRevisions = []; expect(gradeIntegratorCaseFacts(missing).passed).toBe(false);
  });
  it("rejects a plausible contrary chat report and missing collaborative acknowledgement", () => {
    const falseReport = valid(); falseReport.state.collaborationCheckpoint.reply = "It is not only mobile Safari. Support escalation is support-123."; expect(gradeIntegratorCaseFacts(falseReport).passed).toBe(false);
    const missing = valid(); missing.state.collaborationCheckpoint.reply = "Mobile Safari only."; expect(gradeIntegratorCaseFacts(missing).passed).toBe(false);
  });
});
