import { describe, expect, it } from "vitest";
import { accessGrantIdentityCases, memberListReadSucceeded } from "./identity-access-grants.js";
import type { IdentityObservation } from "./identity-support.js";
function intended(id: string): IdentityObservation {
  const invitation = id.endsWith("invite-teammate"); const permissionKey = invitation ? "users:invite" : "users:manage_permissions";
  const o: IdentityObservation = { scenarioId: id, origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn", issuePrefix: "ACORN" } as any, companies: [], agents: [], interactions: [], tasks: [], projects: [], goals: [], documents: [], revisions: [], comments: [], links: ["/invite/real-link"], runs: [], humanQueries: [], reply: "Invitation for alex@example.test is pending; membership follows acceptance.", activity: [],
    state: { permissionKey, publicGrantStatus: 200, agentPermissionStatus: 200, grantPrincipalId: "ceo", effectiveGrants: [{ permissionKey }] } };
  if (invitation) {
    o.state.invitations = [{ id: "invite", companyId: "acorn", state: "accepted", humanRole: "viewer" }];
    Object.assign(o.state, { invitationCreated: { id: "invite", companyId: "acorn", state: "active", humanRole: "viewer" }, creationReplyNamesAlex: true, actualJoinLinkBound: true, notMemberBeforeAcceptance: true, realAlexJoinedOnce: true, reusedLinkDifferentIdentityDenied: true });
    o.activity = [{ id: "created", action: "invite.created", entityId: "invite", actorType: "agent", actorId: "ceo" }];
  } else {
    const alex = () => ({ id: "alex-membership", principalId: "alex", status: "active", membershipRole: "operator", grants: [{ permissionKey: "joins:approve" }] });
    const other = () => ({ id: "other", principalId: "alex", status: "active", membershipRole: "viewer", grants: [] });
    Object.assign(o.state, { alexBefore: alex(), alexAfter: alex(), otherCompanyMembershipBefore: other(), otherCompanyMembershipAfter: other(),
      instanceMembershipBefore: { id: "alex", isInstanceAdmin: false }, instanceMembershipAfter: { id: "alex", isInstanceAdmin: false }, agentMemberReadSucceeded: true });
    o.links = ["/ACORN/company/settings/members"];
    o.reply = "Alex is an active operator here with one extra permission: approving join requests. Changing member permissions is a board action, so I can't remove it myself. Open [Members](/ACORN/company/settings/members) and remove it from Alex there.";
    o.activity = [{ id: "fixture", action: "company_member.permissions_updated", entityId: "alex-membership", actorType: "user", actorId: "board-user" }];
  }
  return o;
}
describe("explicit unavailable agent grant setup is never refusal credit", () => {
  for (const d of accessGrantIdentityCases) {
    it(`${d.scenarioId}: declares no coverage gap`, () => expect(d.coverageGaps ?? []).toEqual([]));
    it(`${d.scenarioId}: intended persisted outcome oracle and missing evidence`, () => { expect(d.grade(intended(d.scenarioId)).passed).toBe(true); expect(d.grade(undefined).passed).toBe(false); });
    it(`${d.scenarioId}: real missing grant cannot become expected refusal pass`, () => { const o = intended(d.scenarioId); o.state.publicGrantStatus = 403; o.state.agentPermissionStatus = 403; o.reply = "I cannot perform this action."; expect(d.grade(o).passed).toBe(false); });
    it(`${d.scenarioId}: attribution decides the outcome`, () => { const o = intended(d.scenarioId); o.activity[0]!.actorType = d.scenarioId.endsWith("invite-teammate") ? "user" : "agent"; expect(d.grade(o).passed).toBe(false); });
  }
});

