import { t, useTranslation } from "@/i18n";
import type { Issue } from "@paperclipai/shared";
import { Boxes, CircleCheck, CirclePlus, FolderOpen, History, LayoutDashboard, MessageCircle, Package, Repeat, Search, Unplug, Users } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
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
  useTranslation("task-components");
  const { selectedCompany } = useCompany();
  const root = `/${selectedCompany?.issuePrefix ?? "PAP"}`;
  const companyRecentTasks = recentTasks.filter(task => task.companyId === selectedCompany?.id);
  const handleRecentScroll = useScrollbarWhileScrolling();
  return (
    <FlyoutAppearanceProvider><TruncatedTextMarqueeProvider><SidebarNavExpandedProvider>
      <div className="design-sidebar">
        <div className="design-sidebar-brand">
          <SidebarCompanyMenu showChevron={false} />
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="design-sidebar-search" aria-label={t("task-components:globalSearch_f72cf4a2")} onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }))}><Search aria-hidden /></Button></TooltipTrigger><TooltipContent side="right">{t("task-components:searchTasksAgentsProjects_59713556")}</TooltipContent></Tooltip>
        </div>
        <nav className="design-sidebar-navigation" aria-label={t("task-components:mainNavigation_eb355944")}>
          <div className="design-sidebar-primary">
            <Button variant="ghost" className="design-sidebar-new-task" onClick={onNewTask}><CirclePlus aria-hidden />New Task</Button>
            <SidebarNavItem className="design-sidebar-item" to={`${root}/dashboard`} label={t("task-components:dashboard_67b69646")} icon={LayoutDashboard} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/chats`} label={t("task-components:chat_460b3a7d")} icon={MessageCircle} />
          </div>
          <SidebarSection label={t("task-components:work_104ab921")}>
            <SidebarNavItem className="design-sidebar-item" to={`${root}/issues`} label={t("task-components:tasks_b3a60e61")} icon={CircleCheck} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/projects`} label={t("task-components:projects_04e2a972")} icon={FolderOpen} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/routines`} label={t("task-components:routines_61b7bb44")} icon={Repeat} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/artifacts`} label={t("task-components:artifacts_314ae71b")} icon={Package} />
          </SidebarSection>
          <SidebarSection label={t("task-components:org_b1ee7e97")}>
            <SidebarNavItem className="design-sidebar-item" to={`${root}/agents`} label={t("task-components:agents_279b44d2")} icon={Users} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/skills`} label={t("task-components:skills_66d0f523")} icon={Boxes} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/apps`} label={t("task-components:connectors_c3d2e79e")} icon={Unplug} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/activity`} label="Audit" icon={History} />
          </SidebarSection>
          {companyRecentTasks.length > 0 ? <div className="design-sidebar-recents">
            <SidebarSection label="Recent Tasks">
              <div onScroll={handleRecentScroll} className="design-sidebar-recent-list scrollbar-while-scrolling" role="region" aria-label={t("task-components:recentTasks_7b940d84")} tabIndex={0}>
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
