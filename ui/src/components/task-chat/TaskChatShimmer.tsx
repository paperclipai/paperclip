import { createContext, useContext, type ReactNode } from "react";
import type { TaskChatItem } from "./task-chat-model";
import { protocolActivityIsRunning } from "./task-chat-activity-presentation";

const ShimmerOwner = createContext<string | null | undefined>(undefined);

/** One current surface owns motion. Do not revive an earlier tool merely
 * because the provider has not sent its completion frame yet. */
export function taskChatShimmerOwner(items: readonly TaskChatItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "usage" || item.kind === "status") continue;
    if (item.kind === "thinking") return item.streaming ? item.id : "working";
    if (item.kind === "tool") return item.status === "in_progress" || item.status === "pending" ? item.id : "working";
    if (item.kind === "message") return item.streaming ? null : "working";
    if (item.kind === "protocol") {
      if (item.surface === "runtime_request" && item.status === "pending") return null;
      return protocolActivityIsRunning(item) ? item.id : "working";
    }
  }
  return "working";
}

export function TaskChatShimmerScope({ items, children }: { items: readonly TaskChatItem[]; children: ReactNode }) {
  return <ShimmerOwner.Provider value={taskChatShimmerOwner(items)}>{children}</ShimmerOwner.Provider>;
}

/** Standalone specimens retain their own state unless a turn elects an owner. */
export function useTaskChatShimmer(id: string): boolean {
  const owner = useContext(ShimmerOwner);
  return owner === undefined || owner === id;
}

/** Startup plumbing is already represented by Working, rather than appearing
 * as a fake activity. Keep actionable queues, recovery and errors visible. */
export function visibleTranscriptPlaceholder(message?: string): string | undefined {
  if (!message) return undefined;
  const text = message.trim();
  return /^(?:(?:preparing|loading|waiting for)\s+(?:the\s+)?(?:transcript|turn)(?:[.…]+)?|run phase:\s*(?:prepare_turn|prepare_transcript)\b.*)$/iu.test(text) ? undefined : message;
}
