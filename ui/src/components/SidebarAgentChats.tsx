import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { useCompany } from "@/context/CompanyContext";
import {
  useResourceMemberships,
  useResourceMembershipMutation,
} from "@/hooks/useResourceMemberships";
import { useRecentAgentChats } from "@/lib/recent-agent-chats";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { AgentChatSidebar } from "./AgentChatSidebar";
export function SidebarAgentChats() {
  const { selectedCompanyId } = useCompany();
  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id ?? session?.session?.userId;
  const recentIds = useRecentAgentChats(selectedCompanyId ?? "", userId);
  const memberships = useResourceMemberships(selectedCompanyId);
  const mutation = useResourceMembershipMutation(selectedCompanyId);
  const stars = memberships.data?.starredAgentIds ?? [];
  const location = useLocation();
  const activeRef = location.pathname.match(/\/chats\/([^/]+)/)?.[1];
  const active = agents.find(
    (agent) => agent.id === activeRef || agentRouteRef(agent) === activeRef,
  );
  return (
    <AgentChatSidebar
      agents={agents}
      activeId={active?.id ?? ""}
      starredIds={stars}
      recentIds={recentIds}
      onToggleStar={(id) => {
        mutation.mutate({
          resourceType: "agent",
          resourceId: id,
          resourceName:
            agents.find((agent) => agent.id === id)?.name ?? "Agent",
          starred: !stars.includes(id),
        });
      }}
    />
  );
}
