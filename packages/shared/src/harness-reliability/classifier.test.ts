import { describe, expect, it } from "vitest";
import {
  classifyHarnessReliabilitySignal,
  harnessReliabilityVerdictToEvidenceRow,
  type HarnessReliabilitySignal,
} from "./classifier.js";
import {
  HARNESS_RELIABILITY_CATEGORIES,
  HARNESS_RELIABILITY_CATEGORY_CATALOG,
} from "./taxonomy.js";

describe("harness reliability taxonomy catalog", () => {
  it("covers every declared category with a descriptor", () => {
    for (const category of HARNESS_RELIABILITY_CATEGORIES) {
      const descriptor = HARNESS_RELIABILITY_CATEGORY_CATALOG[category];
      expect(descriptor.category).toBe(category);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.description.length).toBeGreaterThan(0);
      expect(descriptor.owner).toBeDefined();
      expect(descriptor.action).toBeDefined();
      expect(descriptor.severity).toBeDefined();
    }
  });

  it("never routes a category to owner=none with an action other than continue_in_progress", () => {
    for (const descriptor of Object.values(HARNESS_RELIABILITY_CATEGORY_CATALOG)) {
      if (descriptor.owner === "none") {
        expect(descriptor.action).toBe("continue_in_progress");
      }
    }
  });
});

describe("classifyHarnessReliabilitySignal — required v0 fixtures", () => {
  it("useful-output-but-failed-adapter classifies as useful_output_missing_disposition when no disposition recorded", () => {
    const signal: HarnessReliabilitySignal = {
      runLivenessState: "needs_followup",
      heartbeatRunStatus: "failed",
      hasUsefulOutput: true,
      dispositionRecorded: false,
      adapterLost: true,
    };
    const verdict = classifyHarnessReliabilitySignal(signal);
    expect(verdict.category).toBe("useful_output_missing_disposition");
    expect(verdict.owner).toBe("assignee_agent");
    expect(verdict.action).toBe("record_disposition");
    expect(verdict.reasonCodes).toContain("hasUsefulOutput");
    expect(verdict.reasonCodes).toContain("dispositionMissing");
  });

  it("adapter loss without useful output classifies as adapter_or_process_loss", () => {
    const verdict = classifyHarnessReliabilitySignal({
      heartbeatRunStatus: "timed_out",
      hasUsefulOutput: false,
      adapterLost: true,
    });
    expect(verdict.category).toBe("adapter_or_process_loss");
    expect(verdict.owner).toBe("platform");
    expect(verdict.action).toBe("retry_adapter");
  });

  it("duplicate recovery: recentRecoveryActionCount >= 2 classifies as duplicate_recovery", () => {
    const verdict = classifyHarnessReliabilitySignal({
      issueStatus: "blocked",
      recentRecoveryActionCount: 3,
    });
    expect(verdict.category).toBe("duplicate_recovery");
    expect(verdict.action).toBe("deduplicate_recovery");
    expect(verdict.reasonCodes).toContain("recentRecoveryActionCount");
  });

  it("duplicate recovery: self-wake loop classifies as duplicate_recovery", () => {
    const verdict = classifyHarnessReliabilitySignal({
      selfWakeLoop: true,
    });
    expect(verdict.category).toBe("duplicate_recovery");
    expect(verdict.reasonCodes).toContain("selfWakeLoop");
  });

  it("stale blocker: issue blocked but blocker resolved classifies as stale_blocker", () => {
    const verdict = classifyHarnessReliabilitySignal({
      issueStatus: "blocked",
      hasStaleBlocker: true,
    });
    expect(verdict.category).toBe("stale_blocker");
    expect(verdict.owner).toBe("orchestrator");
    expect(verdict.action).toBe("refresh_blocker_or_unblock");
  });

  it("missing validation evidence (no useful output, no disposition, run failed) classifies as product_failure", () => {
    const verdict = classifyHarnessReliabilitySignal({
      runLivenessState: "failed",
      heartbeatRunStatus: "succeeded",
      hasUsefulOutput: false,
      dispositionRecorded: false,
    });
    expect(verdict.category).toBe("product_failure");
    expect(verdict.owner).toBe("assignee_agent");
    expect(verdict.action).toBe("investigate_and_fix");
  });

  it("review-stage hang classifies as review_or_qa_failure with reviewer owner", () => {
    const verdict = classifyHarnessReliabilitySignal({
      issueStatus: "in_review",
      reviewOrQaStageHung: true,
    });
    expect(verdict.category).toBe("review_or_qa_failure");
    expect(verdict.owner).toBe("reviewer_agent");
    expect(verdict.action).toBe("rerun_review_or_qa");
    expect(verdict.reasonCodes).toContain("reviewOrQaStageHung");
  });

  it("review rejection classifies as review_or_qa_failure", () => {
    const verdict = classifyHarnessReliabilitySignal({
      issueStatus: "in_review",
      reviewOrQaRejected: true,
    });
    expect(verdict.category).toBe("review_or_qa_failure");
  });
});

