/** Closed, target-independent success requirements used by dispatch and retained evidence. */
export const agentJourneyRuns = {
  "repository-continuation": 2,
  "routine-scheduled-run": 1,
  "file-input-answer": 1,
  "ask-question": 1,
  "chat-continuity": 4,
  "plan-revise-accept": 3,
  "build-revise": 2,
  "followup-while-running": 2,
  "protected-actions": 4,
  "create-skill-studio": 1,
  "stop-redirect": 3,
  "agent-settings-persistence": 1,
  "question-answer-resume": 3,
  "hire-delegate-reuse": 7
} as const;

export function agentJourneyRunCountValid(id: string, count: unknown): boolean {
  if (!Object.hasOwn(agentJourneyRuns, id) || !Number.isSafeInteger(count)) return false;
  const maximum = agentJourneyRuns[id as keyof typeof agentJourneyRuns];
  const minimum = id === "question-answer-resume" || id === "followup-while-running" ? 1 : maximum;
  return (count as number) >= minimum && (count as number) <= maximum;
}
export const journeyRequiredChecks: Record<string, readonly string[]> = {
  "task-edit-lifecycle": ["task-lifecycle-browser-created", "task-lifecycle-visible-edits-persisted", "task-lifecycle-edits-reloaded", "task-lifecycle-completed-and-reopened", "task-lifecycle-unedited-context-preserved", "no-agent-work"],
  "company-access-isolation": ["isolation-owner-resource-controls", "cloud-workspace-switch-and-return", "workspace-data-scoped", "restricted-agent-positive-controls", "cross-workspace-agent-read-write-denied", "isolation-credential-revoked", "no-agent-work"],
  "repository-continuation": ["repository-configured-source-bound", "repository-first-commit-verified", "repository-original-files-saved", "repository-followup-stored-once", "repository-same-workspace-retained", "repository-second-commit-verified", "repository-original-and-result-reopened", "configured-model-and-environment"],
  "routine-scheduled-run": ["routine-browser-created", "routine-scheduler-created-execution", "routine-result-attributed", "routine-history-preserved", "routine-pause-prevented-next-run", "routine-result-reopened", "configured-model-and-environment"],
  "inbox-triage": ["inbox-external-human-activity", "inbox-read-persisted", "inbox-archive-persisted", "inbox-archive-preserved-task-status", "inbox-relevant-activity-resurfaced", "no-agent-work"],
  "file-input-answer": ["input-upload-bytes-preserved", "input-content-used-correctly", "input-result-attributed-to-run", "input-result-reopened", "original-input-retained", "configured-model-and-environment"],
  "task-properties": ["assignment-persisted", "no-agent-work"],
  "task-create": ["browser-created-task-persisted", "no-agent-work"],
  "task-document-persistence": ["browser-document-created", "document-revision-history-preserved", "document-reopened-after-reload", "no-agent-work"],
  "project-task-context": ["browser-created-project-persisted", "browser-created-project-task-persisted", "project-task-association-reloaded", "project-task-context-visible", "no-agent-work"],
  "task-search-filter": ["task-search-results-exact", "task-status-filter-excludes-controls", "task-search-filter-reloaded", "task-search-result-reopened", "no-agent-work"],
  "ask-question": ["question-answer-persisted", "one-bound-successful-run", "configured-model-and-environment"],
  "chat-continuity": ["chat-fresh-owned-conversation", "chat-user-messages-stored-once", "chat-reload-preserved-context", "chat-new-session-boundary", "chat-fresh-context-answer", "chat-history-preserved-after-reload", "chat-no-unrequested-work", "chat-exact-turn-accounting", "configured-model-and-environment"],
  "question-answer-resume": ["question-resume.forms", "question-resume.choice.answer", "question-resume.choice.path",
    "question-resume.text.answer", "question-resume.text.path", "question-resume.complete-evidence", "question-no-premature-output",
    "question-answers-owned-by-board", "question-document-attributed", "question-document-reloaded", "configured-model-and-environment"],
  "plan-revise-accept": ["plan-revision-and-approval", "plan-final-answer", "configured-model-and-environment"],
  "build-revise": ["initial-artifact-verified", "revised-artifact-verified", "artifact-versions-differ", "original-artifact-preserved", "user-reply-stored-once", "configured-model-and-environment"],
  "protected-actions": ["approve-waited-for-decision", "approve-decision-persisted", "approve-service-call-count", "approved-service-data-used",
    "decline-waited-for-decision", "decline-decision-persisted", "decline-service-call-count", "decline-truthful-explanation", "configured-model-and-environment"],
  "create-skill-studio": ["created-skill-persisted", "skill-creation-attributed", "skill-studio-edit-persisted", "configured-model-and-environment"],
  "stop-redirect": ["checkpoint-artifact-verified", "active-work-stopped", "stop-native-terminal-retained", "new-direction-completed", "stopped-run-remained-terminal",
    "stopped-run-no-later-events", "stop-preserved-download", "redirect-consumed-once", "user-reply-stored-once", "configured-model-and-environment"],
  "followup-while-running": ["followup-native-command-active", "followup-stored-once", "followup-consumed-once", "followup-final-answer-persisted", "followup-one-or-two-native-runs", "configured-model-and-environment"],
  "hire-delegate-reuse": ["one-attributed-native-hire", "first-delegated-task-complete", "checklist-authored-by-hired-run", "same-teammate-reused", "review-authored-by-same-hired-run", "original-checklist-preserved", "hire-user-messages-stored-once", "delegated-result-visible-after-reload", "configured-model-and-environment"],
  "agent-settings-persistence": ["agent-settings-browser-save", "agent-settings-reload-persisted", "agent-settings-instruction-only-input", "agent-settings-result-attributed", "agent-settings-result-reopened", "agent-settings-original-restored", "configured-model-and-environment"],
  "cloud-onboarding": ["fresh-workspace", "ui-connection-and-native-agent", "first-task-complete", "downloadable-artifact-verified", "native-trace-verified"],
};
