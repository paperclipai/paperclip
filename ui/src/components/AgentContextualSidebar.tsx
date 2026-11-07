import { getAgentConfigDisplayText } from "@/adapters/display-translations";
import { useTranslation } from "@/i18n";
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
import { usePluginSlots } from "@/plugins/slots";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { ContextualSidebarFrame } from "./ContextualSidebarFrame";
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

export function AgentContextualSidebar({
  agentRef,
  agentId,
  agentName,
  labels,
}: {
  agentRef: string;
  agentId?: string;
  agentName?: string;
  labels?: Partial<Record<AgentLocalDetailView, string>>;
}) {
  const { t } = useTranslation("agent-config");
  const { selectedCompanyId } = useCompany();
  const shouldResolveAgent = !agentId || !agentName;
  const { data: resolvedAgent } = useQuery({
    queryKey: [...queryKeys.agents.detail(agentRef), selectedCompanyId ?? null, "contextual-sidebar"],
    queryFn: () => agentsApi.get(agentRef, selectedCompanyId ?? undefined),
    enabled: shouldResolveAgent && Boolean(agentRef && selectedCompanyId),
  });
  const resolvedId = agentId ?? resolvedAgent?.id;
  const { slots: pluginTabs } = usePluginSlots({ slotTypes: ["detailTab"], entityType: "agent", companyId: resolvedAgent?.companyId ?? selectedCompanyId, enabled: Boolean(resolvedId) });
  const resolvedName = agentName ?? resolvedAgent?.name ?? t("agent-config:agent_5ce2e6f");

  return (
    <ContextualSidebarFrame
      surface="agent"
      title={resolvedName}
      fallbackTo="/agents/all"
      showHeader={false}
      className="border-r border-border bg-background"
    >
      <nav
        aria-label={t("agent-config:valueNavigation_8a5e3ed", { value1: resolvedName })}
        data-slot="contextual-sidebar-nav"
        className={contextualSidebarStyles.nav}
      >
        {AGENT_DETAIL_NAVIGATION.map((section) => (
          <div key={section.label} className="contents">
            {section.label === "Audit" && pluginTabs.length > 0 ? (
              <div data-slot="contextual-sidebar-section" className={contextualSidebarStyles.section}>
                <p className={contextualSidebarStyles.sectionLabel}>{t("agent-config:apps_d9a3685")}</p>
                <div className={contextualSidebarStyles.group}>
                  {pluginTabs.map(slot => <SidebarNavItem key={`${slot.pluginKey}:${slot.id}`} to={`/agents/${encodeURIComponent(agentRef)}/${encodeURIComponent(`plugin:${slot.pluginKey}:${slot.id}`)}`} label={slot.displayName} icon={Wrench} />)}
                </div>
              </div>
            ) : null}
            <div data-slot="contextual-sidebar-section" className={contextualSidebarStyles.section}>
              <p data-slot="contextual-sidebar-section-label" className={contextualSidebarStyles.sectionLabel}>
                {getAgentConfigDisplayText(section.label)}
              </p>
              <div data-slot="contextual-sidebar-group" className={contextualSidebarStyles.group}>
                {section.items.map((item) => (
                  <SidebarNavItem
                    key={item.value}
                    to={agentDetailHref(agentRef, item.value)}
                    label={labels?.[item.value] ?? getAgentConfigDisplayText(item.label)}
                    icon={localIcons[item.value]}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}
      </nav>
    </ContextualSidebarFrame>
  );
}
