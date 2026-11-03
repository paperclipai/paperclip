import { describe, expect, it } from "vitest";
import {
  STALE_RUN_EVALUATION_AUTO_CLOSE_MARKER,
  decideStaleRunEvaluationCloseout,
  requestsArtifactRecovery,
} from "../services/recovery/stale-run-evaluation-closeout.ts";

describe("stale-run evaluation close-out rule", () => {
  it("closes a card whose origin run reached a terminal status", () => {
    const decision = decideStaleRunEvaluationCloseout({
      cardStatus: "todo",
      runStatus: "timed_out",
      cardHasLiveExecution: false,
    });

    expect(decision.close).toBe(true);
    expect(decision.reason).toBe("terminal_origin_run");
    expect(decision.detail).toContain("timed_out");
  });

  it.each(["succeeded", "interrupted", "failed", "cancelled", "timed_out"])(
    "treats %s as terminal",
    (status) => {
      expect(
        decideStaleRunEvaluationCloseout({
          cardStatus: "todo",
          runStatus: status,
          cardHasLiveExecution: false,
        }).close,
      ).toBe(true);
    },
  );

  it("leaves a card alone while its origin run is still active", () => {
    const decision = decideStaleRunEvaluationCloseout({
      cardStatus: "todo",
      runStatus: "running",
      cardHasLiveExecution: false,
    });

    expect(decision.close).toBe(false);
    expect(decision.reason).toBe("origin_run_still_active");
  });

  it("leaves a card alone while an agent is actively working it", () => {
    const decision = decideStaleRunEvaluationCloseout({
      cardStatus: "in_progress",
      runStatus: "failed",
      cardHasLiveExecution: true,
    });

    expect(decision.close).toBe(false);
    expect(decision.reason).toBe("card_actively_worked");
  });

  it("leaves a card alone when the origin run row is gone", () => {
    const decision = decideStaleRunEvaluationCloseout({
      cardStatus: "todo",
      runStatus: null,
      cardHasLiveExecution: false,
    });

    expect(decision.close).toBe(false);
    expect(decision.reason).toBe("origin_run_missing");
  });

  it("leaves a card alone when it asks for artifact recovery", () => {
    const decision = decideStaleRunEvaluationCloseout({
      cardStatus: "todo",
      runStatus: "failed",
      cardHasLiveExecution: false,
      texts: ["Please recover the output from the run log before closing this."],
    });

    expect(decision.close).toBe(false);
    expect(decision.reason).toBe("recovery_requested");
  });

  it("does not re-scan its own auto-close comment as a recovery request", () => {
    const decision = decideStaleRunEvaluationCloseout({
      cardStatus: "todo",
      runStatus: "failed",
      cardHasLiveExecution: false,
      texts: [
        `<!-- ${STALE_RUN_EVALUATION_AUTO_CLOSE_MARKER} -->\nAuto-closed: nothing left to recover from this run.`,
      ],
    });

    expect(decision.close).toBe(true);
  });
});

describe("artifact-recovery request detection", () => {
  it("detects a request to recover an artifact", () => {
    expect(requestsArtifactRecovery("Please recover the run log for this card.")).toBe(true);
    expect(requestsArtifactRecovery("We need to replay the transcript.")).toBe(true);
    expect(requestsArtifactRecovery("Someone should resume the session.")).toBe(true);
  });

  it("does not treat a statement that nothing is missing as a request", () => {
    expect(requestsArtifactRecovery("Nothing to recover; the run produced a full result.")).toBe(false);
    expect(requestsArtifactRecovery("No artifacts were lost.")).toBe(false);
    expect(requestsArtifactRecovery("There is no output to recover from this run.")).toBe(false);
    expect(requestsArtifactRecovery("No replay needed.")).toBe(false);
  });

  it("does not treat an unrelated mention of recovery as a request", () => {
    expect(requestsArtifactRecovery("The run failed and the agent will recover on the next wake.")).toBe(false);
  });

  it("keeps a request alive when another sentence says nothing is missing", () => {
    expect(
      requestsArtifactRecovery(
        "No output was lost in the first attempt. However, please recover the ndjson log from the second run.",
      ),
    ).toBe(true);
  });

  it("ignores empty and nullish text", () => {
    expect(requestsArtifactRecovery(null)).toBe(false);
    expect(requestsArtifactRecovery(undefined)).toBe(false);
    expect(requestsArtifactRecovery("")).toBe(false);
  });
});
