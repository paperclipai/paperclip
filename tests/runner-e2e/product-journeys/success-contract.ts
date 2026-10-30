/** Closed, target-independent success requirements used by dispatch and retained evidence. */
export const agentJourneyRuns = { "ask-question": 1, "plan-revise-accept": 3, "build-revise": 2,
  "protected-actions": 4, "create-skill-studio": 1, "stop-redirect": 3 } as const;
export const journeyRequiredChecks: Record<string, readonly string[]> = {
  "task-properties": ["assignment-persisted", "no-agent-work"],
  "task-create": ["browser-created-task-persisted", "no-agent-work"],
  "ask-question": ["question-answer-persisted", "one-bound-successful-run", "configured-model-and-environment"],
  "plan-revise-accept": ["plan-revision-and-approval", "plan-final-answer", "configured-model-and-environment"],
  "build-revise": ["initial-artifact-verified", "revised-artifact-verified", "artifact-versions-differ", "original-artifact-preserved", "user-reply-stored-once", "configured-model-and-environment"],
  "protected-actions": ["approve-waited-for-decision", "approve-decision-persisted", "approve-service-call-count", "approved-service-data-used",
    "decline-waited-for-decision", "decline-decision-persisted", "decline-service-call-count", "decline-truthful-explanation", "configured-model-and-environment"],
  "create-skill-studio": ["created-skill-persisted", "skill-creation-attributed", "skill-studio-edit-persisted", "configured-model-and-environment"],
  "stop-redirect": ["checkpoint-artifact-verified", "active-work-stopped", "stop-native-terminal-retained", "new-direction-completed", "stopped-run-remained-terminal",
    "stopped-run-no-later-events", "stop-preserved-download", "redirect-consumed-once", "user-reply-stored-once", "configured-model-and-environment"],
  "cloud-onboarding": ["fresh-workspace", "ui-connection-and-native-agent", "first-task-complete", "downloadable-artifact-verified", "native-trace-verified"],
};
