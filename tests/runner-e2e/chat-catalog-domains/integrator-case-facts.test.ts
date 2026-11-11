import { describe, expect, it } from "vitest";
import { corrected, gradeIntegratorCaseFacts } from "./integrator-case-facts.js";
const FIRST = "Updated case COM-C1: browser is now **\"Mobile Safari only\"**, with customer, expected result, and severity preserved. See [COM-1](/COM/issues/COM-1).";
// Recorded follow-up reply from run 42584001490 (escalation value substituted).
const FOLLOW_UP = "Yes. The case's saved facts still include your correction: `browser` = **Mobile Safari only**. The other facts are unchanged: customer **Acorn Test Shop**, expected **Pay should submit a single order**, severity **normal**.\n\nThe saved support escalation is **support-123**.\n\nOne caveat: the separate reproduction brief document still says \"The affected device has not yet been confirmed.\" Case COM-C1 is linked to [COM-1](/COM/issues/COM-1).";
function withFollowUp(reply: string) { const v = valid(); v.state.collaborationCheckpoint.reply = `${FIRST}\n${reply}`; return v; }
function valid() {
  const original = { id: "case", identifier: "COM-C1", workIssueId: "primary", handoffVersion: 1, fields: { browser: "Safari; device unknown", customer: "Acorn", severity: "normal", expected: "one order" } };
  const brief = { id: "brief", issueId: "primary", latestRevisionId: "v1", body: "Customer reproduction" };
  const fields = { ...original.fields, browser: "Mobile Safari only", supportEscalation: "support-123" };
  const base = { scenarioId: "cases.update-case-facts", origin: "https://fixture.test", companyId: "company", leadId: "ceo",
    state: { initialRunId: "initial", sourceId: "chat", worker: { id: "morgan" }, case: original, brief, collaboratorValue: "support-123", reviewer: { id: "riley" } }, caseRecord: { ...original, fields }, brief, workComments: [] as Array<{ id: string; issueId: string; createdByRunId: string }>,
    briefRevisions: [{ id: "v1", issueId: "primary", body: brief.body }], projects: [], tasks: [{ id: "primary", identifier: "COM-1" }], goals: [], documents: [], revisions: [], comments: [], links: [], activity: [], humanQueries: [],
    reply: "The reproduction occurs exclusively on mobile Safari. Support escalation is support-123.",
    runs: [{ id: "initial", status: "cancelled", runtimeMode: "native", agentId: "morgan", contextSnapshot: { issueId: "primary", paperclipCase: { id: "case", taskId: "primary", data: "{}" } } },
      { id: "turn-1", status: "succeeded", runtimeMode: "native", agentId: "ceo", contextSnapshot: { issueId: "chat" } }, { id: "turn-2", status: "succeeded", runtimeMode: "native", agentId: "ceo", contextSnapshot: { issueId: "chat" } },
      { id: "review", status: "succeeded", runtimeMode: "native", agentId: "riley", contextSnapshot: { issueId: "primary", paperclipCase: { id: "case", taskId: "primary", data: JSON.stringify({ fields }) } } }] };
  const first = { ...structuredClone(base), reply: FIRST };
  return { ...base, caseRecord: { ...base.caseRecord, handoffVersion: 2 }, state: { ...base.state, firstCorrection: first, collaborationCheckpoint: { ...structuredClone(base), reply: `${FIRST}\n${FOLLOW_UP}` } } };
}
describe("current case facts and real subsequent context", () => {
  it("accepts a substantive correction, preserved collaborator field and actual native projection", () => {
    expect(gradeIntegratorCaseFacts(valid()).passed).toBe(true);
    expect(gradeIntegratorCaseFacts(undefined).passed).toBe(false);
    for (const reply of ["COM-C1 still limits the bug to iOS Safari — nothing was overwritten. The current support escalation is support-123.",
      "Your correction survived support's edit on [COM-1](/COM/issues/COM-1): affected browser is Safari on iPhone. Escalation saved: support-123."])
      expect(gradeIntegratorCaseFacts(withFollowUp(reply)).passed).toBe(true);
    const structured = valid(); structured.caseRecord.fields.browser = "mobile Safari"; expect(gradeIntegratorCaseFacts(structured).passed).toBe(true);
  });
  it("rejects lost unrelated fields and an initially wrong correction repaired later", () => {
    const lost = valid(); lost.caseRecord.fields.customer = "Other"; expect(gradeIntegratorCaseFacts(lost).passed).toBe(false);
    const repaired = valid(); repaired.state.firstCorrection.caseRecord.fields.browser = "Desktop Safari only"; expect(gradeIntegratorCaseFacts(repaired).passed).toBe(false);
    const stale = valid(); stale.state.collaborationCheckpoint.caseRecord.fields.supportEscalation = "stale"; expect(gradeIntegratorCaseFacts(stale).passed).toBe(false);
  });
  it("rejects stale handoff context, chat-only projection and moved document ownership", () => {
    const stale = valid(); (stale.runs[3]!.contextSnapshot as { paperclipCase: { data: string } }).paperclipCase.data = JSON.stringify({ fields: stale.state.case.fields }); expect(gradeIntegratorCaseFacts(stale).passed).toBe(false);
    const chat = valid(); chat.runs[3]!.contextSnapshot.issueId = "chat"; expect(gradeIntegratorCaseFacts(chat).passed).toBe(false);
    const moved = valid(); moved.brief.issueId = "case"; expect(gradeIntegratorCaseFacts(moved).passed).toBe(false);
    const missing = valid(); missing.briefRevisions = []; expect(gradeIntegratorCaseFacts(missing).passed).toBe(false);
  });
  it("rejects a follow-up without the case reference or the saved escalation literal", () => {
    for (const reply of ["Yes, COM-C1 still says mobile Safari only. The escalation is support-999.",
      "Yes, COM-C1 still says mobile Safari only.",
      "Yes, it still says mobile Safari only. Support escalation is support-123.",
      `${FIRST}`])
      expect(gradeIntegratorCaseFacts(withFollowUp(reply)).passed, reply).toBe(false);
    // The first reply already named the case; the follow-up must answer on its own.
    const reusedFirst = valid(); reusedFirst.state.collaborationCheckpoint.reply = `${FIRST}\nYes, it still says mobile Safari only. Support escalation is support-123.`;
    expect(gradeIntegratorCaseFacts(reusedFirst).passed).toBe(false);
  });
  it("grades the saved browser by normalized tokens, not keywords anywhere in the fields", () => {
    for (const browser of ["Mobile Safari only", "mobile Safari", "iOS Safari", "Safari on iPhone/iPad only", "Safari (iOS)"]) expect(corrected({ browser }), browser).toBe(true);
    expect(corrected({ browser: "Safari", platform: "mobile only" })).toBe(true);
    // A clause that only rules another platform out is a clarification of the same fact.
    for (const browser of ["Mobile Safari only (iPhone/iPad); desktop Safari unaffected", "Mobile Safari only - desktop Safari and Chrome are not affected", "iOS Safari only, works on desktop", "Mobile Safari only; not on Chrome", "Mobile Safari only; desktop Safari excluded"])
      expect(corrected({ browser }), browser).toBe(true);
    for (const browser of ["Mobile Safari; desktop Safari also affected", "Mobile Safari only (not yet confirmed)", "Mobile Safari, not iOS", "Mobile Safari; desktop Safari not excluded", "Mobile Safari; desktop Safari is not excluded", "Safari; desktop unaffected", "Mobile Safari and desktop Chrome"])
      expect(corrected({ browser }), browser).toBe(false);
    expect(corrected({ affectedBrowsers: ["iOS Safari"] })).toBe(true);
    for (const fields of [{ browser: "Safari (desktop and mobile Safari)", note: "only intermittent" }, { browser: "Safari; affected device not yet confirmed" }, { browser: "Desktop Safari only" },
      { browser: "not mobile Safari" }, { browser: "Safari", note: "mobile only" }, { browser: "Chrome and mobile Safari" }, { affectedBrowsers: ["iOS Safari", "Chrome"] }, { browser: "Safari; device unknown", affectedBrowser: "iOS Safari" }, {}])
      expect(corrected(fields), JSON.stringify(fields)).toBe(false);
  });
});

