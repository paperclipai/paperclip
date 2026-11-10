import { describe, expect, it } from "vitest";
import { grade_activity } from "./internal-activity.js";
import { gradeIntegratorRelatedWork } from "./integrator-case-related.js";
function overview() {
  const active = { id: "active", identifier: "ACN-1", title: "Website draft", status: "in_progress" };
  const blocked = { id: "blocked", identifier: "ACN-2", title: "Accessibility review", status: "blocked", description: "Waiting for approved launch colors nonce-1." };
  const done = { id: "done", identifier: "ACN-3", title: "Launch brief delivered", status: "done" };
  return { scenarioId: "activity.company-overview", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { task: active, blockedTask: blocked, doneTask: done, worker: { id: "morgan" }, blocker: "approved launch colors nonce-1", hiddenMarker: "HIDDEN-SENTINEL" },
    tasks: [active, blocked, done], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], humanQueries: [], runs: [{ id: "run", startedAt: "2026-11-09T15:25:52Z", finishedAt: "2026-11-09T15:26:20Z" }], agents: [{ id: "morgan", status: "idle" }], links: ["/ACN/issues/ACN-1", "/ACN/issues/ACN-2", "/ACN/issues/ACN-3"],
    reply: "Here's the picture as of 15:26 UTC:\n\n- **ACN-1 Website draft** — in progress, assigned to the board.\n- **ACN-2 Accessibility review** — blocked, unassigned. Waiting on approved launch colors, but there are zero approvals on record.\n- **ACN-3 Launch brief delivered** — done, unassigned.\n\nMorgan is idle.\n\nNeeds a decision: ACN-2 can't move until the launch color palette is approved, and no approval card exists." };
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
describe("overview grades saved work state, links and the recorded blocker", () => {
  it("accepts the observed bullet/conditional form without requiring an incidental nonce", () => { expect(grade_activity(overview()).passed).toBe(true); });
  it("leaves per-task state, blocker and availability wording to a human reader", () => {
    const v = overview(); v.reply = v.reply.replace("Waiting on approved launch colors", "Waiting on database access").replace("in progress, assigned", "blocked, assigned").replace("Morgan is idle.", "Morgan is around.");
    expect(grade_activity(v).passed).toBe(true);
  });
  it.each([
    ["missing task link", (v: ReturnType<typeof overview>) => { v.links.shift(); }],
    ["hidden work", (v: ReturnType<typeof overview>) => { v.reply += " HIDDEN-SENTINEL"; }],
    ["wrong recorded blocker", (v: ReturnType<typeof overview>) => { v.state.blockedTask = { ...v.state.blockedTask, description: "Waiting for legal review." }; }],
    ["blocked task resolved", (v: ReturnType<typeof overview>) => { v.tasks[1] = { ...v.tasks[1]!, status: "todo" }; }],
    ["idle worker woken", (v: ReturnType<typeof overview>) => { v.runs.push({ id: "morgan-run", agentId: "morgan" } as never); }],
    ["worker not idle", (v: ReturnType<typeof overview>) => { v.agents[0]!.status = "error"; }],
  ])("rejects %s", (_name, mutate) => { const v = overview(); mutate(v); expect(grade_activity(v).passed).toBe(false); });
});
describe("overview observation time", () => {
  const failed = (v: ReturnType<typeof overview>) => grade_activity(v).checks.filter(check => !check.passed).map(check => check.id);
  it.each([
    ["24-hour UTC time", "as of 15:26 UTC"],
    ["12-hour time", "at 3:25 pm UTC"],
    ["ISO timestamp", "(snapshot 2026-11-09T15:26:05Z)"],
    ["ISO timestamp at the window's last second", "(snapshot 2026-11-09T15:31:20Z)"],
    ["ISO timestamp with an offset", "(snapshot 2026-11-09T10:26:05-05:00)"],
    ["dated time without an offset", "as of 2026-11-09 15:26"],
    ["dated 12-hour time", "as of 2026-11-09 03:26 PM UTC"],
    ["dated time with a comma and 'at'", "as of 2026-11-09, at 3:26 pm"],
  ])("accepts %s inside the answering run", (_name, phrase) => {
    const v = overview(); v.reply = v.reply.replace("as of 15:26 UTC", phrase); expect(failed(v)).toEqual([]);
  });
  it("accepts the browser timezone the setup recorded", () => {
    const v = overview(); (v.state as Record<string, unknown>).timezone = "America/Chicago";
    v.reply = v.reply.replace("as of 15:26 UTC", "as of 9:26 AM"); expect(failed(v)).toEqual([]);
  });
  it.each([
    ["relative words only (the retained live reply's form)", "right now"],
    ["a time outside the run", "as of 11:40 UTC"],
    ["an a.m. time that is twelve hours off", "as of 3:26 am UTC"],
    ["a 24-hour time that is twelve hours off", "as of 03:26 UTC"],
    ["an ISO timestamp on another day", "(snapshot 2026-11-08T15:26:05Z)"],
    ["an ISO timestamp whose offset puts it outside the run", "(snapshot 2026-11-09T15:26:05-05:00)"],
    ["a dated time on another day", "as of 2026-11-08 15:26"],
    ["an ISO timestamp seconds after the window closes", "(snapshot 2026-11-09T15:31:59Z)"],
    ["a dated 12-hour time on the wrong half of the day", "as of 2026-11-09 03:26 AM UTC"],
  ])("rejects %s", (_name, phrase) => {
    const v = overview(); v.reply = v.reply.replace("as of 15:26 UTC", phrase); expect(failed(v)).toEqual(["observation-time"]);
  });
  it("rejects a time in a link target rather than in the answer", () => {
    const v = overview(); v.reply = v.reply.replace("as of 15:26 UTC", "right now ([log](/ACN/runs/15:26))"); expect(failed(v)).toEqual(["observation-time"]);
  });
  it("rejects an answer with no recorded run window", () => {
    const v = overview(); v.runs = []; expect(failed(v)).toEqual(["observation-time"]);
  });
});
describe("actual work/reference roles and explicit negative related-work context", () => {
  it("accepts recorded work/reference table roles and a visibly linked but explicitly unrelated accessible task", () => { expect(gradeIntegratorRelatedWork(related()).passed).toBe(true); });
  it("retains harmless external references with title-grounded actual work", () => { const v=related();v.reply="The main Investigation task is done after change PR-123.\nIts reference Mobile follow-up remains backlog.\nACN-3 is explicitly unrelated and has no case link."; expect(gradeIntegratorRelatedWork(v).passed).toBe(true); });
  it("retains harmless external numeric issue references", () => { const v=related();v.reply="The main Investigation task is done after [a change](https://github.com/acme/repo/issues/123).\nIts reference Mobile follow-up remains backlog.\nACN-3 is explicitly unrelated and has no case link."; expect(gradeIntegratorRelatedWork(v).passed).toBe(true); });
  it("accepts the retained product-vocabulary role wording without requiring primary/main", () => {
    const v = related();
    v.reply = "Case ACN-C1 has 2 tasks tied to it:\n\n- [ACN-1](/ACN/issues/ACN-1) — **Investigation** · work task · **done** · owner: Morgan.\n- [ACN-2](/ACN/issues/ACN-2) — **Mobile follow-up** · reference task · **backlog**, unassigned.\n\n[ACN-3](/ACN/issues/ACN-3) has a similar title but is explicitly unrelated and not linked to any case, so it is excluded.";
    expect(gradeIntegratorRelatedWork(v).passed).toBe(true);
    v.reply = v.reply.replace("work task", "the task this case was opened for").replace("reference task", "a follow-up linked for reference");
    expect(gradeIntegratorRelatedWork(v).passed).toBe(true);
    v.reply = "ACN-1 Investigation is the work task and is done, not a reference task. ACN-2 Mobile follow-up is a reference task in backlog, not the primary task.\nACN-3 is explicitly unrelated and has no case link.";
    expect(gradeIntegratorRelatedWork(v).passed).toBe(true);
    for (const denial of ["rather than the primary task", "instead of the main task", "as opposed to the work task"]) {
      v.reply = `ACN-1 Investigation is the work task and is done. ACN-2 Mobile follow-up is a reference task in backlog, ${denial}.\nACN-3 is explicitly unrelated and has no case link.`;
      expect(gradeIntegratorRelatedWork(v).passed, denial).toBe(true);
    }
    v.reply = "- ACN-1 Investigation \u2014 role: work; status: done\n- ACN-2 Mobile follow-up \u2014 role: reference; status: backlog. It follows up the primary investigation.\nACN-3 is explicitly unrelated and has no case link.";
    expect(gradeIntegratorRelatedWork(v).passed).toBe(true);
  });
  it.each([
    ["primary called the reference task", "ACN-1 Investigation is the reference task and is done. ACN-2 Mobile follow-up is linked and in backlog."],
    ["follow-up called the work task", "ACN-1 Investigation is done. ACN-2 Mobile follow-up is the work task and is in backlog."],
    ["follow-up called primary", "ACN-1 Investigation is done. ACN-2 Mobile follow-up is the primary task and is in backlog."],
    ["dash-separated swapped labels", "- ACN-1 Investigation - reference - done\n- ACN-2 Mobile follow-up - primary - backlog"],
    ["em-dash swapped labels", "- ACN-1 Investigation \u2014 reference \u2014 done\n- ACN-2 Mobile follow-up \u2014 primary \u2014 backlog"],
    ["dot-separated swapped labels", "- ACN-1 Investigation \u00b7 reference task \u00b7 done\n- ACN-2 Mobile follow-up \u00b7 work task \u00b7 backlog"],
    ["bold dash-separated swapped labels", "- ACN-1 Investigation \u2014 **reference** \u2014 done\n- ACN-2 Mobile follow-up \u2014 **primary** \u2014 backlog"],
    ["role label swapped", "- ACN-1 Investigation \u2014 role: reference; status: done\n- ACN-2 Mobile follow-up \u2014 role: work; status: backlog"],
  ])("rejects prose role contradiction: %s", (_name, reply) => {
    const v = related(); v.reply = `${reply}\nACN-3 is explicitly unrelated and has no case link.`; expect(gradeIntegratorRelatedWork(v).passed).toBe(false);
  });
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
