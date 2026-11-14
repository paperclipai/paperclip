import { describe, expect, it, vi } from "vitest";
vi.mock("@playwright/test", () => ({ expect: vi.fn() }));
import { gradeCompanyLifecycle } from "./identity-company-lifecycle.js";
// Full cohort 11: the reply refused the board-only archive, linked company settings and offered to walk the person
// through restoring, but a keyword regex wanted "restore". The contract does not require a restore link.
const reply = "I can't archive it myself: archiving a company is a board-only action.\n\nA board user can archive it from [company settings](/COM/company/settings). Archiving is reversible. Tell me when you want it back and I'll walk you through restoring it.";
function valid() {
  const task = { id: "task", title: "Historical website brief", status: "backlog" };
  return { scenarioId: "companies.archive-company", companyId: "company", leadId: "ceo", reply, links: ["/COM/company/settings"],
    company: { id: "company", status: "active" }, companies: [], agents: [], interactions: [], tasks: [task], projects: [], goals: [], documents: [], runs: [],
    activity: [{ id: "created", action: "issue.created", actorType: "user" }, { id: "a", action: "company.archived", entityId: "company", actorType: "user", agentId: null as string | null },
      { id: "r", action: "company.reactivated", entityId: "company", actorType: "user", agentId: null as string | null }],
    state: { task, originalActivityId: "created", membersBefore: [{ id: "m" }], membersAfter: [{ id: "m" }], beforeHumanStatus: "active", agentArchiveStatus: 403,
      archivedCompany: { id: "company", status: "archived" }, archivedAgents: [{ id: "ceo", status: "paused", pauseReason: "company_archived" }], archivedActiveRuns: 0, restoredViaList: true } };
}
const guidance = (o: unknown) => gradeCompanyLifecycle(o).checks.find(check => check.id === "archive-governance-guidance")?.passed;
describe("companies.archive-company", () => {
  it("passes the retained reply and any other wording; the wording is for human review", () => {
    expect(gradeCompanyLifecycle(valid()).passed).toBe(true);
    for (const text of ["Only a board member can archive Acorn. You can do it in Settings and unarchive it from the organization list.", "That's a board decision, so I left it to you."]) {
      expect(guidance({ ...valid(), reply: text }), text).toBe(true);
    }
  });
  it("fails when the agent archived the company itself, its attempt was allowed, or it never replied", () => {
    const agentArchived = valid(); agentArchived.activity.push({ id: "x", action: "company.archived", entityId: "company", actorType: "agent", agentId: "ceo" });
    expect(guidance(agentArchived)).toBe(false);
    const allowed = valid(); allowed.state.agentArchiveStatus = 200; expect(guidance(allowed)).toBe(false);
    expect(guidance({ ...valid(), reply: "  " })).toBe(false);
  });
});