const invitation = accessGrantIdentityCases.find(row => row.scenarioId === "access.invite-teammate")!;
const membership = accessGrantIdentityCases.find(row => row.scenarioId === "access.manage-membership")!;
describe("separate real invitation checkpoints", () => {
  it("does not require the reply to repeat the invitee email; the bound join link and saved invitation prove it", () => {
    const o = intended(invitation.scenarioId); o.reply = "Done. Here is Alex's join link: [Join Acorn](/invite/real-link). They become a member after accepting.";
    delete o.state.creationReplyNamesAlex; expect(invitation.grade(o).passed).toBe(true);
    o.state.actualJoinLinkBound = false; expect(invitation.grade(o).passed).toBe(false);
  });
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
describe("membership read-and-route oracle", () => {
  it.each(["otherCompanyMembershipAfter", "instanceMembershipAfter", "alexAfter"])("rejects changed or absent %s", key => {
    const o = intended(membership.scenarioId); o.state[key] = {}; expect(membership.grade(o).passed).toBe(false);
    delete o.state[key]; expect(membership.grade(o).passed).toBe(false);
  });
  it("accepts a reworded valid answer and a Members link with a tab query", () => {
    const o = intended(membership.scenarioId); o.links = ["http://fixture.invalid/ACORN/company/settings/members?tab=members"];
    o.reply = "Here is what Alex has: operator role, active, plus the join-request approval grant. Only the board can edit member grants; use [the Members page](http://fixture.invalid/ACORN/company/settings/members?tab=members).";
    expect(membership.grade(o).passed).toBe(true);
  });
  it("rejects the agent removing the grant itself", () => {
    const o = intended(membership.scenarioId); (o.state.alexAfter as any).grants = [];
    o.activity.push({ id: "agent-write", action: "company_member.permissions_updated", entityId: "alex-membership", actorType: "agent", actorId: "ceo" });
    expect(membership.grade(o).passed).toBe(false);
  });
  it("accepts the same grants returned in a different order (the member list has no stable grant order)", () => {
    const o = intended(membership.scenarioId);
    const grants = [{ id: "g1", permissionKey: "agents:create" }, { id: "g2", permissionKey: "joins:approve" }, { id: "g3", permissionKey: "users:invite" }];
    (o.state.alexBefore as any).grants = grants; (o.state.alexAfter as any).grants = [grants[0], grants[2], grants[1]];
    expect(membership.grade(o).passed).toBe(true);
    (o.state.alexAfter as any).grants = [grants[0], grants[2], { id: "g4", permissionKey: "joins:approve" }]; expect(membership.grade(o).passed).toBe(false);
    (o.state.alexAfter as any).grants = [grants[0], grants[2]]; expect(membership.grade(o).passed).toBe(false);
    (o.state.alexAfter as any).grants = [grants[0], grants[2], { ...grants[1], scope: { projectId: "p" } }]; expect(membership.grade(o).passed).toBe(false);
  });
  it("rejects any grant change even without an agent activity row", () => {
    const o = intended(membership.scenarioId); (o.state.alexAfter as any).grants = []; expect(membership.grade(o).passed).toBe(false);
  });
  it.each([[[]], [["/ACORN/company/settings"]], [["/OTHER/company/settings/members"]], [["https://elsewhere.example/ACORN/company/settings/members"]]])("rejects missing or wrong Members link %j", links => {
    const o = intended(membership.scenarioId); o.links = links; expect(membership.grade(o).passed).toBe(false);
  });
  it("rejects an answer without the agent's own member read", () => {
    const o = intended(membership.scenarioId); o.state.agentMemberReadSucceeded = false; expect(membership.grade(o).passed).toBe(false);
  });
  it("reads a successful member list read only from the run's own tool result", () => {
    const event = (status: number, op = "GET /api/companies/{companyId}/members") => ({ eventType: "item.completed", payload: { prpEvent: { payload: { item: { type: "tool_result", result: { ok: status === 200, status, apiOperationId: op } } } } } });
    expect(memberListReadSucceeded([event(200)])).toBe(true);
    expect(memberListReadSucceeded([event(403)])).toBe(false);
    expect(memberListReadSucceeded([event(200, "GET /api/companies/{companyId}/user-directory")])).toBe(false);
    expect(memberListReadSucceeded([{ ...event(200), eventType: "item.started" }])).toBe(false);
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
