export { NotifierApi, type NotifierApiOptions } from "./api.js";
export { NotifierDedup, defaultDedupPath, type DedupOptions } from "./dedup.js";
export {
  NotifierPoller,
  type Logger as NotifierLogger,
  type NotifierMetrics,
  type NotifierPollerOptions,
  type TgSender,
  type TgSendResult,
} from "./poller.js";
export {
  approvalIsForUser,
  interactionIsForUser,
  issueIsOwnedByUser,
} from "./filters.js";
export {
  renderApproval,
  renderBlocked,
  renderDone,
  renderInteraction,
  truncate,
} from "./templates.js";
export type {
  AgentRef,
  ApprovalRef,
  CommentRef,
  InteractionRef,
  IssueRef,
  NotifierEventType,
  RenderedEvent,
} from "./types.js";
