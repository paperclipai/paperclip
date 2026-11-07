import type { Issue } from "@paperclipai/shared";
import { Boxes, CircleCheck, CirclePlus, FolderOpen, History, LayoutDashboard, MessageCircle, Package, Repeat, Search, Unplug, Users } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useTranslation } from "@/i18n";
import { SidebarAccountMenu } from "./SidebarAccountMenu";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { SidebarNavExpandedProvider, SidebarNavItem } from "./SidebarNavItem";
import { SidebarSection } from "./SidebarSection";
import { TruncatedTextMarqueeProvider } from "./TruncatedText";
import { Button } from "./ui/button";
import { FlyoutAppearanceProvider } from "./ui/flyout";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useScrollbarWhileScrolling } from "./side-panel/use-scrollbar-while-scrolling";

export type DesignSidebarRecentTask = Pick<Issue, "id" | "companyId" | "identifier" | "title">;

/** Shared staged sidebar. The caller supplies company-scoped recent tasks and actions. */
export function DesignSidebar({ onNewTask, recentTasks = [] }: { onNewTask: () => void; recentTasks?: readonly DesignSidebarRecentTask[] }) {
  const { t } = useTranslation();
  const { selectedCompany } = useCompany();
  const root = `/${selectedCompany?.issuePrefix ?? "PAP"}`;
  const companyRecentTasks = recentTasks.filter(task => task.companyId === selectedCompany?.id);
  const handleRecentScroll = useScrollbarWhileScrolling();
  return (
    <FlyoutAppearanceProvider><TruncatedTextMarqueeProvider><SidebarNavExpandedProvider>
      <div className="design-sidebar">
        <div className="design-sidebar-brand">
          <SidebarCompanyMenu showChevron={false} />
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="design-sidebar-search" aria-label={t("tools.designSidebar.globalSearch")} onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }))}><Search aria-hidden /></Button></TooltipTrigger><TooltipContent side="right">{t("tools.designSidebar.searchTooltip")}</TooltipContent></Tooltip>
        </div>
        <nav className="design-sidebar-navigation" aria-label={t("tools.designSidebar.mainNavigation")}>
          <div className="design-sidebar-primary">
            <Button variant="ghost" className="design-sidebar-new-task" onClick={onNewTask}><CirclePlus aria-hidden />{t("tools.designSidebar.newTask")}</Button>
            <SidebarNavItem className="design-sidebar-item" to={`${root}/dashboard`} label={t("tools.designSidebar.dashboard")} icon={LayoutDashboard} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/chats`} label={t("tools.designSidebar.chat")} icon={MessageCircle} />
          </div>
          <SidebarSection label={t("tools.designSidebar.work")}>
            <SidebarNavItem className="design-sidebar-item" to={`${root}/issues`} label={t("tools.designSidebar.tasks")} icon={CircleCheck} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/projects`} label={t("tools.designSidebar.projects")} icon={FolderOpen} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/routines`} label={t("tools.designSidebar.routines")} icon={Repeat} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/artifacts`} label={t("tools.designSidebar.artifacts")} icon={Package} />
          </SidebarSection>
          <SidebarSection label={t("tools.designSidebar.org")}>
            <SidebarNavItem className="design-sidebar-item" to={`${root}/agents`} label={t("tools.designSidebar.agents")} icon={Users} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/skills`} label={t("tools.designSidebar.skills")} icon={Boxes} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/apps`} label={t("tools.designSidebar.connectors")} icon={Unplug} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/activity`} label={t("tools.designSidebar.audit")} icon={History} />
          </SidebarSection>
          {companyRecentTasks.length > 0 ? <div className="design-sidebar-recents">
            <SidebarSection label={t("tools.designSidebar.recentTasks")}>
              <div onScroll={handleRecentScroll} className="design-sidebar-recent-list scrollbar-while-scrolling" role="region" aria-label={t("tools.designSidebar.recentTasksRegion")} tabIndex={0}>
              {companyRecentTasks.map(issue => <SidebarNavItem key={issue.id} className="design-sidebar-item" to={`${root}/issues/${issue.identifier}`} label={issue.title} />)}
              </div>
            </SidebarSection>
          </div> : null}
        </nav>
        <div className="design-sidebar-account"><SidebarAccountMenu forceExpanded /></div>
      </div>
    </SidebarNavExpandedProvider></TruncatedTextMarqueeProvider></FlyoutAppearanceProvider>
  );
}
