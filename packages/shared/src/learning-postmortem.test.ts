import { describe, expect, it } from "vitest";
import {
  buildLearningPostmortem,
  decideLearningPromotion,
  redactLearningEvidence,
} from "./learning-postmortem.js";

describe("learning/postmortem loop", () => {
  it("redacts sensitive evidence and produces reviewable learning candidates", () => {
    const redactionFixture = [
      ["Bearer", ["live", "token", "123"].join("-")].join(" "),
      `token=${["synthetic", "secret"].join("-")}`,
      ["DATABASE_URL=", "postgres", "://", "user", ":", "pass", "@example.local/db"].join(""),
      ["bot", "123456", ":", "telegram", "-", "secret"].join(""),
    ].join(" ");
    const redacted = redactLearningEvidence(redactionFixture);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("live-token-123");
    expect(redacted).not.toContain("synthetic-secret");
    expect(redacted).not.toContain("telegram-secret");

    const postmortem = buildLearningPostmortem({
      issue: {
        id: "issue-1",
        identifier: "LET-131",
        title: "Learning loop",
        status: "failed",
      },
      run: {
        id: "run-1",
        status: "failed",
        startedAt: "2026-05-13T20:00:00.000Z",
        completedAt: "2026-05-13T20:06:00.000Z",
      },
      validatorVerdicts: ["REQUEST_CHANGES"],
      commandEvidence: ["pnpm test failed because token=synthetic-secret was in the fixture"],
      finalDelivery: {
        outcome: "failed",
        error: "Telegram bot123456:telegram-secret timed out",
        attemptCount: 2,
      },
      recoveryNotes: ["Add a redaction regression before retrying final delivery."],
    });

    expect(postmortem.version).toBe(1);
    expect(postmortem.issue.identifier).toBe("LET-131");
    expect(postmortem.outcome).toBe("failed");
    expect(JSON.stringify(postmortem)).toContain("[REDACTED]");
    expect(JSON.stringify(postmortem)).not.toContain("synthetic-secret");
    expect(postmortem.candidates.length).toBeGreaterThan(0);
    expect(postmortem.candidates[0]?.status).toBe("pending_review");
    expect(postmortem.candidates[0]?.target).toBe("validator");
  });

  it("requires explicit approval before a learning mutates prompts or skills", () => {
    const postmortem = buildLearningPostmortem({
      issue: { id: "issue-2", identifier: "LET-131", title: "Prompt fix", status: "done" },
      validatorVerdicts: ["PASS"],
      commandEvidence: ["Claude review PASS; add this checklist to the code-review skill."],
    });

    const decision = decideLearningPromotion(postmortem.candidates[0]!, {
      action: "promote",
      reviewerId: "board-user",
      note: "Promote as skill candidate, not direct mutation.",
    });

    expect(decision.status).toBe("approved_for_manual_apply");
    expect(decision.requiresApproval).toBe(true);
    expect(decision.appliesAutomatically).toBe(false);
    expect(decision.auditSummary).toContain("manual apply");
  });
});
