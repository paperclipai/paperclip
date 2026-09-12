import { t, useTranslation } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BadgeDollarSign,
  BookOpenText,
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
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { useChatConnectorsEnabled } from "@/hooks/useChatConnectorsEnabled";
import { queryKeys } from "@/lib/queryKeys";
import { ContextualSidebarFrame } from "./ContextualSidebarFrame";
import { SidebarNavItem } from "./SidebarNavItem";
import { contextualSidebarStyles } from "./contextual-sidebar-styles";
import {
  AGENT_DETAIL_NAVIGATION,
  agentDetailHref,
  agentScopedAuditHref,
  type AgentLocalDetailView,
} from "@/pages/agent-detail-navigation";

const localIcons = {
  overview: Sparkles,
  instructions: BookOpenText,
  skills: Library,
  runtime: Settings2,
  secrets: ShieldCheck,
  tools: Wrench,
  channels: MessageSquare,
  permissions: ShieldCheck,
  "api-keys": KeyRound,
  revisions: History,
} satisfies Record<AgentLocalDetailView, typeof Sparkles>;

const auditItems = [
  { section: "activity", get label() { return t("localizationActivity.section_activity"); }, icon: Activity },
  { section: "runs", get label() { return t("localizationActivity.section_runs"); }, icon: PlayCircle },
  { section: "costs", get label() { return t("localizationActivity.section_costs"); }, icon: ReceiptText },
  { section: "budgets", get label() { return t("localizationActivity.section_budgets"); }, icon: BadgeDollarSign },
] as const;

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
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { enabled: chatConnectorsEnabled } = useChatConnectorsEnabled();
  const shouldResolveAgent = !agentId || !agentName;
  const { data: resolvedAgent } = useQuery({
    queryKey: [...queryKeys.agents.detail(agentRef), selectedCompanyId ?? null, "contextual-sidebar"],
    queryFn: () => agentsApi.get(agentRef, selectedCompanyId ?? undefined),
    enabled: shouldResolveAgent && Boolean(agentRef && selectedCompanyId),
  });
  const resolvedId = agentId ?? resolvedAgent?.id;
  const resolvedName = agentName ?? resolvedAgent?.name ?? t("pages.agentDetail.agentFallback");

  return (
    <ContextualSidebarFrame
      surface="agent"
      title={resolvedName}
      fallbackTo="/agents/all"
      showHeader={false}
      className="border-r border-border bg-background"
    >
      <nav
        aria-label={t("localizationAgentChrome.agentNavigation", { name: resolvedName })}
        data-slot="contextual-sidebar-nav"
        className={contextualSidebarStyles.nav}
      >
        {AGENT_DETAIL_NAVIGATION.map((section) => (
          <div
            key={section.items[0]?.value}
            data-slot="contextual-sidebar-section"
            className={contextualSidebarStyles.section}
          >
            <p
              data-slot="contextual-sidebar-section-label"
              className={contextualSidebarStyles.sectionLabel}
            >
              {section.label}
            </p>
            <div data-slot="contextual-sidebar-group" className={contextualSidebarStyles.group}>
              {section.items
                .filter((item) => item.value !== "channels" || chatConnectorsEnabled)
                .map((item) => {
                  const href = agentDetailHref(agentRef, item.value);
                  return (
                    <SidebarNavItem
                      key={item.value}
                      to={href}
                      label={labels?.[item.value] ?? (labels === undefined && item.value === "secrets" ? t("localizationAgentChrome.secretsAndVariables") : item.label)}
                      icon={localIcons[item.value]}
                    />
                  );
                })}
            </div>
          </div>
        ))}

        <div data-slot="contextual-sidebar-section" className={contextualSidebarStyles.section}>
          <p
            data-slot="contextual-sidebar-section-label"
            className={contextualSidebarStyles.sectionLabel}
          >{t("pages.agentDetail.tabAudit")}</p>
          <div data-slot="contextual-sidebar-group" className={contextualSidebarStyles.group}>
            {resolvedId ? auditItems.map((item) => (
              <SidebarNavItem
                key={item.section}
                to={agentScopedAuditHref(resolvedId, item.section)}
                label={item.label}
                icon={item.icon}
              />
            )) : (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("localizationAgentChrome.ui68_Loading_audit_links")}</p>
            )}
          </div>
        </div>
      </nav>
    </ContextualSidebarFrame>
  );
}
