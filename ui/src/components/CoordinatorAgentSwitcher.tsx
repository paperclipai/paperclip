import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { AgentChatPicker } from "./AgentChatPicker";
import { AgentAvatar } from "./AgentAvatar";
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
  return (
    <AgentChatPicker
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="ghost" size="sm" className="min-w-0 max-w-full gap-1.5 px-1.5 text-foreground" aria-label={`Switch agent. Currently ${agent.name}`} aria-current="page" title="Switch agent">
          <AgentAvatar agent={agent} size={24} />
          <span data-agent-name className="truncate">{agent.name}</span>
          <ChevronDown className="size-4" />
        </Button>
      }
      agents={(agents.data ?? []).filter(item => item.status !== "terminated")}
      loading={agents.isPending}
      error={agents.error}
      onRetry={() => { void agents.refetch(); }}
      existingChatAgentIds={(chats.data ?? []).flatMap(chat => chat.conversationAgentId ? [chat.conversationAgentId] : [])}
      onSelect={next => { navigate(`/chats/${encodeURIComponent(agentRouteRef(next))}`); }}
    />
  );
}
