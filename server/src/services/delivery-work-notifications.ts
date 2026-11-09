import { signalDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db";

/** Topics for existing durable queues; register intent before their writes. */
export const DELIVERY_QUEUES = {
  executionFinalization: "execution-finalization",
  executionReplacement: "execution-replacement",
  executionContinuation: "execution-continuation",
  executionStatus: "execution-status",
  executionDisposition: "execution-disposition",
  adapterLoginCleanup: "adapter-login-cleanup",
  setupTokenCleanup: "setup-token-cleanup",
  localLoginCleanup: "local-login-cleanup",
  budgetEnforcement: "budget-enforcement",
  accounting: "cost-accounting",
  agentLifecycle: "agent-lifecycle",
  chatBoardMessages: "chat-board-messages",
  chatTaskStarts: "chat-task-starts",
  chatReceiptReactions: "chat-receipt-reactions",
  chatSessionStops: "chat-session-stops",
  chatProviderEffects: "chat-provider-effects",
  chatGitHubIngress: "chat-github-ingress",
  chatGitHubPublications: "chat-github-publications",
  chatFailedRunRetries: "chat-failed-run-retries",
  chatTelegramMaintenance: "chat-telegram-maintenance",
  chatTelegramSubscriptions: "chat-telegram-subscriptions",
  chatSessionSyncs: "chat-session-syncs",
  chatVerification: "chat-verification",
  chatInbound: "chat-inbound",
  chatPublications: "chat-publications",
  chatReceipts: "chat-slack-receipts",
  browser: "browser-use",
  email: "email-channels",
  museMaintenance: "muse-maintenance",
  mcpEvents: "mcp-events",
  dotEvents: "dot-events",
  skillSourceSync: "skill-source-sync",
  fastResponse: "fast-responses",
  feedback: "feedback-exports",
  chatCompletion: "chat-completions",
  connection: "connection-continuations",
  gitRestorePoints: "git-restore-points",
  question: "question-responses",
  pluginLifecycle: "plugin-resource-lifecycle",
  toolAction: "tool-action-receipts",
  terminalWorkspaces: "terminal-workspaces",
  routineSchedules: "routine-schedules",
  issueMonitors: "issue-monitors",
  caseHandoffs: "case-handoffs",
} as const;
export type DeliveryQueue = typeof DELIVERY_QUEUES[keyof typeof DELIVERY_QUEUES];

export async function notifyDeliveryWork(transaction: object, queue: DeliveryQueue, hint?: string): Promise<void> {
  await signalDatabaseWork(transaction, queue, hint);
}
// Public delivery notification observers only see settled work. The coordinator
// uses the lower-level lifecycle subscription to also fence in-flight writes.
export function subscribeDeliveryWork(owner: object, queue: DeliveryQueue, wake: () => void): () => void {
  return subscribeDatabaseWork(owner, queue, event => {
    if (event === "settled") wake();
  });
}