describe("classifyHarnessReliabilitySignal — holds and healthy paths", () => {
  it("approval_hold supersedes other signals (intentional pause is not a failure)", () => {
    const verdict = classifyHarnessReliabilitySignal({
      issueStatus: "blocked",
      hasStaleBlocker: true,
      awaitingApproval: true,
    });
    expect(verdict.category).toBe("approval_hold");
    expect(verdict.owner).toBe("human_operator");
    expect(verdict.severity).toBe("info");
  });

  it("release_hold supersedes review-stage hang since work is intentionally held", () => {
    const verdict = classifyHarnessReliabilitySignal({
      issueStatus: "in_review",
      reviewOrQaStageHung: true,
      awaitingReleaseWindow: true,
    });
    expect(verdict.category).toBe("release_hold");
    expect(verdict.owner).toBe("release_manager");
    expect(verdict.action).toBe("await_release_window");
  });

  it("healthy in_progress run is classified as healthy_in_progress with owner=none", () => {
    const verdict = classifyHarnessReliabilitySignal({
      heartbeatRunStatus: "running",
      runLivenessState: "advanced",
      issueStatus: "in_progress",
    });
    expect(verdict.category).toBe("healthy_in_progress");
    expect(verdict.owner).toBe("none");
    expect(verdict.action).toBe("continue_in_progress");
  });

  it("empty signal returns unclassified, never silently healthy", () => {
    const verdict = classifyHarnessReliabilitySignal({});
    expect(verdict.category).toBe("unclassified");
    expect(verdict.action).toBe("triage_unclassified");
  });
});

describe("harnessReliabilityVerdictToEvidenceRow", () => {
  it("renders human labels for owner and action without exposing enum keys", () => {
    const verdict = classifyHarnessReliabilitySignal({
      hasUsefulOutput: true,
      dispositionRecorded: false,
    });
    const row = harnessReliabilityVerdictToEvidenceRow(verdict);
    expect(row.label).toBe("Useful output, missing disposition");
    expect(row.ownerLabel).toBe("Assignee agent");
    expect(row.actionLabel).toBe("Record final disposition");
    expect(row.reasonCodes.length).toBeGreaterThan(0);
  });
});

describe("classifier ordering invariants", () => {
  it("review/QA failure outranks duplicate_recovery noise on the same signal", () => {
    const verdict = classifyHarnessReliabilitySignal({
      reviewOrQaRejected: true,
      recentRecoveryActionCount: 5,
    });
    expect(verdict.category).toBe("review_or_qa_failure");
  });

  it("stale_blocker outranks duplicate_recovery so we fix the phantom dependency first", () => {
    const verdict = classifyHarnessReliabilitySignal({
      issueStatus: "blocked",
      hasStaleBlocker: true,
      recentRecoveryActionCount: 5,
    });
    expect(verdict.category).toBe("stale_blocker");
  });

  it("useful_output_missing_disposition outranks adapter_or_process_loss when both apply", () => {
    const verdict = classifyHarnessReliabilitySignal({
      hasUsefulOutput: true,
      dispositionRecorded: false,
      adapterLost: true,
    });
    expect(verdict.category).toBe("useful_output_missing_disposition");
  });
});
