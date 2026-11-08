export const SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES = [
  "workspace.ready",
  "research.started",
  "research.progressed",
  "research.completed",
  "tool.execution.started",
  "tool.execution.progressed",
  "tool.execution.completed",
  "item.completed",
  "delegation.started",
  "delegation.updated",
  "delegation.completed",
  "workspace.change.updated",
  "workspace.diff.recorded",
  "workspace.file.referenced",
  "artifact.generated",
] as const;

export type SafeNativeChatProgressEventType =
  (typeof SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES)[number];

const SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPE_SET = new Set<string>(
  SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES,
);

export function isSafeNativeChatProgressEventType(
  eventType: string,
): eventType is SafeNativeChatProgressEventType {
  return SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPE_SET.has(eventType);
}

export type SafeNativeChatProgressPhase =
  | "preparing"
  | "researching"
  | "making_progress"
  | "using_tools"
  | "coordinating"
  | "working_with_files";

const SAFE_NATIVE_CHAT_PROGRESS_PHASES: Readonly<
  Record<SafeNativeChatProgressEventType, SafeNativeChatProgressPhase>
> = {
  "workspace.ready": "preparing",
  "research.started": "researching",
  "research.progressed": "researching",
  "research.completed": "researching",
  "tool.execution.started": "using_tools",
  "tool.execution.progressed": "using_tools",
  "tool.execution.completed": "using_tools",
  "item.completed": "making_progress",
  "delegation.started": "coordinating",
  "delegation.updated": "coordinating",
  "delegation.completed": "coordinating",
  "workspace.change.updated": "working_with_files",
  "workspace.diff.recorded": "working_with_files",
  "workspace.file.referenced": "working_with_files",
  "artifact.generated": "working_with_files",
};

const SAFE_NATIVE_CHAT_PROGRESS_TEXT: Readonly<
  Record<SafeNativeChatProgressPhase, (agentName: string) => string>
> = {
  preparing: (agentName) => `${agentName} is preparing…`,
  researching: (agentName) => `${agentName} is doing research…`,
  making_progress: (agentName) => `${agentName} is making progress…`,
  using_tools: (agentName) => `${agentName} is using tools…`,
  coordinating: (agentName) => `${agentName} is coordinating work…`,
  working_with_files: (agentName) => `${agentName} is working with files…`,
};

/**
 * Maps only a closed native event type to provider-safe progress. The caller
 * deliberately cannot supply an event message, payload, tool name, target, or
 * result, so those internal fields cannot be projected accidentally.
 */
export function safeNativeChatProgressForEvent(
  eventType: string,
  agentName: string,
): { phase: SafeNativeChatProgressPhase; text: string } | null {
  if (!isSafeNativeChatProgressEventType(eventType)) return null;
  const phase = SAFE_NATIVE_CHAT_PROGRESS_PHASES[eventType];
  return { phase, text: SAFE_NATIVE_CHAT_PROGRESS_TEXT[phase](agentName) };
}
