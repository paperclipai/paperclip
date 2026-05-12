import { describe, expect, it } from "vitest";
import { buildRecoveryPlanDraft } from "./recovery-plan-draft.js";

describe("recovery plan draft skeleton", () => {
  it("builds a safe missing-disposition repair draft", () => {
    const draft = buildRecoveryPlanDraft({ cause: "successful_run_missing_state" });

    expect(draft).toContain("## Recovery Plan Draft");
    expect(draft).toContain("- [ ] Triage: inspect the source issue, run metadata, and retry history without copying raw transcripts or secrets.");
    expect(draft).toContain("- [ ] Repair: record exactly one valid disposition for the source issue");
    expect(draft).toContain("- [ ] Validation: attach evidence that the chosen disposition satisfies acceptance criteria or names a first-class blocker.");
    expect(draft).toContain("- [ ] Closeout: update the source issue, link any delegated follow-up or blocker work, then mark this recovery issue done.");
    expect(draft).toContain("Safety notes:");
    expect(draft).toContain("Human approval is required before risky/live/destructive/social/spend/account/proxy actions.");
    expect(draft).toContain("Do not mark the source issue done without validation / acceptance criteria evidence.");
    expect(draft).not.toContain("sk-test-recovery-plan-secret");
    expect(draft).not.toMatch(/Authorization:\s*Bearer\s+\S+/i);
  });

  it("builds a runtime stranded-work repair draft", () => {
    const draft = buildRecoveryPlanDraft({ cause: "stranded_assigned_issue" });

    expect(draft).toContain("## Recovery Plan Draft");
    expect(draft).toContain("- [ ] Triage: inspect the latest run, retry history, and source issue state without copying raw transcripts or secrets.");
    expect(draft).toContain("- [ ] Repair: fix the runtime/adapter failure, reassign the source issue, or convert it into a clear manual-review or blocker state.");
    expect(draft).toContain("- [ ] Validation: confirm the source issue has a live execution path, explicit waiting path, or intentional terminal disposition.");
    expect(draft).toContain("- [ ] Closeout: comment what changed, link safe evidence, then mark this recovery issue done.");
    expect(draft).toContain("Human approval is required before risky/live/destructive/social/spend/account/proxy actions.");
    expect(draft).toContain("Do not duplicate spend or live actions while repairing the source issue.");
  });
});
