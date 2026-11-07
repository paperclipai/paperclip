import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { AgentChatPicker } from "./AgentChatPicker";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "./ui/button";
import { useAgentChatNavigation } from "@/hooks/useAgentChatNavigation";
import { useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { useTranslation } from "@/i18n";

/** Switching opens the existing conversation or its unsaved draft view.
 * The production chat controller persists it only when the user sends. */
export function CoordinatorAgentSwitcher({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  const { agents, chats } = useAgentChatNavigation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const chatAgentIds = useMemo(() => {
    const existing: string[] = [];
    const unread = new Map<string, number>();
    for (const chat of chats.data ?? []) {
      if (!chat.conversationAgentId) continue;
      existing.push(chat.conversationAgentId);
      if (chat.unreadMessageCount) unread.set(chat.conversationAgentId, chat.unreadMessageCount);
    }
    return { existing, unread };
  }, [chats.data]);
  return (
    <AgentChatPicker
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="ghost" size="sm" className="min-w-0 max-w-full gap-1.5 px-1.5 text-foreground" aria-label={t("issues.coordinatorAgentSwitcher.switchAgentLabel", { name: agent.name })} aria-current="page" title={t("issues.coordinatorAgentSwitcher.switchAgentTitle")}>
          <AgentAvatar agent={agent} size={24} />
          <span data-agent-name className="truncate">{agent.name}</span>
          <ChevronDown className="size-4" />
        </Button>
      }
      agents={(agents.data ?? []).filter(item => item.status !== "terminated")}
      loading={agents.isPending}
      error={agents.error}
      onRetry={() => { void agents.refetch(); }}
      existingChatAgentIds={chatAgentIds.existing}
      unreadMessageCounts={chatAgentIds.unread}
      onSelect={next => { navigate(`/chats/${encodeURIComponent(agentRouteRef(next))}`); }}
    />
  );
}
