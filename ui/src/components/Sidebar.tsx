import {
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Boxes,
  Repeat,
  GitBranch,
  Settings,
  MessageSquare,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";

export function Sidebar() {
  const { openNewIssue } = useDialog();
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
  const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarCompanyMenu />
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          onClick={openSearch}
        >
          <Search className="h-4 w-4" />
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
            <span className="truncate">New Issue</span>
          </button>
          <SidebarNavItem
            to="/dashboard"
            label="Dashboard"
            icon={LayoutDashboard}
            liveCount={liveRunCount}
            info="A live overview of what's happening in this company right now: running agents, recent activity, and key metrics on one page."
          />
          <SidebarNavItem
            to="/inbox"
            label="Inbox"
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
            info="Items that need your attention: failed runs, agent questions, mentions, and approvals waiting on you."
          />
          <SidebarNavItem
            to="/clippy"
            label="Clippy"
            icon={MessageSquare}
            info="Talk to Clippy — Paperclip's in-app assistant. Switch to Agent mode to let it run tools and make changes for you."
          />
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
            missingBehavior="placeholder"
          />
        </div>

        <SidebarSection
          label="Work"
          info="Day-to-day work: tasks, schedules, and the goals they ladder up to."
        >
          <SidebarNavItem
            to="/issues"
            label="Issues"
            icon={CircleDot}
            info="Discrete pieces of work with a clear definition of done. Anything an agent or person needs to do — bugs, questions, one-off jobs — lives here."
          />
          <SidebarNavItem
            to="/routines"
            label="Routines"
            icon={Repeat}
            info="Recurring work that runs on a schedule or trigger. Use routines for anything that should happen repeatedly without you asking each time."
          />
          <SidebarNavItem
            to="/goals"
            label="Goals"
            icon={Target}
            info="Higher-level objectives this company is working toward. Goals can have sub-goals and link to the issues that contribute to them."
          />
          {showWorkspacesLink ? (
            <SidebarNavItem
              to="/workspaces"
              label="Workspaces"
              icon={GitBranch}
              info="Isolated environments where agents can work in parallel without stepping on each other's files. (Experimental.)"
            />
          ) : null}
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarSection
          label="Company"
          info="How this company is configured: who works here, what they can do, and what it costs."
        >
          <SidebarNavItem
            to="/org"
            label="Org"
            icon={Network}
            info="Visualise how agents in this company report to each other — who delegates to whom, and where the CEO sits."
          />
          <SidebarNavItem
            to="/skills"
            label="Skills"
            icon={Boxes}
            info="Reusable capabilities agents can call on. Each skill is a packaged tool, instruction, or behaviour that any agent in the company can use."
          />
          <SidebarNavItem
            to="/costs"
            label="Costs"
            icon={DollarSign}
            info="Track LLM and infrastructure spend across agents and runs, so you can see where the money is going."
          />
          <SidebarNavItem
            to="/activity"
            label="Activity"
            icon={History}
            info="An audit trail of everything that's happened in this company: agent runs, status changes, decisions, and errors."
          />
          <SidebarNavItem
            to="/company/settings"
            label="Settings"
            icon={Settings}
            info="Company-level configuration: secrets, integrations, governance rules, and other settings that apply to all agents."
          />
        </SidebarSection>

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>
    </aside>
  );
}
