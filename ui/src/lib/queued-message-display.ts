import { t } from "@/i18n";

// Only project the server-owned queue status text. Reasons are not sufficient:
// controller_settling can mean automatic recovery or required manual cleanup.
// The stored queue and arbitrary provider messages retain their original text.
const WAIT_MESSAGE_KEYS = new Map<string, string>([
  ["A pending approval or question must be resolved before this message can start.", "decisionPending"],
  ["The stopped run could not be identified. Your message is saved.", "sourceMissing"],
  ["The previous execution has not finished or its owner changed. Your message is saved.", "sourceUnavailable"],
  ["This message arrived before the previous run stopped. Send a new message to continue.", "messagePredatesStop"],
  ["Waiting for the previous run to stop. Your message will start automatically.", "executionSettling"],
  ["The cancelled run still needs verified cleanup. Your message is saved. Inspect the run and its environment for details.", "cancelledCleanup"],
  ["Waiting for the previous run to finish recovery. Your message will start automatically.", "controllerRecovery"],
  ["Waiting for the previous environment to stop. Your message will start automatically.", "remoteCleanup"],
  ["Waiting for the previous environment to finish cleanup. Your message will start automatically.", "localCleanup"],
  ["The previous run has no verified stop record. Paperclip cannot start this message yet.", "processIdentityMissing"],
  ["Waiting for the previous process to stop. Your message will start automatically.", "processRunning"],
  ["Waiting for the current run. Your message is saved.", "executionActive"],
  ["Waiting for execution recovery. Your message is saved.", "executionRecovery"],
  ["This task is paused. Resume it to send your saved message.", "taskPaused"],
  ["Waiting for task execution to be enabled. Your message is saved.", "executionDisabled"],
  ["The agent has reached its daily limit. Your message is saved until work can resume.", "dailyLimit"],
  ["Agent no longer exists", "agentMissing"],
  ["Agent is not invokable in its current state", "agentUnavailable"],
  ["Agent is not invokable because its reporting chain is invalid", "agentInvalidReportingChain"],
  ["Company is paused because its budget hard-stop was reached.", "companyBudgetPaused"],
  ["Company is paused and cannot start new work.", "companyPaused"],
  ["Company cannot start new work because its budget hard-stop is exceeded.", "companyBudgetExceeded"],
  ["Agent is paused because its budget hard-stop was reached.", "agentBudgetPaused"],
  ["Agent cannot start because its budget hard-stop is still exceeded.", "agentBudgetExceeded"],
  ["Project cannot start work because its budget hard-stop is still exceeded.", "projectBudgetExceeded"],
  ["Project is paused because its budget hard-stop was reached.", "projectBudgetPaused"],
]);

/** Display-only projection for IssueQueuedCommentQueue.executionWait.message. */
export function queuedMessageWaitMessage(message: string): string {
  const key = WAIT_MESSAGE_KEYS.get(message);
  return key ? t(`sep13QueueMetadata.${key}`) : message;
}
