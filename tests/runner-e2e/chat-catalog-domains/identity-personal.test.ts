import { describe, expect, it } from "vitest";
import { profileIdentityCases } from "./identity-profile.js";
import { companyLifecycleIdentityCases } from "./identity-company-lifecycle.js";
import type { IdentityObservation } from "./identity-support.js";
function valid(id: string): IdentityObservation {
  const task = { id: "task", title: "Historical brief", description: "Retain", companyId: "acorn", status: "backlog", projectId: "project" };
  const o: IdentityObservation = { scenarioId: id, origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn", name: "Acorn", status: "active" },
    companies: [], agents: [{ id: "ceo", companyId: "acorn", name: "CEO" }], interactions: [], tasks: [task], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], links: [], runs: [], reply: "", humanQueries: [], state: { task: { ...task } } };
  if (id === "navigation-preferences.edit-profile") {
    Object.assign(o.state, { authenticated: true, personId: "alex", beforeHumanName: "Alex Former", agentWriteStatus: 403, afterUserId: "alex", afterName: "Alex Chen",
      profileAfterReload: "Alex Chen", accountFooterVisible: true, companyName: "Acorn", agentName: "CEO", observerNameBefore: "Riley", observerNameAfter: "Riley", observerId: "riley" });
    o.reply = "Please open your Profile settings and change the display name there.";
  } else if (id === "companies.switch-company") {
    const foreign = { ...task, id: "birch-task", companyId: "birch" };
    Object.assign(o.state, { otherCompany: { id: "birch" }, foreignTask: foreign, foreignAfter: { ...foreign }, foreignMarker: "Hidden Birch account details",
      agentForeignReadStatus: 403, switchedCompanyId: "birch", browserCompanyPrefix: "BIR", foreignPrefix: "BIR", foreignTaskVisible: true, afterReloadVisible: true, humanOwnsBoth: true });
    o.reply = "Select Birch in the company switcher to view its own team.";
  } else {
    o.reply = "You can archive this organization in Settings and restore it later from the organization list.";
    Object.assign(o.state, { beforeHumanStatus: "active", agentArchiveStatus: 403, archivedCompany: { id: "acorn", status: "archived" },
      archivedAgents: [{ id: "ceo", status: "paused", pauseReason: "company_archived" }], archivedActiveRuns: 0, restoredViaList: true,
      membersBefore: [{ id: "member", principalId: "alex" }], membersAfter: [{ id: "member", principalId: "alex" }], originalActivityId: "created" });
    o.activity = [{ id: "archive", action: "company.archived", entityId: "acorn", actorType: "user" },
      { id: "restore", action: "company.reactivated", entityId: "acorn", actorType: "user" }, { id: "created", action: "issue.created", entityId: "task" }];
  }
  return o;
}
describe("personal identity and company lifecycle oracles", () => {
  for (const definition of [...profileIdentityCases, ...companyLifecycleIdentityCases]) {
    it(`${definition.scenarioId}: valid, wrong actor/scope and missing evidence`, () => {
      const o = valid(definition.scenarioId); expect(definition.grade(o), JSON.stringify(definition.grade(o).checks)).toMatchObject({ passed: true });
      const wrong = structuredClone(o);
      if (definition.scenarioId === "navigation-preferences.edit-profile") wrong.state.afterUserId = "someone-else";
      else if (definition.scenarioId === "companies.switch-company") wrong.state.browserCompanyPrefix = "ACO";
      else wrong.state.archivedActiveRuns = 1;
      expect(definition.grade(wrong).passed).toBe(false); expect(definition.grade(undefined).passed).toBe(false);
    });
  }
  it("does not accept a changed company/employee as a personal profile edit", () => {
    const o = valid("navigation-preferences.edit-profile"); o.agents[0]!.name = "Alex Chen";
    expect(profileIdentityCases[0]!.grade(o).passed).toBe(false);
  });
});
