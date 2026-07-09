// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  clearSingleLowTrustBoundaryTarget,
  getLowTrustBoundary,
  getSingleLowTrustBoundaryTarget,
  isCeLowTrustBoundaryEditable,
  setSingleLowTrustBoundaryTarget,
  summarizeLowTrustBoundaryTarget,
} from "./trust-policy-ui";

describe("trust-policy-ui low-trust boundary helpers", () => {
  it("writes one project boundary with mode and company id", () => {
    const permissions = setSingleLowTrustBoundaryTarget(null, "company-1", {
      type: "project",
      id: "project-1",
    });

    expect(permissions).toMatchObject({
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustPreset: "low_trust_review",
        reviewPreset: {
          id: "low_trust_review",
          version: 1,
          rawOutputDisposition: "quarantine",
        },
        trustBoundary: {
          mode: "low_trust_review",
          companyId: "company-1",
          projectIds: ["project-1"],
        },
      },
    });
  });

  it("clears other scope fields while preserving non-scope policy fields", () => {
    const permissions = setSingleLowTrustBoundaryTarget(
      {
        trustPreset: "low_trust_review",
        authorizationPolicy: {
          customEeField: { mode: "preserved" },
          trustBoundary: {
            mode: "low_trust_review",
            companyId: "company-1",
            projectIds: ["project-1"],
            rootIssueId: "root-1",
            issueIds: ["issue-1"],
            allowedToolClasses: ["git.read"],
          },
        },
      },
      "company-2",
      { type: "issue", id: "issue-2" },
    );

    expect(permissions.authorizationPolicy).toMatchObject({
      customEeField: { mode: "preserved" },
      trustBoundary: {
        mode: "low_trust_review",
        companyId: "company-2",
        issueIds: ["issue-2"],
        allowedToolClasses: ["git.read"],
      },
    });
    expect(permissions.authorizationPolicy?.trustBoundary?.projectIds).toBeUndefined();
    expect(permissions.authorizationPolicy?.trustBoundary?.rootIssueId).toBeUndefined();
  });

  it("hydrates one existing root issue boundary", () => {
    const boundary = getLowTrustBoundary({
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustBoundary: {
          mode: "low_trust_review",
          companyId: "company-1",
          rootIssueId: "issue-root",
        },
      },
    });

    expect(getSingleLowTrustBoundaryTarget(boundary)).toEqual({ type: "root_issue", id: "issue-root" });
    expect(summarizeLowTrustBoundaryTarget(boundary)).toBe("Root issue issue-ro");
  });

  it("marks multi-boundary policies read-only for CE", () => {
    const boundary = {
      mode: "low_trust_review" as const,
      companyId: "company-1",
      projectIds: ["project-1", "project-2"],
    };

    expect(isCeLowTrustBoundaryEditable(boundary)).toBe(false);
    expect(getSingleLowTrustBoundaryTarget(boundary)).toBeNull();
    expect(summarizeLowTrustBoundaryTarget(boundary)).toBe("2 boundaries");
  });

  it("clears the CE boundary without removing non-scope fields", () => {
    const permissions = clearSingleLowTrustBoundaryTarget({
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustBoundary: {
          mode: "low_trust_review",
          companyId: "company-1",
          issueIds: ["issue-1"],
          allowedSecretBindingIds: ["binding-1"],
        },
      },
    });

    expect(permissions.authorizationPolicy?.trustBoundary).toEqual({
      mode: "low_trust_review",
      companyId: "company-1",
      allowedSecretBindingIds: ["binding-1"],
    });
  });
});
