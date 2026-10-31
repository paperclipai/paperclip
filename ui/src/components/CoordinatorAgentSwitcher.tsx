import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { AgentChatPicker } from "./AgentChatPicker";
import { Button } from "./ui/button";
import { useAgentChatNavigation } from "@/hooks/useAgentChatNavigation";
import { useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";

/** Switching opens the existing conversation or its unsaved draft view.
 * The production chat controller persists it only when the user sends. */
export function CoordinatorAgentSwitcher({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  const { agents, chats } = useAgentChatNavigation();
  const navigate = useNavigate();
  return <>
    <Button variant="ghost" size="icon-xs" aria-label={`Switch agent. Currently ${agent.name}`} title="Switch agent" onClick={() => setOpen(true)}><ChevronDown className="size-4" /></Button>
    <AgentChatPicker open={open} onOpenChange={setOpen} agents={(agents.data ?? []).filter(item => item.status !== "terminated")}
      loading={agents.isPending} error={agents.error} onRetry={() => { void agents.refetch(); }}
      existingChatAgentIds={(chats.data ?? []).flatMap(chat => chat.conversationAgentId ? [chat.conversationAgentId] : [])}
      onSelect={next => { navigate(`/chats/${encodeURIComponent(agentRouteRef(next))}`); }} />
  </>;
}
