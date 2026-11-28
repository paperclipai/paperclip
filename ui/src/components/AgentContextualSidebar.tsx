import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  FileCode2,
  Fingerprint,
  Gauge,
  History,
  KeyRound,
  Library,
  MessageSquare,
  PlayCircle,
  ReceiptText,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useAgentEnvironmentSlots } from "@/plugins/useAgentEnvironmentSlots";
import { usePluginSlots } from "@/plugins/slots";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { ContextualSidebarFrame } from "./ContextualSidebarFrame";
import { MobileContextualNav, type MobileContextualNavGroup } from "./MobileContextualNav";
import { SidebarNavItem } from "./SidebarNavItem";
import { contextualSidebarStyles } from "./contextual-sidebar-styles";
import {
  AGENT_DETAIL_NAVIGATION,
  agentDetailHref,
  type AgentLocalDetailView,
} from "@/pages/agent-detail-navigation";

const localIcons = {
  overview: Sparkles,
  instructions: Fingerprint,
  skills: Library,
  runtime: Settings2,
  secrets: KeyRound,
  tools: Wrench,
  channels: MessageSquare,
  permissions: ShieldCheck,
  "api-keys": KeyRound,
  revisions: History,
  advanced: FileCode2,
  activity: Activity,
  runs: PlayCircle,
  costs: ReceiptText,
  budgets: Gauge,
} satisfies Record<AgentLocalDetailView, typeof Sparkles>;

interface AgentContextualNavigationProps {
  agentRef: string;
  agentId?: string;
  agentName?: string;
  labels?: Partial<Record<AgentLocalDetailView, string>>;
}

function useAgentContextualNavigation({
  agentRef,
  agentId,
  agentName,
  labels,
}: AgentContextualNavigationProps) {
  const { selectedCompanyId } = useCompany();
  const shouldResolveAgent = !agentId || !agentName;
  const { data: resolvedAgent } = useQuery({
    queryKey: [...queryKeys.agents.detail(agentRef), selectedCompanyId ?? null, "contextual-sidebar"],
    queryFn: () => agentsApi.get(agentRef, selectedCompanyId ?? undefined),
    enabled: shouldResolveAgent && Boolean(agentRef && selectedCompanyId),
  });
  const resolvedId = agentId ?? resolvedAgent?.id;
  const { slots: declaredTabs } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "agent",
    companyId: resolvedAgent?.companyId ?? selectedCompanyId,
    enabled: Boolean(resolvedId),
  });
  const { slots: pluginTabs } = useAgentEnvironmentSlots(
    declaredTabs,
    resolvedId,
    resolvedAgent?.companyId ?? selectedCompanyId,
  );
  const resolvedName = agentName ?? resolvedAgent?.name ?? "Agent";

  const groups = useMemo<MobileContextualNavGroup[]>(() => {
    const result: MobileContextualNavGroup[] = [];
    for (const section of AGENT_DETAIL_NAVIGATION) {
      if (section.label === "Audit" && pluginTabs.length > 0) {
        result.push({
          key: "Apps",
          items: pluginTabs.map((slot) => ({
            key: `plugin:${slot.pluginKey}:${slot.id}`,
            to: `/agents/${encodeURIComponent(agentRef)}/${encodeURIComponent(`plugin:${slot.pluginKey}:${slot.id}`)}`,
            label: slot.displayName,
            icon: Wrench,
          })),
        });
      }
      result.push({
        key: section.label,
        items: section.items.map((item) => ({
          key: item.value,
          to: agentDetailHref(agentRef, item.value),
          label: labels?.[item.value] ?? item.label,
          icon: localIcons[item.value],
        })),
      });
    }
    return result;
  }, [agentRef, labels, pluginTabs]);

  return { resolvedName, groups };
}

export function AgentContextualSidebar(props: AgentContextualNavigationProps) {
  const { resolvedName, groups } = useAgentContextualNavigation(props);

  return (
    <ContextualSidebarFrame
      surface="agent"
      title={resolvedName}
      fallbackTo="/agents/all"
      showHeader={false}
      className="border-r border-border bg-background"
    >
      <nav
        aria-label={`${resolvedName} navigation`}
        data-slot="contextual-sidebar-nav"
        className={contextualSidebarStyles.nav}
      >
        {groups.map((section) => (
          <div key={section.key} data-slot="contextual-sidebar-section" className={contextualSidebarStyles.section}>
            <p data-slot="contextual-sidebar-section-label" className={contextualSidebarStyles.sectionLabel}>
              {section.key}
            </p>
            <div data-slot="contextual-sidebar-group" className={contextualSidebarStyles.group}>
              {section.items.map((item) => (
                <SidebarNavItem
                  key={item.key}
                  to={item.to}
                  label={item.label}
                  icon={item.icon ?? Wrench}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
    </ContextualSidebarFrame>
  );
}

export function AgentContextualMobileNav(props: AgentContextualNavigationProps) {
  const { resolvedName, groups } = useAgentContextualNavigation(props);

  return (
    <MobileContextualNav
      surface="agent"
      ariaLabel={`${resolvedName} navigation`}
      groups={groups}
    />
  );
}
