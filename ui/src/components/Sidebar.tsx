import {
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  MessagesSquare,
  Search,
  SquarePen,
  Network,
  Boxes,
  Repeat,
  GitBranch,
  Settings,
  Sparkles,
  Library,
  Compass,
  Plug,
  GraduationCap,
  Code2,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { NavLink } from "@/lib/router";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { useBeginnerMode } from "../hooks/useBeginnerMode";

export function Sidebar() {
  const { t } = useTranslation("nav");
  const { openNewIssue } = useDialogActions();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;
  const { beginnerMode, toggle: toggleBeginner } = useBeginnerMode();
  const showAdvanced = !beginnerMode;
  const showWorkspacesLink =
    showAdvanced && experimentalSettings?.enableIsolatedWorkspaces === true;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarCompanyMenu />
        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          aria-label={t("item.search")}
          title={t("item.search")}
        >
          <NavLink to="/search">
            <Search className="h-4 w-4" />
          </NavLink>
        </Button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {/* New Issue button aligned with nav items */}
          <button
            onClick={() => openNewIssue()}
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("item.newIssue")}</span>
          </button>
          <SidebarNavItem to="/chat" label={t("item.chat")} icon={MessagesSquare} />
          <SidebarNavItem to="/dashboard" label={t("item.dashboard")} icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem
            to="/inbox"
            label={t("item.inbox")}
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
            missingBehavior="placeholder"
          />
        </div>

        <SidebarSection label={t("section.work")}>
          <SidebarNavItem to="/company/diagnose" label={t("item.diagnose", { defaultValue: "Diagnóstico" })} icon={Compass} />
          <SidebarNavItem to="/issues" label={t("item.issues")} icon={CircleDot} />
          <SidebarNavItem to="/routines" label={t("item.routines")} icon={Repeat} />
          <SidebarNavItem to="/goals" label={t("item.goals")} icon={Target} />
          {showWorkspacesLink ? (
            <SidebarNavItem to="/workspaces" label={t("item.workspaces")} icon={GitBranch} />
          ) : null}
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarSection label={t("section.company")}>
          <SidebarNavItem to="/company/context" label={t("item.context", { defaultValue: "Contexto" })} icon={Sparkles} />
          <SidebarNavItem to="/company/references" label={t("item.references", { defaultValue: "Referências" })} icon={Library} />
          <SidebarNavItem to="/company/integrations" label={t("item.integrations", { defaultValue: "Integrações" })} icon={Plug} />
          <SidebarNavItem to="/org" label={t("item.org")} icon={Network} />
          {showAdvanced ? (
            <SidebarNavItem to="/skills" label={t("item.skills")} icon={Boxes} />
          ) : null}
          <SidebarNavItem to="/costs" label={t("item.costs")} icon={DollarSign} />
          {showAdvanced ? (
            <SidebarNavItem to="/activity" label={t("item.activity")} icon={History} />
          ) : null}
          <SidebarNavItem to="/company/settings" label={t("item.settings")} icon={Settings} />
        </SidebarSection>

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>
      <div className="shrink-0 border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={toggleBeginner}
          className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          title={
            beginnerMode
              ? "Ativar modo avançado (Skills, Activity, etc)"
              : "Voltar para modo iniciante (esconde itens técnicos)"
          }
        >
          <span className="flex items-center gap-1.5">
            {beginnerMode ? (
              <GraduationCap className="h-3 w-3" />
            ) : (
              <Code2 className="h-3 w-3" />
            )}
            {beginnerMode ? "Modo iniciante" : "Modo avançado"}
          </span>
          <span
            className={`inline-block h-3 w-6 rounded-full transition-colors ${
              beginnerMode ? "bg-muted" : "bg-foreground"
            }`}
          >
            <span
              className={`block h-3 w-3 rounded-full bg-background transition-transform ${
                beginnerMode ? "translate-x-0" : "translate-x-3"
              }`}
            />
          </span>
        </button>
      </div>
    </aside>
  );
}
