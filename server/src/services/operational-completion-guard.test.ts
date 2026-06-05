import { describe, expect, it } from "vitest";
import { assessOperationalCompletionEvidenceGate } from "./operational-completion-guard.js";

describe("assessOperationalCompletionEvidenceGate", () => {
  it("rejects merge-only done evidence for operational issues with missing runtime artifacts", () => {
    const assessment = assessOperationalCompletionEvidenceGate({
      issue: {
        title: "Pentest Swarm — execute supervised Phase-3 dry-run + Phase-4 prod passive/recon run (deploy host, operational)",
        description: [
          "Operational execution issue.",
          "This is intentionally NOT linked to any code PR.",
          "Close only when the Phase-3 dry-run truly happens and green report/SARIF evidence is attached.",
        ].join("\n"),
      },
      recentComments: [
        {
          body: "Post-merge reconciliation: linked GitHub PR #898 is merged. Marking issue done.",
        },
        {
          body: [
            "CEO correction: reopening again after repeated PR-reconciliation false close.",
            "Disposition: blocked, not done.",
            "No green report/SARIF artifact was produced.",
            "No Phase-4 production passive/recon run was started.",
          ].join("\n"),
        },
      ],
      completionCommentBody: null,
    });

    expect(assessment).toEqual({
      allowed: false,
      reason:
        "Operational/manual-run issue still has missing runtime evidence; merge-only PR evidence cannot mark it done.",
    });
  });

  it("allows operational issues when the completion evidence includes runtime artifacts", () => {
    const assessment = assessOperationalCompletionEvidenceGate({
      issue: {
        title: "Pentest Swarm operational run",
        description: "Operational execution issue. Requires runtime report/SARIF evidence before done.",
      },
      recentComments: [
        {
          body: "Earlier status: blocked, not done. No report/SARIF artifact was produced.",
        },
      ],
      completionCommentBody:
        "Phase-3 dry-run completed successfully. Green report and SARIF artifact attached; Phase-4 passive/recon run completed.",
    });

    expect(assessment).toEqual({ allowed: true });
  });

  it("allows normal implementation issues to close from PR merge evidence", () => {
    const assessment = assessOperationalCompletionEvidenceGate({
      issue: {
        title: "Fix OAuth proxy request header",
        description: "Implement the proxy code path and merge the PR after QA passes.",
      },
      recentComments: [
        {
          body: "Post-merge reconciliation: linked GitHub PR #898 is merged. Marking issue done.",
        },
      ],
      completionCommentBody: null,
    });

    expect(assessment).toEqual({ allowed: true });
  });
});
