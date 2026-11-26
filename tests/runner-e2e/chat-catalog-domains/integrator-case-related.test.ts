import { describe, expect, it } from "vitest";
import { gradeIntegratorRelatedWork } from "./integrator-case-related.js";
function valid() {
  const primary = { id: "primary", identifier: "ACN-1", title: "Investigation", status: "done" };
  const followup = { id: "followup", identifier: "ACN-2", title: "Mobile follow-up", status: "backlog" };
  const row = { id: "case", identifier: "ACN-C1", workIssueId: primary.id, status: "in_progress", handoffVersion: 1 };
  return { scenarioId: "cases.related-work", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { case: structuredClone(row), followup,
    unrelated: { id: "same-name", identifier: "ACN-3", title: followup.title }, privateTask: { id: "foreign", identifier: "PRV-1", title: "Private customer" }, privateMarker: "PRIVATE-SENTINEL" },
    tasks: [primary, followup], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], activity: [], runs: [],
    links: ["/ACN/issues/ACN-1", "/ACN/issues/ACN-2"], caseDetail: { ...row, issueLinks: [{ issueId: "primary", role: "work" }, { issueId: "followup", role: "reference" }] },
    reverseLinks: { primary: [{ role: "work", case: structuredClone(row) }], followup: [{ role: "reference", case: structuredClone(row) }] }, deniedStatus: 404,
    reply: "Primary investigation ACN-1 is completed. The linked follow-up ACN-2 remains backlog; the case is still open." };
}
describe("case relationships rather than similar names", () => {
  it("accepts real primary/reference/reverse links and substantive state paraphrase", () => {
    expect(gradeIntegratorRelatedWork(valid()).passed).toBe(true);
    expect(gradeIntegratorRelatedWork({ ...valid(), reply: "The main Investigation task is done. Its reference Mobile follow-up is in backlog." }).passed).toBe(true);
    expect(gradeIntegratorRelatedWork(undefined).passed).toBe(false);
    expect(gradeIntegratorRelatedWork({ ...valid(), reverseLinks: {} }).passed).toBe(false);
  });
  it("rejects inferred same-name relationships, private exposure and wrong principal access", () => {
    const o = valid();
    const collision = structuredClone(o); collision.state.unrelated.id = collision.state.followup.id;
    expect(gradeIntegratorRelatedWork(collision).passed).toBe(false);
    expect(gradeIntegratorRelatedWork({ ...o, links: [...o.links, "/ACN/issues/ACN-3"] }).passed).toBe(false);
    expect(gradeIntegratorRelatedWork({ ...o, reply: `${o.reply} Private customer: PRIVATE-SENTINEL.` }).passed).toBe(false);
    expect(gradeIntegratorRelatedWork({ ...o, deniedStatus: 200 }).passed).toBe(false);
    const missing = valid(); missing.caseDetail.issueLinks = [];
    expect(gradeIntegratorRelatedWork(missing).passed).toBe(false);
  });
  it("rejects premature completion or relationship mutation", () => {
    const o = valid();
    expect(gradeIntegratorRelatedWork({ ...o, reply: `${o.reply} All case work is complete.` }).passed).toBe(false);
    expect(gradeIntegratorRelatedWork({ ...o, reply: "Primary ACN-1 is not completed and remains backlog. Linked follow-up ACN-2 is done." }).passed).toBe(false);
    const changed = valid(); changed.caseDetail.handoffVersion = 2;
    expect(gradeIntegratorRelatedWork(changed).passed).toBe(false);
    expect(gradeIntegratorRelatedWork({ ...o, activity: [{ id: "edit", agentId: "ceo", action: "case.updated" }] }).passed).toBe(false);
  });
});
