import { describe, expect, it } from "vitest";
import {
  decidePrivateIssueAccess,
  type VisibilityContext,
  type VisibilityPrincipal,
} from "../services/issue-visibility.js";

const emptyCtx: VisibilityContext = {
  ownerCompanies: new Set(),
  grantedCompanies: new Set(),
  collabIssues: new Set(),
};

function privateIssue(overrides: Partial<{
  id: string;
  companyId: string;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
}> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    visibility: "private",
    createdByUserId: null,
    createdByAgentId: null,
    assigneeUserId: null,
    assigneeAgentId: null,
    ...overrides,
  };
}

const systemActor: VisibilityPrincipal = { kind: "system" };

describe("decidePrivateIssueAccess", () => {
  it("lets system actors see any issue", () => {
    expect(decidePrivateIssueAccess(systemActor, privateIssue(), emptyCtx)).toBe(true);
  });

  it("lets any principal see non-private issues", () => {
    const issue = { ...privateIssue(), visibility: "company" };
    expect(
      decidePrivateIssueAccess({ kind: "user", userId: "stranger" }, issue, emptyCtx),
    ).toBe(true);
  });

  it("lets instance admins see any private issue", () => {
    const principal: VisibilityPrincipal = {
      kind: "user",
      userId: "root",
      isInstanceAdmin: true,
    };
    expect(decidePrivateIssueAccess(principal, privateIssue(), emptyCtx)).toBe(true);
  });

  it("lets the creator see their own private issue", () => {
    const principal: VisibilityPrincipal = { kind: "user", userId: "u-creator" };
    const issue = privateIssue({ createdByUserId: "u-creator" });
    expect(decidePrivateIssueAccess(principal, issue, emptyCtx)).toBe(true);
  });

  it("lets the assignee user see the private issue", () => {
    const principal: VisibilityPrincipal = { kind: "user", userId: "u-assignee" };
    const issue = privateIssue({ assigneeUserId: "u-assignee" });
    expect(decidePrivateIssueAccess(principal, issue, emptyCtx)).toBe(true);
  });

  it("lets the assignee agent see the private issue", () => {
    const principal: VisibilityPrincipal = { kind: "agent", agentId: "a-assignee" };
    const issue = privateIssue({ assigneeAgentId: "a-assignee" });
    expect(decidePrivateIssueAccess(principal, issue, emptyCtx)).toBe(true);
  });

  it("lets company owners see private issues in their company", () => {
    const principal: VisibilityPrincipal = { kind: "user", userId: "u-owner" };
    const ctx: VisibilityContext = {
      ...emptyCtx,
      ownerCompanies: new Set(["company-1"]),
    };
    expect(decidePrivateIssueAccess(principal, privateIssue(), ctx)).toBe(true);
  });

  it("does not treat owner role in another company as access", () => {
    const principal: VisibilityPrincipal = { kind: "user", userId: "u-owner" };
    const ctx: VisibilityContext = {
      ...emptyCtx,
      ownerCompanies: new Set(["company-other"]),
    };
    expect(decidePrivateIssueAccess(principal, privateIssue(), ctx)).toBe(false);
  });

  it("lets principals with a see_private grant see private issues in that company", () => {
    const principal: VisibilityPrincipal = { kind: "user", userId: "u-admin" };
    const ctx: VisibilityContext = {
      ...emptyCtx,
      grantedCompanies: new Set(["company-1"]),
    };
    expect(decidePrivateIssueAccess(principal, privateIssue(), ctx)).toBe(true);
  });

  it("lets explicit collaborators see the private issue", () => {
    const principal: VisibilityPrincipal = { kind: "user", userId: "u-collab" };
    const ctx: VisibilityContext = {
      ...emptyCtx,
      collabIssues: new Set(["issue-1"]),
    };
    expect(decidePrivateIssueAccess(principal, privateIssue(), ctx)).toBe(true);
  });

  it("denies a user who is not creator, assignee, owner, grantee, or collaborator", () => {
    const principal: VisibilityPrincipal = { kind: "user", userId: "u-stranger" };
    expect(decidePrivateIssueAccess(principal, privateIssue(), emptyCtx)).toBe(false);
  });

  it("denies an agent who is not assignee or collaborator", () => {
    const principal: VisibilityPrincipal = { kind: "agent", agentId: "a-stranger" };
    expect(decidePrivateIssueAccess(principal, privateIssue(), emptyCtx)).toBe(false);
  });

  it("does not accidentally leak across issues in the same company", () => {
    const principal: VisibilityPrincipal = { kind: "user", userId: "u-collab" };
    const ctx: VisibilityContext = {
      ...emptyCtx,
      collabIssues: new Set(["other-issue"]),
    };
    expect(decidePrivateIssueAccess(principal, privateIssue(), ctx)).toBe(false);
  });
});
