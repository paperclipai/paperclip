import { createContext, useContext } from "react";
import type { AgentGraphSticky } from "@paperclipai/shared";

export interface AgentGraphActions {
  updateSticky: (id: string, patch: Partial<Omit<AgentGraphSticky, "id">>) => void;
  requestHire: (draftId: string) => void;
  removeDraft: (draftId: string) => void;
}

export const AgentGraphActionsContext = createContext<AgentGraphActions | null>(null);

export function useAgentGraphActions(): AgentGraphActions {
  const actions = useContext(AgentGraphActionsContext);
  if (!actions) throw new Error("useAgentGraphActions must be used inside the agent graph");
  return actions;
}
