import { t } from "@/i18n";
/**
 * Canonical state inventory for the chat-style task thread (the default task
 * view; the classic legacy view sits behind enableClassicTaskInterface).
 *
 * This list is the single source of truth for:
 *   - the dev harness state switcher (/dev/task-chat-lab), and
 *   - the finish-line test that asserts every state renders without error.
 *
 * Each id traces to a real agent-protocol state (plan Deliverable 1). `tier`
 * marks whether the state already streams live ("live") or is emitted upstream
 * but dropped by acpx today ("tier-b", driven by synthetic events in the
 * harness, live wiring flagged). `surface` says where the state renders.
 */

export const TASK_CHAT_STATES = [
  "session-start",
  "human-message",
  "agent-message",
  "thinking",
  "responding",
  "responding-burst",
  "tool-call",
  "diff",
  "working",
  "running",
  "completed",
  "activity-phases",
  "awaiting-approval",
  "plan-todo",
  "interrupted",
  "refused",
  "truncated",
  "live-token-cost",
] as const;

export type TaskChatStateId = (typeof TASK_CHAT_STATES)[number];

export type TaskChatStateTier = "live" | "tier-b";
export type TaskChatStateSurface = "thread" | "plan";

export interface TaskChatStateMeta {
  id: TaskChatStateId;
  label: string;
  tier: TaskChatStateTier;
  surface: TaskChatStateSurface;
  /** Real protocol source, quoted for the harness inspector. */
  protocol: string;
}

export const TASK_CHAT_STATE_META: Record<TaskChatStateId, TaskChatStateMeta> = {
  "session-start": {
    id: "session-start",
    get label() { return t("localizationTaskRuntime.ui_Session_start_qxg2fj"); },
    tier: "live",
    surface: "thread",
    protocol: 'acpx.session → TranscriptEntry kind:"init"',
  },
  "human-message": {
    id: "human-message",
    get label() { return t("localizationTaskRuntime.ui_Human_message_ehyjjh"); },
    tier: "live",
    surface: "thread",
    protocol: 'IssueComment authorType:"user"',
  },
  "agent-message": {
    id: "agent-message",
    get label() { return t("localizationTaskRuntime.ui_Final_response_1uq0rzi"); },
    tier: "live",
    surface: "thread",
    protocol: 'PRP item.delta kind:"agentMessage" channel:"final"',
  },
  thinking: {
    id: "thinking",
    get label() { return t("localizationTaskRuntime.ui_Thinking_jkajtp"); },
    tier: "live",
    surface: "thread",
    protocol: "text_delta stream:thought (ACP agent_thought_chunk)",
  },
  responding: {
    id: "responding",
    get label() { return t("localizationTaskRuntime.ui_Progress_update_streaming_hg4p2c"); },
    tier: "live",
    surface: "thread",
    protocol: 'PRP item.delta kind:"agentMessage" channel:"progress"',
  },
  "responding-burst": {
    id: "responding-burst",
    get label() { return t("localizationTaskRuntime.ui_Progress_update_burst_1m9uz6t"); },
    tier: "live",
    surface: "thread",
    protocol: "text_delta stream:output ×N, tool calls between (PAP-368 dwell)",
  },
  "tool-call": {
    id: "tool-call",
    get label() { return t("localizationTaskRuntime.ui_Tool_call_xd7uax"); },
    tier: "live",
    surface: "thread",
    protocol: "acpx.tool_call (ACP tool_call / tool_call_update)",
  },
  diff: {
    id: "diff",
    get label() { return t("localizationTaskRuntime.ui_Diff_1m4w7zu"); },
    tier: "live",
    surface: "thread",
    protocol: 'ToolCallContent type:"diff" → TranscriptEntry kind:"diff"',
  },
  working: {
    id: "working",
    get label() { return t("localizationTaskRuntime.ui_Working_1pyssg8"); },
    tier: "live",
    surface: "thread",
    protocol: "heartbeat.run.progress + acpx.status",
  },
  running: {
    id: "running",
    get label() { return t("localizationTaskRuntime.ui_Running_j6ts6k"); },
    tier: "live",
    surface: "thread",
    protocol: 'message.status.type === "running"',
  },
  completed: {
    id: "completed",
    get label() { return t("localizationTaskRuntime.ui_Completed_collapsed_lbzyau"); },
    tier: "live",
    surface: "thread",
    protocol: "acpx.result (StopReason in subtype)",
  },
  "activity-phases": {
    id: "activity-phases",
    get label() { return t("localizationTaskRuntime.ui_Long_run_activity_phases_tkw11o"); },
    tier: "live",
    surface: "thread",
    protocol: "assistant boundaries + chronological tool calls",
  },
  "awaiting-approval": {
    id: "awaiting-approval",
    get label() { return t("localizationTaskRuntime.ui_Awaiting_approval_16n26pe"); },
    tier: "tier-b",
    surface: "thread",
    protocol: "ACP RequestPermissionRequest + PermissionOptionKind",
  },
  "plan-todo": {
    id: "plan-todo",
    get label() { return t("localizationTaskRuntime.ui_Plan_todo_17zalrt"); },
    tier: "tier-b",
    surface: "plan",
    protocol: "ACP Plan { entries: PlanEntry[] }, PlanEntryStatus",
  },
  interrupted: {
    id: "interrupted",
    get label() { return t("localizationTaskRuntime.ui_Interrupted_1cnyep"); },
    tier: "tier-b",
    surface: "thread",
    protocol: 'AcpRuntimeTurnResult.status:"cancelled" / StopReason "cancelled"',
  },
  refused: {
    id: "refused",
    get label() { return t("localizationTaskRuntime.ui_Refused_14bph1f"); },
    tier: "tier-b",
    surface: "thread",
    protocol: 'StopReason "refusal"',
  },
  truncated: {
    id: "truncated",
    get label() { return t("localizationTaskRuntime.ui_Truncated_t5okp5"); },
    tier: "tier-b",
    surface: "thread",
    protocol: 'StopReason "max_tokens" | "max_turn_requests"',
  },
  "live-token-cost": {
    id: "live-token-cost",
    get label() { return t("localizationTaskRuntime.ui_Live_token_cost_1chq1o"); },
    tier: "tier-b",
    surface: "thread",
    protocol: "ACP UsageUpdate { used, size, cost }",
  },
};

export const TASK_CHAT_STATE_LIST: TaskChatStateMeta[] = TASK_CHAT_STATES.map(
  (id) => TASK_CHAT_STATE_META[id],
);
