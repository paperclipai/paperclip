import { describe, expect, it } from "vitest";
import { gradeIntegratorCaseHistory } from "./integrator-case-history.js";
function valid() {
  const row = { id: "case", identifier: "CAS-1", workIssueId: "primary" };
  const runs = [{ id: "m1", agentId: "morgan", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "primary" } }, { id: "r1", agentId: "riley", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "primary" } }];
  const old = { id: "old", revisionNumber: 1, createdByAgentId: "morgan", createdByRunId: "m1", body: "Preliminary event handler binding hypothesis." };
  const changed = { id: "new", revisionNumber: 2, createdByAgentId: "riley", createdByRunId: "r1", body: "The overlay intercepts touch on Pay." };
  const base = { scenarioId: "cases.case-history", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { case: row, task: { id: "primary", identifier: "TST-1" }, worker: { id: "morgan" }, reviewer: { id: "riley" }, unavailableTextInvented: false },
    caseRecord: row, caseEvents: [{ id: "rfact", actorType: "agent", actorAgentId: "riley", kind: "fields_changed", payload: {} }], handoffs: [{ version: 1 }, { version: 2, actorType: "agent", actorId: "morgan", toAgentId: "riley", sourceRunId: "m1" }, { version: 3, actorType: "agent", actorId: "riley", toAgentId: "morgan", sourceRunId: "r1" }],
    diagnosis: { issueId: "primary" }, diagnosisRevisions: [old, changed], tasks: [], projects: [], goals: [], documents: [], revisions: [], comments: [], humanQueries: [], activity: [], runs,
    reply: "Riley revised the diagnosis document: the overlay intercepts touch on Pay. Morgan's initial hypothesis was an event handler binding problem. Riley also changed the diagnosis fact; the handoffs routed the same task between its owners.",
    links: ["/TST/cases/CAS-1", "/TST/issues/TST-1"] };
  const later = "The prior support fact text is not retained in the saved audit. Document revisions are separate evidence and cannot reconstruct that missing fact content.";
  return { ...base, reply: `${base.reply}\n${later}`, caseEvents: [...base.caseEvents, { id: "b1", actorType: "board", actorAgentId: "", kind: "fields_changed", payload: {} }, { id: "b2", actorType: "board", actorAgentId: "", kind: "fields_changed", payload: {} }],
    state: { ...base.state, firstHistory: structuredClone(base), missingHistoryEventIds: ["b1", "b2"], currentSupportDiagnosis: "Current support hypothesis" } };
}
describe("attributed diagnosis history with explicitly requested missing facts", () => {
  it("accepts actual distinct revision authors, handoffs and truthful missing history", () => {
    expect(gradeIntegratorCaseHistory(valid()).passed).toBe(true); expect(gradeIntegratorCaseHistory(undefined).passed).toBe(false);
    const natural = valid(); natural.reply = `${natural.state.firstHistory.reply}\nThe saved history doesn't include the previous support fact text, so I can't recover it from those document versions.`;
    expect(gradeIntegratorCaseHistory(natural).passed).toBe(true);
  });
  it("rejects wrong author, synthetic revision provenance and handoff-as-fact substitution", () => {
    const wrong = valid(); wrong.diagnosisRevisions[1]!.createdByAgentId = "morgan"; expect(gradeIntegratorCaseHistory(wrong).passed).toBe(false);
    const fake = valid(); fake.diagnosisRevisions[1]!.createdByRunId = "unrelated"; expect(gradeIntegratorCaseHistory(fake).passed).toBe(false);
    const event = valid(); event.caseEvents[0]!.kind = "handoff_applied"; expect(gradeIntegratorCaseHistory(event).passed).toBe(false);
    const denied = valid(); denied.state.firstHistory.reply = denied.state.firstHistory.reply.replace("Riley revised", "Riley did not revise"); expect(gradeIntegratorCaseHistory(denied).passed).toBe(false);
    const routing = valid(); routing.handoffs[2]!.actorId = "morgan"; expect(gradeIntegratorCaseHistory(routing).passed).toBe(false);
  });
  it("rejects reconstructed prior facts and missing actual revision or useful history links", () => {
    const invented = valid(); invented.reply = `${invented.state.firstHistory.reply}\nThe previous support diagnosis was an event binding problem. The audit is unavailable.`; expect(gradeIntegratorCaseHistory(invented).passed).toBe(false);
    const absent = valid(); absent.diagnosisRevisions = []; expect(gradeIntegratorCaseHistory(absent).passed).toBe(false);
    const links = valid(); links.state.firstHistory.links = []; expect(gradeIntegratorCaseHistory(links).passed).toBe(false);
    const old = valid(); old.state.firstHistory.reply = "Riley updated the diagnosis document; Morgan's prior diagnosis is unknown. The fact update and handoff are saved."; expect(gradeIntegratorCaseHistory(old).passed).toBe(false);
  });
});
