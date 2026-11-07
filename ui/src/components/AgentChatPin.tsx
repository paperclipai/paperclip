import { Pin, PinOff } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { usePinnedNavigation } from "@/hooks/usePinnedNavigation";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export const agentChatPinKey = (companyId: string, agentId: string) => `agent-chat:${companyId}:${agentId}`;

export function AgentChatPin({ agent, className }: {
  agent: { id: string; companyId: string; name: string }; className?: string;
}) {
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const userId = session.data?.user?.id ?? session.data?.session?.userId;
  const navigation = usePinnedNavigation(userId);
  const key = agentChatPinKey(agent.companyId, agent.id);
  const pinned = navigation.pins.includes(key);
  const Icon = pinned ? PinOff : Pin;
  return <>
    <button type="button" aria-label={`${pinned ? "Unpin" : "Pin"} ${agent.name}`} aria-pressed={pinned}
      title={`${pinned ? "Unpin" : "Pin"} ${agent.name}`} disabled={!navigation.canPin}
      onClick={event => { event.preventDefault(); event.stopPropagation(); navigation.toggle(key); }}
      className={cn("agent-chat-pin absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/agent-pin:opacity-100 group-focus-within/agent-pin:opacity-100 pointer-coarse:opacity-100", className)}>
      <Icon aria-hidden className="size-4" />
    </button>
    {navigation.error && <span role="alert" className="text-xs text-destructive">{navigation.error}</span>}
  </>;
}
