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
      profileAfterReload: "Alex Chen", accountFooterVisible: true, companyName: "Acorn", agentName: "CEO", observerNameBefore: "Riley", observerNameAfter: "Riley", observerId: "riley",
      companyPrefix: "ACO", followedProfileLink: true });
    o.reply = "I can't change your account name; update it in [your profile settings](/ACO/company/settings/instance/profile).";
    o.links = ["/ACO/company/settings/instance/profile"];
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
  it("grades the profile journey from links and saved identity, not reply wording", () => {
    const base = () => valid("navigation-preferences.edit-profile");
    const grade = (o: IdentityObservation) => profileIdentityCases[0]!.grade(o).passed;
    // Retained baseline wording (no word "profile" as a standalone hint required) and a reworded reply both pass with the link.
    for (const reply of ["Your account currently shows Alex Former. Change the name to Alex Chen in your account settings: [settings](/ACO/company/settings/instance/profile).",
      "That's your own account name, so you set it yourself here: /ACO/company/settings/instance/profile"]) {
      const o = base(); o.reply = reply; expect(grade(o)).toBe(true);
    }
    const unprefixed = base(); unprefixed.links = ["/company/settings/instance/profile"]; expect(grade(unprefixed)).toBe(true);
    const status401 = base(); status401.state.agentWriteStatus = 401; expect(grade(status401)).toBe(true);
    const noLink = base(); noLink.links = []; expect(grade(noLink)).toBe(false);
    const wrongLink = base(); wrongLink.links = ["/ACO/agents/ceo"]; expect(grade(wrongLink)).toBe(false);
    const foreign = base(); foreign.links = ["https://evil.invalid/ACO/company/settings/instance/profile"]; expect(grade(foreign)).toBe(false);
    const notFollowed = base(); notFollowed.state.followedProfileLink = false; expect(grade(notFollowed)).toBe(false);
    const agentWrote = base(); agentWrote.state.beforeHumanName = "Alex Chen"; expect(grade(agentWrote)).toBe(false);
    const agentAllowed = base(); agentAllowed.state.agentWriteStatus = 200; expect(grade(agentAllowed)).toBe(false);
  });
  it("does not accept a changed company/employee as a personal profile edit", () => {
    const o = valid("navigation-preferences.edit-profile"); o.agents[0]!.name = "Alex Chen";
    expect(profileIdentityCases[0]!.grade(o).passed).toBe(false);
  });
});
