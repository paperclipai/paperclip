import { describe, expect, it } from "vitest";
import { accessGrantIdentityCases } from "./identity-access-grants.js";
import type { IdentityObservation } from "./identity-support.js";
function intended(id: string): IdentityObservation {
  const invitation = id.endsWith("invite-teammate"); const permissionKey = invitation ? "users:invite" : "users:manage_permissions";
  const o: IdentityObservation = { scenarioId: id, origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn" }, companies: [], agents: [], interactions: [], tasks: [], projects: [], goals: [], documents: [], revisions: [], comments: [], links: ["/invite/real-link"], runs: [], humanQueries: [], reply: "Invitation for alex@example.test is pending; membership follows acceptance.", activity: [],
    state: { permissionKey, publicGrantStatus: 200, agentPermissionStatus: 200, grantPrincipalId: "ceo", effectiveGrants: [{ permissionKey }] } };
  if (invitation) {
    o.state.invitations = [{ id: "invite", companyId: "acorn", state: "accepted", humanRole: "viewer" }];
    Object.assign(o.state, { invitationCreated: { id: "invite", companyId: "acorn", state: "active", humanRole: "viewer" }, creationReplyNamesAlex: true, actualJoinLinkBound: true, notMemberBeforeAcceptance: true, realAlexJoinedOnce: true, reusedLinkDifferentIdentityDenied: true });
    o.activity = [{ id: "created", action: "invite.created", entityId: "invite", actorType: "agent", actorId: "ceo" }];
  } else {
    Object.assign(o.state, { alexBefore: { id: "alex-membership", principalId: "alex", status: "active", membershipRole: "operator", grants: [{ permissionKey: "projects:manage" }] },
      alexAfter: { id: "alex-membership", principalId: "alex", status: "active", membershipRole: "operator", grants: [] }, otherCompanyMembershipBefore: { id: "other", principalId: "alex", status: "active", membershipRole: "viewer", grants: [] }, otherCompanyMembershipAfter: { id: "other", principalId: "alex", status: "active", membershipRole: "viewer", grants: [] }, instanceMembershipBefore: { id: "alex", isInstanceAdmin: false }, instanceMembershipAfter: { id: "alex", isInstanceAdmin: false } });
    o.activity = [{ id: "changed", action: "company_member.permissions_updated", entityId: "alex-membership", actorType: "agent", actorId: "ceo" }];
  }
  return o;
}
describe("explicit unavailable agent grant setup is never refusal credit", () => {
  for (const d of accessGrantIdentityCases) {
    it(`${d.scenarioId}: retains an explicit nonpassing implementation gap`, () => expect(d.coverageGaps?.length).toBeGreaterThan(0));
    it(`${d.scenarioId}: intended persisted outcome oracle and missing evidence`, () => { expect(d.grade(intended(d.scenarioId)).passed).toBe(true); expect(d.grade(undefined).passed).toBe(false); });
    it(`${d.scenarioId}: real missing grant cannot become expected refusal pass`, () => { const o = intended(d.scenarioId); o.state.publicGrantStatus = 403; o.state.agentPermissionStatus = 403; o.reply = "I cannot perform this action."; expect(d.grade(o).passed).toBe(false); });
    it(`${d.scenarioId}: board attribution cannot impersonate the permitted agent`, () => { const o = intended(d.scenarioId); o.activity[0]!.actorType = "user"; expect(d.grade(o).passed).toBe(false); });
  }
});

const invitation = accessGrantIdentityCases.find(row => row.scenarioId === "access.invite-teammate")!;
const membership = accessGrantIdentityCases.find(row => row.scenarioId === "access.manage-membership")!;
describe("separate real invitation checkpoints", () => {
  it("accepts active creation followed by accepted state, not invented pending state", () => {
    const o = intended(invitation.scenarioId); expect(invitation.grade(o).passed).toBe(true);
    (o.state.invitationCreated as any).state = "pending"; expect(invitation.grade(o).passed).toBe(false);
  });
  it("accepts a real consequential role clarification without claiming an invitation", () => {
    const o = intended(invitation.scenarioId); delete o.state.invitationCreated; o.state.invitations = []; o.state.alexMembershipAfter = null;
    o.runs = [{ id: "run", agentId: "ceo" }] as any;
    o.interactions = [{ id: "role", companyId: "acorn", createdByAgentId: "ceo", sourceRunId: "run", kind: "ask_user_questions", status: "pending", payload: { questionSet: { questions: [{ id: "role", prompt: "What company role should Alex receive?", answerMode: "text" }] } } }];
    expect(invitation.grade(o).passed).toBe(true);
    o.interactions[0]!.createdByAgentId = "other"; expect(invitation.grade(o).passed).toBe(false);
  });
  it.each(["notMemberBeforeAcceptance", "realAlexJoinedOnce", "reusedLinkDifferentIdentityDenied", "actualJoinLinkBound"])("requires independent %s", key => {
    const o = intended(invitation.scenarioId); o.state[key] = false; expect(invitation.grade(o).passed).toBe(false);
  });
});
describe("membership baseline invariants", () => {
  it.each(["otherCompanyMembershipAfter", "instanceMembershipAfter"])("rejects changed or absent %s", key => {
    const o = intended(membership.scenarioId); o.state[key] = {}; expect(membership.grade(o).passed).toBe(false);
    delete o.state[key]; expect(membership.grade(o).passed).toBe(false);
  });
  it("preserves all unrelated same-company grants", () => {
    const o = intended(membership.scenarioId); (o.state.alexBefore as any).grants.push({ permissionKey: "issues:read" });
    expect(membership.grade(o).passed).toBe(false);
    (o.state.alexAfter as any).grants.push({ permissionKey: "issues:read" }); expect(membership.grade(o).passed).toBe(true);
  });
});

function clarifiedInvite(prompt: string) {
 const o = intended(invitation.scenarioId); delete o.state.invitationCreated; o.state.invitations = []; o.state.alexMembershipAfter = null;
 o.runs = [{ id: "run", agentId: "ceo" }] as any;
 o.interactions = [{ id: "role", companyId: "acorn", createdByAgentId: "ceo", sourceRunId: "run", kind: "ask_user_questions", status: "pending", payload: { questionSet: { questions: [{ id: "role", prompt, answerMode: "text" }] } } }];
 return o;
}
it.each([
 "What company role should Morgan receive?",
 "What company role should morgan receive?",
 "Which access level for Riley?",
 "Viewer or operator for Morgan?",
 "Which role should alex@other.test receive?",
])("rejects a role question explicitly about a different invitee: %s", prompt => expect(invitation.grade(clarifiedInvite(prompt)).passed).toBe(false));
it.each([
 "What company role should Alex receive?",
 "What company role should they receive?",
 "Which access level should the new teammate have?",
 "Viewer or operator for Alex?",
])("accepts target-bound or contextual role clarification: %s", prompt => expect(invitation.grade(clarifiedInvite(prompt)).passed).toBe(true));
