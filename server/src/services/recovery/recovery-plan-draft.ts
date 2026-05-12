export type RecoveryPlanDraftCause = "stranded_assigned_issue" | "successful_run_missing_state";

export function buildRecoveryPlanDraft(input: { cause: RecoveryPlanDraftCause }) {
  const lines = input.cause === "successful_run_missing_state"
    ? [
        "## Recovery Plan Draft",
        "",
        "- [ ] Triage: inspect the source issue, run metadata, and retry history without copying raw transcripts or secrets.",
        "- [ ] Repair: record exactly one valid disposition for the source issue: `done`/`cancelled`, `in_review` with an owner, `blocked` with first-class blockers, delegated follow-up work, or an explicit continuation path.",
        "- [ ] Validation: attach evidence that the chosen disposition satisfies acceptance criteria or names a first-class blocker.",
        "- [ ] Closeout: update the source issue, link any delegated follow-up or blocker work, then mark this recovery issue done.",
      ]
    : [
        "## Recovery Plan Draft",
        "",
        "- [ ] Triage: inspect the latest run, retry history, and source issue state without copying raw transcripts or secrets.",
        "- [ ] Repair: fix the runtime/adapter failure, reassign the source issue, or convert it into a clear manual-review or blocker state.",
        "- [ ] Validation: confirm the source issue has a live execution path, explicit waiting path, or intentional terminal disposition.",
        "- [ ] Closeout: comment what changed, link safe evidence, then mark this recovery issue done.",
      ];

  const safetyNotes = [
    "",
    "Safety notes:",
    "- Human approval is required before risky/live/destructive/social/spend/account/proxy actions.",
    "- Do not duplicate spend or live actions while repairing the source issue.",
    "- Do not mark the source issue done without validation / acceptance criteria evidence.",
  ];

  return [...lines, ...safetyNotes].join("\n");
}