// Retained gha-42926018003 (full cohort on 9296c74e8d): the CEO's first turn saved the correction and also told
// Morgan on the case task; that comment woke Morgan (issue_commented), so the old raw count never settled.
describe("role-bound case-fact runs", () => {
  const continuation = (id: string, commentId: string) => ({ id, status: "succeeded", runtimeMode: "native", agentId: "morgan", contextSnapshot: { issueId: "primary", commentId, wakeReason: "issue_commented" } });
  it("admits one Morgan continuation per CEO turn woken by that turn's task comment", () => {
    const o = valid(); o.workComments = [{ id: "notify", issueId: "primary", createdByRunId: "turn-1" }];
    o.runs.splice(2, 0, continuation("morgan-1", "notify") as typeof o.runs[number]);
    expect(gradeIntegratorCaseFacts(o).passed).toBe(true);
  });
  it("rejects unprompted, duplicate or foreign extra runs", () => {
    const unprompted = valid(); unprompted.runs.push(continuation("morgan-x", "missing") as typeof unprompted.runs[number]); expect(gradeIntegratorCaseFacts(unprompted).passed).toBe(false);
    const twice = valid(); twice.workComments = [{ id: "a", issueId: "primary", createdByRunId: "turn-1" }, { id: "b", issueId: "primary", createdByRunId: "turn-1" }];
    twice.runs.push(continuation("m1", "a") as typeof twice.runs[number], continuation("m2", "b") as typeof twice.runs[number]); expect(gradeIntegratorCaseFacts(twice).passed).toBe(false);
    const second = valid(); second.runs.push({ ...second.runs[3]!, id: "review-2" }); expect(gradeIntegratorCaseFacts(second).passed).toBe(false);
    const third = valid(); third.runs.push({ id: "turn-3", status: "succeeded", runtimeMode: "native", agentId: "ceo", contextSnapshot: { issueId: "chat" } } as typeof third.runs[number]); expect(gradeIntegratorCaseFacts(third).passed).toBe(false);
  });
});
