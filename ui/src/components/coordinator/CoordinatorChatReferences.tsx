import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAgentChatNavigation } from "@/hooks/useAgentChatNavigation";
import { agentRouteRef } from "@/lib/utils";

type ChatReference = { label: string; href: string };
export const CoordinatorChatReferences = createContext<ReadonlyMap<string, ChatReference>>(new Map());
export const useCoordinatorChatReference = (reference: string) => useContext(CoordinatorChatReferences).get(reference.toLowerCase());

function ActiveChatReferences({ children }: { children: ReactNode }) {
  const { chats, agents } = useAgentChatNavigation();
  const references = useMemo(() => {
    const result = new Map<string, ChatReference>();
    for (const chat of chats.data ?? []) {
      const agent = agents.data?.find(candidate => candidate.id === chat.conversationAgentId);
      if (!agent) continue;
      const reference = { label: `Chat with ${agent.name}`, href: `/chats/${encodeURIComponent(agentRouteRef(agent))}` };
      result.set(chat.id.toLowerCase(), reference);
      if (chat.identifier) result.set(chat.identifier.toLowerCase(), reference);
    }
    return result;
  }, [chats.data, agents.data]);
  return <CoordinatorChatReferences.Provider value={references}>{children}</CoordinatorChatReferences.Provider>;
}

/** Resolve labels once from the same person/company-scoped list used by navigation. */
export function CoordinatorChatReferencesProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return enabled ? <ActiveChatReferences>{children}</ActiveChatReferences> : children;
}
