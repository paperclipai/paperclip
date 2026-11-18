import type { Agent } from "@paperclipai/shared";
import type { InlineEntityOption } from "@/components/InlineEntitySelector";
import { assigneeValueFromSelection } from "./assignees";
import { isAgentTaskTarget } from "./company-members";
import { sortAgentsByRecency } from "./recent-assignees";

/**
 * The Dashboard's chat composer (experimental, `enableResponsibilities`):
 * which agents it can start a chat with, and which one it starts on.
 */

type ChatAgent = Pick<Agent, "id" | "name" | "status" | "createdAt"> & Partial<Pick<Agent, "role" | "title" | "orgChainHealth">>;

/** Agents a chat can be started with: the same set the task composer offers (not terminated, not awaiting approval). */
export function chatTargetAgents<T extends ChatAgent>(agents: readonly T[]): T[] {
  return agents.filter((agent) => isAgentTaskTarget(agent));
}

/**
 * The agent the composer starts on: the first one created in the
 * organization that can still be chatted with (earliest `createdAt`, ties by
 * id). Null with none.
 */
export function defaultChatAgent<T extends ChatAgent>(agents: readonly T[]): T | null {
  let first: T | null = null;
  for (const agent of chatTargetAgents(agents)) {
    if (!first) {
      first = agent;
      continue;
    }
    const at = new Date(agent.createdAt).getTime();
    const firstAt = new Date(first.createdAt).getTime();
    if (at < firstAt || (at === firstAt && agent.id < first.id)) first = agent;
  }
  return first;
}

/** The picker's options, in the task composer's order (recently chosen first) and value format ("agent:<id>"). */
export function chatAgentOptions(agents: readonly ChatAgent[], recentAgentIds: readonly string[]): InlineEntityOption[] {
  return sortAgentsByRecency(chatTargetAgents(agents), [...recentAgentIds]).map((agent) => ({
    id: assigneeValueFromSelection({ assigneeAgentId: agent.id }),
    label: agent.name,
    searchText: `${agent.name} ${agent.role ?? ""} ${agent.title ?? ""}`,
  }));
}

/** The agent id in a picker value ("agent:<id>"), or null. */
export function agentIdFromChatValue(value: string | null | undefined): string | null {
  return value?.startsWith("agent:") ? value.slice("agent:".length) || null : null;
}
