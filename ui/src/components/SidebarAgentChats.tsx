import { useState } from "react";
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
import { useLocation, useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { AgentChatSidebar } from "./AgentChatSidebar";
import { AgentChatPicker } from "./AgentChatPicker";
import { useSidebar } from "@/context/SidebarContext";

export function SidebarAgentChats() {
  const { selectedCompanyId } = useCompany();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id ?? session?.session?.userId;
  return (
    <CompanyAgentChats
      key={`${selectedCompanyId}:${userId ?? "local-board"}`}
      companyId={selectedCompanyId}
      userId={userId}
    />
  );
}

// A scope change unmounts the picker, including its open state and search.
function CompanyAgentChats({ companyId, userId }: { companyId: string | null; userId?: string }) {
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const agents = agentsQuery.data ?? [];
  const [pickerOpen, setPickerOpen] = useState(false);
  const navigate = useNavigate();
  const { isMobile, setSidebarOpen } = useSidebar();
  const recentIds = useRecentAgentChats(companyId ?? "", userId);
  const memberships = useResourceMemberships(companyId);
  const mutation = useResourceMembershipMutation(companyId);
  const stars = memberships.data?.starredAgentIds ?? [];
  const location = useLocation();
  const activeRef = location.pathname.match(/\/chats\/([^/]+)/)?.[1];
  const active = agents.find((agent) => agent.id === activeRef || agentRouteRef(agent) === activeRef);
  return (
    <>
      <AgentChatSidebar
        agents={agents}
        onOpenChat={() => setPickerOpen(true)}
        activeId={active?.id ?? ""}
        starredIds={stars}
        recentIds={recentIds}
        onToggleStar={(id) => {
          mutation.mutate({
            resourceType: "agent",
            resourceId: id,
            resourceName: agents.find((agent) => agent.id === id)?.name ?? "Agent",
            starred: !stars.includes(id),
          });
        }}
      />
      <AgentChatPicker
        agents={agents}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        loading={agentsQuery.isPending}
        error={agentsQuery.error}
        onRetry={() => { void agentsQuery.refetch(); }}
        onSelect={(agent) => {
          if (isMobile) setSidebarOpen(false);
          navigate(`/chats/${encodeURIComponent(agentRouteRef(agent))}`);
        }}
      />
    </>
  );
}
