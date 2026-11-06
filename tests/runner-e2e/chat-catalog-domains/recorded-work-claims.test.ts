import { describe, expect, it } from "vitest";
import { grade_activity } from "./internal-activity.js";
import { gradeIntegratorRelatedWork } from "./integrator-case-related.js";
function overview() {
  const active = { id: "active", identifier: "ACN-1", title: "Website draft", status: "in_progress" };
  const blocked = { id: "blocked", identifier: "ACN-2", title: "Accessibility review", status: "blocked", description: "Waiting for approved launch colors nonce-1." };
  const done = { id: "done", identifier: "ACN-3", title: "Launch brief delivered", status: "done" };
  return { scenarioId: "activity.company-overview", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { task: active, blockedTask: blocked, doneTask: done, worker: { id: "morgan" }, blocker: "approved launch colors nonce-1", hiddenMarker: "HIDDEN-SENTINEL" },
    tasks: [active, blocked, done], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], humanQueries: [], runs: [], agents: [{ id: "morgan", status: "idle" }], links: ["/ACN/issues/ACN-1", "/ACN/issues/ACN-2", "/ACN/issues/ACN-3"],
    reply: "Here's the picture right now:\n\n- **ACN-1 Website draft** — in progress, assigned to the board.\n- **ACN-2 Accessibility review** — blocked, unassigned. Waiting on approved launch colors, but there are zero approvals on record.\n- **ACN-3 Launch brief delivered** — done, unassigned.\n\nMorgan is idle.\n\nNeeds a decision: ACN-2 can't move until the launch color palette is approved, and no approval card exists." };
}
function related() {
  const primary = { id: "primary", identifier: "ACN-1", title: "Investigation", status: "done" };
  const followup = { id: "followup", identifier: "ACN-2", title: "Mobile follow-up", status: "backlog" };
  const unrelated = { id: "unrelated", identifier: "ACN-3", title: "Mobile follow-up investigation", status: "backlog" };
  const row = { id: "case", identifier: "ACN-C1", workIssueId: "primary", status: "draft", handoffVersion: 1 };
  return { scenarioId: "cases.related-work", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { case: structuredClone(row), followup, unrelated, privateTask: { id: "private", identifier: "PRV-1", title: "Private customer" }, privateMarker: "PRIVATE-SENTINEL" },
    tasks: [primary, followup, unrelated], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], humanQueries: [], runs: [], links: ["/ACN/issues/ACN-1", "/ACN/issues/ACN-2", "/ACN/issues/ACN-3"],
    caseDetail: { ...row, issueLinks: [{ issueId: "primary", role: "work" }, { issueId: "followup", role: "reference" }] }, reverseLinks: { primary: [{ role: "work", case: structuredClone(row) }], followup: [{ role: "reference", case: structuredClone(row) }] }, deniedStatus: 404,
    reply: "| Task | Role | Owner | Status |\n|---|---|---|---|\n| ACN-1 Investigation | work | Morgan | done |\n| ACN-2 Mobile follow-up | reference | unassigned | backlog |\n\nNot tied: ACN-3 Mobile follow-up investigation has a similar title but is explicitly unrelated and has no case link.\n\nThe case remains open." };
}
describe("recorded overview blocker and per-task state grounding", () => {
  it("accepts the observed bullet/conditional form without requiring an incidental nonce", () => { expect(grade_activity(overview()).passed).toBe(true); });
  it("does not treat explicit non-approval or future approval as resolved", () => {
    const v = overview(); v.reply += "\nACN-2 is blocked; its colors are not approved."; expect(grade_activity(v).passed).toBe(true);
  });
  it.each([
    ["wrong reason", (v: ReturnType<typeof overview>) => { v.reply = v.reply.replace("Waiting on approved launch colors", "Waiting on database access"); }],
    ["reason on wrong task", (v: ReturnType<typeof overview>) => { v.reply = v.reply.replace("Waiting on approved launch colors", "Waiting for a decision").replace("assigned to the board.", "assigned to the board. Waiting on approved launch colors."); }],
    ["wrong active state despite a matching count label", (v: ReturnType<typeof overview>) => { v.reply = v.reply.replace("in progress, assigned", "blocked (1 active task), assigned"); }],
    ["wrong active state", (v: ReturnType<typeof overview>) => { v.reply = v.reply.replace("in progress, assigned", "blocked, assigned"); }],
    ["wrong done state", (v: ReturnType<typeof overview>) => { v.reply = v.reply.replace("— done, unassigned", "— in progress, unassigned"); }],
    ["wrong blocked state", (v: ReturnType<typeof overview>) => { v.reply = v.reply.replace("— blocked, unassigned", "— done, unassigned"); }],
    ["false resolution", (v: ReturnType<typeof overview>) => { v.reply += "\nACN-2 colors are approved and it is ready."; }],
    ["false readiness after conditional", (v: ReturnType<typeof overview>) => { v.reply += "\nACN-2 can't move until the palette is approved, but is ready now."; }],
    ["later contradictory state", (v: ReturnType<typeof overview>) => { v.reply += "\nACN-2 is now completed."; }],
    ["missing task link", (v: ReturnType<typeof overview>) => { v.links.shift(); }],
    ["hidden work", (v: ReturnType<typeof overview>) => { v.reply += " HIDDEN-SENTINEL"; }],
    ["wrong recorded blocker", (v: ReturnType<typeof overview>) => { v.state.blockedTask = { ...v.state.blockedTask, description: "Waiting for legal review." }; }],
  ])("rejects %s", (_name, mutate) => { const v = overview(); mutate(v); expect(grade_activity(v).passed).toBe(false); });
});
describe("actual work/reference roles and explicit negative related-work context", () => {
  it("accepts recorded work/reference table roles and a visibly linked but explicitly unrelated accessible task", () => { expect(gradeIntegratorRelatedWork(related()).passed).toBe(true); });
  it("retains harmless external references with title-grounded actual work", () => { const v=related();v.reply="The main Investigation task is done after change PR-123.\nIts reference Mobile follow-up remains backlog.\nACN-3 is explicitly unrelated and has no case link."; expect(gradeIntegratorRelatedWork(v).passed).toBe(true); });
  it("retains harmless external numeric issue references", () => { const v=related();v.reply="The main Investigation task is done after [a change](https://github.com/acme/repo/issues/123).\nIts reference Mobile follow-up remains backlog.\nACN-3 is explicitly unrelated and has no case link."; expect(gradeIntegratorRelatedWork(v).passed).toBe(true); });
  it("accepts a direct denial of case membership", () => { const v=related();v.reply=v.reply.replace("has a similar title but is explicitly unrelated and has no case link", "is not part of this case"); expect(gradeIntegratorRelatedWork(v).passed).toBe(true); });
  it.each([
    ["wrong local identifier despite correct identifier URL", (v: ReturnType<typeof related>) => { v.reply = v.reply.replace("ACN-1 Investigation", "[ACN-9 Investigation](/ACN/issues/ACN-1)"); }],
    ["wrong local identifier despite copied title and correct URL", (v: ReturnType<typeof related>) => { v.reply = v.reply.replace("ACN-1 Investigation", "[ACN-9 Investigation](/ACN/issues/primary)"); }],
    ["explicit foreign issue resource with copied title", (v: ReturnType<typeof related>) => { v.reply = v.reply.replace("ACN-1 Investigation", "[ZZZ-9 Investigation](/ZZZ/issues/ZZZ-9)"); }],
    ["foreign primary identifier with copied title", (v: ReturnType<typeof related>) => { v.reply = v.reply.replace("ACN-1 Investigation", "ACN-9 Investigation"); }],
    ["foreign reference identifier with copied title", (v: ReturnType<typeof related>) => { v.reply = v.reply.replace("ACN-2 Mobile follow-up", "ACN-9 Mobile follow-up"); }],
    ["swapped primary role", (v: ReturnType<typeof related>) => { v.reply = v.reply.replace("ACN-1 Investigation | work", "ACN-1 Investigation | reference"); }],
    ["swapped reference role", (v: ReturnType<typeof related>) => { v.reply = v.reply.replace("ACN-2 Mobile follow-up | reference", "ACN-2 Mobile follow-up | work"); }],
    ["primary falsely incomplete", (v: ReturnType<typeof related>) => { v.reply = v.reply.replace("Morgan | done", "Morgan | backlog"); }],
    ["followup falsely done", (v: ReturnType<typeof related>) => { v.reply = v.reply.replace("unassigned | backlog", "unassigned | done"); }],
    ["unrelated link without denial", (v: ReturnType<typeof related>) => { v.reply = v.reply.replace(/Not tied:[^\n]+/, "ACN-3 is another task."); }],
    ["unrelated asserted reference", (v: ReturnType<typeof related>) => { v.reply += "\nACN-3 is a reference."; }],
    ["denial plus contradictory assertion", (v: ReturnType<typeof related>) => { v.reply = v.reply.replace("has no case link", "has no case link but actually is a reference"); }],
    ["private identifier", (v: ReturnType<typeof related>) => { v.reply += "\nPRV-1 is also involved."; }],
    ["foreign private link", (v: ReturnType<typeof related>) => { v.links.push("https://other.test/issues/private"); }],
    ["case-varied private marker", (v: ReturnType<typeof related>) => { v.reply += "\nprivate-sentinel"; }],
    ["private title", (v: ReturnType<typeof related>) => { v.reply += "\nPrivate customer has work too."; }],
    ["private marker", (v: ReturnType<typeof related>) => { v.reply += "\nPRIVATE-SENTINEL"; }],
    ["private link", (v: ReturnType<typeof related>) => { v.links.push("/PRV/issues/PRV-1"); }],
    ["private access unexpectedly allowed", (v: ReturnType<typeof related>) => { v.deniedStatus = 200; }],
    ["lost reverse relationship", (v: ReturnType<typeof related>) => { v.reverseLinks.followup = []; }],
    ["relationship mutation", (v: ReturnType<typeof related>) => { v.caseDetail.handoffVersion++; }],
    ["new unrelated link relationship", (v: ReturnType<typeof related>) => { v.caseDetail.issueLinks.push({ issueId: "unrelated", role: "reference" }); }],
    ["later false primary state", (v: ReturnType<typeof related>) => { v.reply += "\n| ACN-1 Investigation | work | Morgan | backlog |"; }],
  ])("rejects %s", (_name, mutate) => { const v = related(); mutate(v); expect(gradeIntegratorRelatedWork(v).passed).toBe(false); });
});
