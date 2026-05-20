import { describe, expect, it } from "vitest";
import {
  branchMatchesSpec,
  deriveExpectedBranchSpec,
  extractBranchNamesFromText,
} from "../services/workspace-branch-preflight.js";

describe("workspace-branch-preflight", () => {
  it("extracts a github tree branch from issue description", () => {
    const branches = extractBranchNamesFromText(
      "Merge https://github.com/freddiesflowers/ff_redshift_dw/tree/DE-455_braintree_load into develop",
    );
    expect(branches).toEqual(["DE-455_braintree_load"]);
  });

  it("derives ff issue prefix when no explicit branch is configured", () => {
    const spec = deriveExpectedBranchSpec({
      issue: { id: "issue-1", identifier: "FF-442", title: "Branch enforcement", workMode: null },
      issueNumber: 442,
      issueDescription: null,
      persistedBranchName: null,
      projectPolicy: null,
      issueWorkspaceSettings: null,
      projectId: "project-1",
      repoRef: null,
    });
    expect(spec).toEqual({
      exact: null,
      prefix: "ff-442-",
      label: "ff-442-*",
    });
  });

  it("prefers persisted execution workspace branch over prefix heuristic", () => {
    const spec = deriveExpectedBranchSpec({
      issue: { id: "issue-1", identifier: "FF-442", title: "Branch enforcement", workMode: null },
      issueNumber: 442,
      issueDescription: null,
      persistedBranchName: "ff-425-de-455-braintree",
      projectPolicy: null,
      issueWorkspaceSettings: null,
      projectId: "project-1",
      repoRef: null,
    });
    expect(spec).toEqual({
      exact: "ff-425-de-455-braintree",
      prefix: null,
      label: "ff-425-de-455-braintree",
    });
  });

  it("matches prefix and exact branch specs", () => {
    expect(
      branchMatchesSpec("ff-442-enforce-issue-branch", {
        exact: null,
        prefix: "ff-442-",
        label: "ff-442-*",
      }),
    ).toBe(true);
    expect(
      branchMatchesSpec("ff-425-de-455-braintree", {
        exact: "ff-425-de-455-braintree",
        prefix: null,
        label: "ff-425-de-455-braintree",
      }),
    ).toBe(true);
    expect(
      branchMatchesSpec("ff-438-de-480-deferred-income-balance", {
        exact: null,
        prefix: "ff-425-",
        label: "ff-425-*",
      }),
    ).toBe(false);
  });
});
