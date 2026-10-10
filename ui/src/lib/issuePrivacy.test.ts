import { describe, expect, it } from "vitest";
import type { IssueAccessGrant } from "@paperclipai/shared";
import {
  agentVisibilityFromPermissions,
  canManageIssuePrivacy,
  canManageProjectPrivacy,
  grantIsRevocable,
  grantIsSharedAgent,
  isSharedAgentVisibility,
} from "./issuePrivacy";

describe("agentVisibilityFromPermissions", () => {
  it("reads the nested authorizationPolicy.agentVisibility.mode", () => {
    expect(
      agentVisibilityFromPermissions({ authorizationPolicy: { agentVisibility: { mode: "discoverable" } } }),
    ).toBe("discoverable");
    expect(
      agentVisibilityFromPermissions({ authorizationPolicy: { agentVisibility: { mode: "private" } } }),
    ).toBe("private");
  });

  it("returns null for malformed / missing shapes", () => {
    expect(agentVisibilityFromPermissions(null)).toBeNull();
    expect(agentVisibilityFromPermissions({})).toBeNull();
    expect(agentVisibilityFromPermissions({ authorizationPolicy: {} })).toBeNull();
    expect(
      agentVisibilityFromPermissions({ authorizationPolicy: { agentVisibility: { mode: "bogus" } } }),
    ).toBeNull();
  });
});

describe("isSharedAgentVisibility", () => {
  it("treats anything not explicitly private as shared", () => {
    expect(isSharedAgentVisibility("discoverable")).toBe(true);
    expect(isSharedAgentVisibility("private")).toBe(false);
    expect(isSharedAgentVisibility(null)).toBe(true);
  });
});

describe("grantIsSharedAgent", () => {
  const base: IssueAccessGrant = {
    id: "g1",
    issueId: "i1",
    subjectType: "agent",
    subjectId: "a1",
    source: "explicit",
    grantedByUserId: null,
    grantedByAgentId: null,
    createdAt: new Date(),
    revokedAt: null,
    subjectDisplayName: "Helper",
    subjectAvatarUrl: null,
    subjectInitials: "H",
    agentVisibility: "discoverable",
  };

  it("is true only for non-private agents", () => {
    expect(grantIsSharedAgent(base)).toBe(true);
    expect(grantIsSharedAgent({ ...base, agentVisibility: "private" })).toBe(false);
    expect(grantIsSharedAgent({ ...base, subjectType: "user", agentVisibility: null })).toBe(false);
  });
});

describe("grantIsRevocable", () => {
  it("allows explicit + assignment, never project", () => {
    expect(grantIsRevocable("explicit")).toBe(true);
    expect(grantIsRevocable("assignment")).toBe(true);
    expect(grantIsRevocable("project")).toBe(false);
  });
});

describe("canManageIssuePrivacy", () => {
  const issue = { companyId: "c1", responsibleUserId: "responsible", createdByUserId: "creator", assigneeUserId: "assignee" };
  const access = (role: string) => ({ source: "session", isInstanceAdmin: false, companyIds: ["c1"],
    memberships: [{ companyId: "c1", status: "active", membershipRole: role }] }) as Parameters<typeof canManageIssuePrivacy>[2];
  it("allows task principals even with viewer membership", () => {
    for (const user of ["responsible", "creator", "assignee"]) expect(canManageIssuePrivacy(issue, user, access("viewer"))).toBe(true);
  });
  it("does not treat ordinary runtime management as privacy ownership", () => {
    expect(canManageIssuePrivacy(issue, "other", access("member"))).toBe(false);
    expect(canManageIssuePrivacy(issue, "other", access("admin"))).toBe(true);
    expect(canManageIssuePrivacy(issue, "other", access("owner"))).toBe(true);
  });
});

describe("canManageProjectPrivacy", () => {
  it("keeps project read membership separate from privacy management", () => {
    const access = { source: "session", isInstanceAdmin: false, memberships: [{ companyId: "c1", status: "active", membershipRole: "member" }] } as Parameters<typeof canManageProjectPrivacy>[2];
    const project = { companyId: "c1", privacyOwnerUserId: "owner" };
    expect(canManageProjectPrivacy(project, "reader", access)).toBe(false);
    expect(canManageProjectPrivacy(project, "owner", access)).toBe(true);
  });
});
