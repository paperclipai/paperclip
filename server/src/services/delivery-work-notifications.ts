import { signalDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db";

/** Topics for existing durable queues; register intent before their writes. */
export const DELIVERY_QUEUES = {
  executionFinalization: "execution-finalization",
  workspaceRecovery: "workspace-recovery",
  executionReplacement: "execution-replacement",
  executionContinuation: "execution-continuation",
  executionStatus: "execution-status",
  executionDisposition: "execution-disposition",
  environmentCleanup: "environment-cleanup",
  approvalQueueSeeding: "approval-queue-seeding",
  approvalRetention: "approval-retention",
  joinRequestRetention: "join-request-retention",
  decisionTargets: "decision-targets",
  decisionEffectRecovery: "decision-effect-recovery",
  decisionExpiry: "decision-expiry",
  decisionContinuation: "decision-continuation",

  decisionArchiveDelivery: "decision-archive-delivery",
  toolConnectionHealth: "tool-connection-health",
  toolReviewProjection: "tool-review-projection",
  toolReviewInterruption: "tool-review-interruption",
  toolReviewRecovery: "tool-review-recovery",
  toolReviewExpiry: "tool-review-expiry",
  gatewayCredentialExpiry: "gateway-credential-expiry",
  secretProposalExpiry: "secret-proposal-expiry",
  customImageExpiry: "custom-image-expiry",
  historicalCleanup: "historical-cleanup",
  adapterLoginCleanup: "adapter-login-cleanup",
  setupTokenCleanup: "setup-token-cleanup",
  localLoginCleanup: "local-login-cleanup",
  budgetEnforcement: "budget-enforcement",
  accounting: "cost-accounting",
  taskDrainExpiry: "task-drain-expiry",
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
  chatReceivers: "chat-receivers",
  voiceSessionRecovery: "voice-session-recovery",
  voiceInboundCleanup: "voice-inbound-cleanup",
  voiceReplies: "voice-reply-delivery",
  chatCommandRegistration: "chat-command-registration",
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
  grokDispatch: "grok-dispatch",
  skillSourceSync: "skill-source-sync",
  fastResponse: "fast-responses",
  feedback: "feedback-exports",
  chatCompletion: "chat-completions",
  connection: "connection-continuations",
  gitRestorePoints: "git-restore-points",
  nativeWorkspaceSyncRetention: "native-workspace-sync-retention",
  question: "question-responses",
  pluginSchedules: "plugin-schedules",
  pluginLifecycle: "plugin-resource-lifecycle",
  toolAction: "tool-action-receipts",
  terminalWorkspaces: "terminal-workspaces",
  routineSchedules: "routine-schedules",
  issueMonitors: "issue-monitors",
  caseHandoffs: "case-handoffs",
  nativeCheckpointExpiration: "native-checkpoint-expiration",
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
