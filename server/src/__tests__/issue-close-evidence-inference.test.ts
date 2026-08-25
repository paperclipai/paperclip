import { describe, expect, it } from "vitest";
import { inferDefaultCloseContractForIssueCreate } from "../services/issue-close-evidence.ts";

function infer(description: string, title = "Research candidates") {
  return inferDefaultCloseContractForIssueCreate({
    title,
    description,
    cardTemplate: null,
    closeContract: null,
    identifier: "TSC-9999",
  });
}

describe("inferDefaultCloseContractForIssueCreate — explicit evidence demands", () => {
  it("keeps the original 'acceptance evidence' trigger", () => {
    expect(infer("Close requires acceptance evidence under the governed path.")).toMatchObject({
      mode: "evidence",
      artifactKind: "acceptance_evidence",
    });
  });

  it("treats 'attach evidence' as an executable close contract (TSC-7617)", () => {
    expect(infer("Token cap: 60k. Attach evidence and close with a verdict.")).toMatchObject({
      mode: "evidence",
      artifactKind: "acceptance_evidence",
      evidenceTarget: 1,
      portableEvidenceTarget: 1,
    });
  });

  it("matches qualified forms and 'close with evidence'", () => {
    expect(infer("Please attach supporting evidence for each kill.")).toMatchObject({
      mode: "evidence",
      artifactKind: "acceptance_evidence",
    });
    expect(infer("Deliver proposals and close with evidence.")).toMatchObject({
      mode: "evidence",
      artifactKind: "acceptance_evidence",
    });
  });

  it("does not fire on incidental uses of the word evidence", () => {
    expect(infer("The evidence suggests spot venues are crowded; summarize findings.")).toBeNull();
    expect(infer("Review evidence handling in the pipeline docs.")).toBeNull();
  });
});
