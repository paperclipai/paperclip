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

describe("inferDefaultCloseContractForIssueCreate — artifact deliverables (TSMC-21711)", () => {
  it("arms the real DP-4627 brief, which previously armed nothing", () => {
    expect(
      inferDefaultCloseContractForIssueCreate({
        title: "Produce compliant Pinterest demo video for OAuth flow and integration (Resubmit)",
        description:
          "Previous attempt (DP-4486) was cancelled. To unblock the Pinterest revenue channel, the CTO must produce a compliant demo video showing the FULL OAuth flow and live Pinterest integration.",
        cardTemplate: null,
        closeContract: null,
        identifier: "DP-4627",
      }),
    ).toMatchObject({
      mode: "evidence",
      evidenceTarget: 1,
      portableEvidenceTarget: 1,
      evidencePath: "DP-4627",
      artifactKind: "screen_recording_video",
    });
  });

  it("matches the unambiguous deliverable nouns on their own", () => {
    for (const text of [
      "Ship a screen recording of the connect flow.",
      "Deliverable: a screencast of the migration.",
      "Rebuild the one-pager (evidence-backed, attachment-or-fail).",
    ]) {
      expect(infer(text)).toMatchObject({ mode: "evidence", portableEvidenceTarget: 1 });
    }
  });

  it("names a concrete artifact class per deliverable kind", () => {
    expect(infer("Export the pack as a PDF and hand it over.")).toMatchObject({
      artifactKind: "rendered_pdf",
    });
    expect(infer("Produce a deck for the Monday review.")).toMatchObject({
      artifactKind: "rendered_deck",
    });
    expect(infer("Attach a screenshot of the failing state.")).toMatchObject({
      artifactKind: "captured_screenshot",
    });
  });

  it("requires a determiner on the verb forms so discussion prose does not arm a gate", () => {
    expect(infer("Generate video ideas for next quarter's hitlist.")).toBeNull();
    expect(infer("The demo recording process is documented in the runbook.")).toBeNull();
    expect(infer("Watch how competitors deck out their listings.")).toBeNull();
  });

  it("never overrides a contract the author already set", () => {
    expect(
      inferDefaultCloseContractForIssueCreate({
        title: "Produce a demo video",
        description: null,
        cardTemplate: null,
        closeContract: { mode: "exempt", exemptReason: "no_artifact_expected" },
        identifier: "DP-1",
      }),
    ).toBeNull();
  });
});

describe("inferDefaultCloseContractForIssueCreate — portable floor on inferred contracts", () => {
  it("gives generation/measurement cards a board-visible floor (TSMC-21711)", () => {
    expect(
      inferDefaultCloseContractForIssueCreate({
        title: "[burn] asset-generation tail for the Q4 pool",
        description: null,
        cardTemplate: null,
        closeContract: null,
        identifier: "TSM-1",
      }),
    ).toMatchObject({
      artifactKind: "generated_media",
      evidenceTarget: 1,
      portableEvidenceTarget: 1,
    });
  });
});
