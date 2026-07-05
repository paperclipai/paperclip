import { arraysEqual } from "./agent-skills-state";

/**
 * Draft/hydration state for the agent MCP tab's checkbox list (generalized
 * from agent-skills-state so both tabs share the same autosave semantics).
 */
export interface AgentMcpDraftState {
  draft: string[];
  lastSaved: string[];
  hasHydratedSnapshot: boolean;
}

export interface AgentMcpSnapshotApplyResult extends AgentMcpDraftState {
  shouldSkipAutosave: boolean;
}

export function applyAgentMcpServersSnapshot(
  state: AgentMcpDraftState,
  desiredMcpServers: string[],
): AgentMcpSnapshotApplyResult {
  const shouldReplaceDraft = !state.hasHydratedSnapshot || arraysEqual(state.draft, state.lastSaved);

  return {
    draft: shouldReplaceDraft ? desiredMcpServers : state.draft,
    lastSaved: desiredMcpServers,
    hasHydratedSnapshot: true,
    shouldSkipAutosave: shouldReplaceDraft,
  };
}
