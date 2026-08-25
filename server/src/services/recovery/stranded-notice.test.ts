import { describe, expect, it } from "vitest";
import { noticeMetadataReferencesRecoveryAction } from "./successful-run-handoff.js";
import {
  DEFAULT_STRANDED_RECOVERY_NOTICE_BODY,
  buildConfigurationIncompleteRecoveryNoticeSeed,
  buildExecutionReviewParticipantRecoveryNoticeSeed,
  buildExecutionReviewParticipantUnavailableNoticeSeed,
  buildImmediateExecutionPathRecoveryNoticeSeed,
  buildStrandedRecoveryEscalationNotice,
  buildWorkspaceValidationRecoveryNoticeSeed,
} from "./stranded-notice.js";

function allRows(metadata: { sections: Array<{ rows: unknown[] }> }) {
  return metadata.sections.flatMap((section) => section.rows) as Array<Record<string, unknown>>;
}

describe("stranded recovery notice seeds", () => {
  it.each([
    ["todo dispatch", buildImmediateExecutionPathRecoveryNoticeSeed({ status: "todo" }), "No live execution path"],
    ["in_progress continuation", buildImmediateExecutionPathRecoveryNoticeSeed({ status: "in_progress" }), "No live execution path"],
    ["workspace validation", buildWorkspaceValidationRecoveryNoticeSeed(), "Workspace validation failed"],
    ["configuration incomplete", buildConfigurationIncompleteRecoveryNoticeSeed(), "Configuration incomplete"],
    ["review participant recovery", buildExecutionReviewParticipantRecoveryNoticeSeed(), "Review recovery stalled"],
    ["review participant unavailable", buildExecutionReviewParticipantUnavailableNoticeSeed(), "Review recovery stalled"],
  ])("%s seed has a short body plus title and tone", (_label, seed, expectedTitle) => {
    expect(seed.title).toBe(expectedTitle);
    expect(seed.tone).toBe("danger");
    expect(seed.body.length).toBeGreaterThan(0);
    // Failure details now live in metadata rows, never inline in the body.
    expect(seed.body).not.toContain("Latest retry failure");
    expect(seed.body).not.toContain("Recovery action:");
  });

  it("distinguishes todo dispatch from in_progress continuation copy", () => {
    expect(buildImmediateExecutionPathRecoveryNoticeSeed({ status: "todo" }).body).toContain("retried dispatch");
    expect(buildImmediateExecutionPathRecoveryNoticeSeed({ status: "in_progress" }).body).toContain(
      "retried continuation",
    );
  });
});

describe("buildStrandedRecoveryEscalationNotice", () => {
  const actionId = "6a2f8e64-6f5e-4b58-b7fd-111111111111";
  const owner = { id: "9b1c2d3e-4f50-4a61-8b72-222222222222", name: "CTO" };
  const sourceRun = {
    id: "0c1d2e3f-4a5b-4c6d-8e7f-333333333333",
    agentId: "4d5e6f70-8a9b-4c1d-8e2f-444444444444",
    status: "failed",
    errorCode: "workspace_validation_failed",
    errorSummary: "Expected project worktree but resolved the agent fallback directory.",
  };

  it("emits system_notice presentation and the required metadata rows", () => {
    const seed = buildWorkspaceValidationRecoveryNoticeSeed();
    const notice = buildStrandedRecoveryEscalationNotice({
      seed,
      recoveryActionId: actionId,
      recoveryOwner: owner,
      sourceRun,
    });

    expect(notice.body).toBe(seed.body);
    expect(notice.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      title: "Workspace validation failed",
    });
    expect(notice.metadata.version).toBe(1);
    expect(notice.metadata.sourceRunId).toBe(sourceRun.id);

    const rows = allRows(notice.metadata);
    expect(rows).toContainEqual({ type: "key_value", label: "Recovery action", value: actionId });
    expect(rows).toContainEqual({ type: "agent_link", label: "Recovery owner", agentId: owner.id, name: owner.name });
    expect(rows).toContainEqual({
      type: "run_link",
      label: "Source run",
      runId: sourceRun.id,
      agentId: sourceRun.agentId,
      title: "failed",
    });
    expect(rows).toContainEqual({
      type: "key_value",
      label: "Failure code",
      value: "workspace_validation_failed",
    });
    expect(rows).toContainEqual({
      type: "key_value",
      label: "Failure summary",
      value: sourceRun.errorSummary,
    });
    expect(rows.some((row) => row.label === "Next action")).toBe(true);
  });

  it("records board escalation when there is no invokable recovery owner", () => {
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: buildConfigurationIncompleteRecoveryNoticeSeed(),
      recoveryActionId: actionId,
      recoveryOwner: null,
      sourceRun,
    });

    const ownerRow = allRows(notice.metadata).find((row) => row.label === "Recovery owner");
    expect(ownerRow?.type).toBe("key_value");
    expect(ownerRow?.value).toBe("Board decision required");
  });

  it("derives title from the recovery cause and body from the plain-comment fallback", () => {
    const notice = buildStrandedRecoveryEscalationNotice({
      fallbackBody: "Legacy plain comment body.",
      recoveryCause: "configuration_incomplete",
      recoveryActionId: actionId,
      recoveryOwner: owner,
      sourceRun: null,
    });

    expect(notice.body).toBe("Legacy plain comment body.");
    expect(notice.presentation.title).toBe("Configuration incomplete");
    expect(notice.metadata.sourceRunId).toBeNull();
    expect(notice.metadata.sections).toHaveLength(1);
  });

  it("falls back to the default body and title when no seed or comment is given", () => {
    const notice = buildStrandedRecoveryEscalationNotice({
      recoveryActionId: actionId,
      recoveryOwner: null,
      sourceRun: null,
    });

    expect(notice.body).toBe(DEFAULT_STRANDED_RECOVERY_NOTICE_BODY);
    expect(notice.presentation.title).toBe("Automatic recovery blocked");
  });

  it("omits the failure code row when the source run has no error code", () => {
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: buildImmediateExecutionPathRecoveryNoticeSeed({ status: "in_progress" }),
      recoveryActionId: actionId,
      recoveryOwner: owner,
      sourceRun: {
        id: sourceRun.id,
        agentId: sourceRun.agentId,
        status: "cancelled",
        errorCode: null,
        errorSummary: null,
      },
    });

    const rows = allRows(notice.metadata);
    expect(rows).toContainEqual({
      type: "run_link",
      label: "Source run",
      runId: sourceRun.id,
      agentId: sourceRun.agentId,
      title: "cancelled",
    });
    expect(rows.some((row) => row.label === "Failure code")).toBe(false);
    expect(rows.some((row) => row.label === "Failure summary")).toBe(false);
  });

  it("is matched by the metadata-based escalation dedupe matcher", () => {
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: buildImmediateExecutionPathRecoveryNoticeSeed({ status: "todo" }),
      recoveryActionId: actionId,
      recoveryOwner: owner,
      sourceRun,
    });

    // The escalation dedupe in recovery/service.ts no longer relies on the
    // `Recovery action: \`id\`` body marker for new comments; the metadata
    // matcher must recognize every notice this builder produces.
    expect(notice.body).not.toContain(actionId);
    expect(noticeMetadataReferencesRecoveryAction(notice.metadata, actionId)).toBe(true);
    expect(
      noticeMetadataReferencesRecoveryAction(notice.metadata, "1f2e3d4c-5b6a-4798-8899-444444444444"),
    ).toBe(false);
  });
});
