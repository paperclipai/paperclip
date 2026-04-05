import {
  BookOpen,
  Bot,
  Boxes,
  CheckCircle,
  ChevronDown,
  CircleDot,
  DollarSign,
  FolderOpen,
  History,
  Inbox,
  LayoutDashboard,
  Repeat,
  Settings,
  Target,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useLocation } from "@/lib/router";
import { Link } from "@/lib/router";
import { useCompany } from "../../context/CompanyContext";
import { heartbeatsApi } from "../../api/heartbeats";
import { queryKeys } from "../../lib/queryKeys";
import { useInboxBadge } from "../../hooks/useInboxBadge";
import { cn } from "../../lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SidebarGroup } from "./SidebarGroup";
import { CompanySwitcher } from "./CompanySwitcher";
import type { HealthStatus } from "../../api/health";
import type { LucideIcon } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

interface AppSidebarProps {
  /** Health data passed from AppShell — used for version tooltip */
  health?: HealthStatus;
  /** The remembered instance-settings path (e.g. "/instance/settings/general") */
  instanceSettingsTarget?: string;
  /** Called when the sidebar should close (mobile nav) */
  onNavigate?: () => void;
  /** Custom handler for opening the company switcher UI */
  onCompanySwitcherOpen?: () => void;
}

// ── Nav Item ───────────────────────────────────────────────────────────────

interface NavItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Numeric badge (e.g. unread count) */
  badge?: number;
  badgeTone?: "default" | "danger";
  /** Small text pill (e.g. "Beta") */
  textBadge?: string;
  /** Pulsing live-run indicator with count */
  liveCount?: number;
  /** Red dot alert indicator on the icon */
  alert?: boolean;
}

function NavItem({
  to,
  label,
  icon: Icon,
  end,
  badge,
  badgeTone = "default",
  textBadge,
  liveCount,
  alert = false,
}: NavItemProps) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium rounded-xl transition-colors",
          isActive
            ? "bg-gradient-to-r from-accent/15 to-accent/5 border border-accent/10 text-accent font-semibold glow-accent"
            : "text-foreground/40 hover:bg-default/40 hover:text-foreground/70 transition-colors",
        )
      }
    >
      {/* Icon wrapper with optional alert dot */}
      <span className="relative shrink-0">
        <Icon className="h-4 w-4" />
        {alert && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-danger shadow-[0_0_0_2px_hsl(var(--background))]" />
        )}
      </span>

      {/* Label */}
      <span className="flex-1 truncate">{label}</span>

      {/* Text badge (e.g. "Beta") */}
      {textBadge && (
        <span className="ml-auto rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium leading-none text-warning-600 dark:text-warning-400">
          {textBadge}
        </span>
      )}

      {/* Live run indicator */}
      {liveCount != null && liveCount > 0 && (
        <span className="ml-auto flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-primary/60 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          <span className="text-[11px] font-medium text-primary">{liveCount} live</span>
        </span>
      )}

      {/* Numeric badge */}
      {badge != null && badge > 0 && (
        <span
          className={cn(
            "ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
            badgeTone === "danger"
              ? "bg-gradient-to-r from-danger to-red-500 text-white shadow-sm shadow-danger/30 glow-danger"
              : "bg-accent/20 text-accent",
          )}
        >
          {badge}
        </span>
      )}
    </NavLink>
  );
}

// ── Company header button ──────────────────────────────────────────────────

function CompanyHeader({
  brandColor,
  name,
  onOpen,
}: {
  brandColor?: string | null;
  name: string;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="sidebar-header flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-default/50"
    >
      {/* Company avatar */}
      <span
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white shadow-md shadow-accent/20"
        style={{ background: brandColor ? brandColor : 'linear-gradient(135deg, var(--color-accent), var(--color-accent))' }}
      >
        {name.slice(0, 1).toUpperCase()}
      </span>

      <span className="flex-1 truncate text-[13px] font-semibold text-foreground">
        {name}
      </span>

      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground/40" />
    </button>
  );
}

// ── Search trigger ─────────────────────────────────────────────────────────

function SearchTrigger() {
  function openSearch() {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
  }

  return (
    <button
      onClick={openSearch}
      className="mx-3 flex items-center gap-2 rounded-xl border border-default-200/60 bg-default/30 px-3 py-2 text-[12px] text-foreground/40 transition-colors hover:bg-default/60 hover:text-foreground/60"
    >
      <span className="flex-1 text-left">Search...</span>
      <kbd className="rounded-md border border-default-200/50 bg-background px-1.5 py-0.5 text-[10px] font-mono text-foreground/25">
        ⌘K
      </kbd>
    </button>
  );
}

// ── User footer ────────────────────────────────────────────────────────────

function UserFooter({
  userName,
  settingsTarget,
  version,
}: {
  userName: string;
  settingsTarget: string;
  version?: string;
}) {
  const location = useLocation();
  const isSettings = location.pathname.startsWith("/instance/settings");

  return (
    <div className="flex flex-col gap-1 border-t border-default-200/40 px-3 pt-3 pb-2">
      {/* User row */}
      <div className="flex items-center gap-2.5 px-1 py-1">
        {/* User avatar */}
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-default-200 text-[11px] font-semibold text-default-600">
          {userName.slice(0, 1).toUpperCase()}
        </span>
        <span className="flex-1 truncate text-[13px] font-medium text-foreground/70">
          {userName}
        </span>
        {version && (
          <span className="text-[10px] font-mono text-foreground/25 shrink-0" title={`Version ${version}`}>
            v{version}
          </span>
        )}
      </div>

      {/* Footer links */}
      <div className="flex items-center gap-0.5">
        <a
          href="https://docs.paperclipai.com"
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-foreground/40 transition-colors hover:bg-default/50 hover:text-foreground"
          aria-label="Documentation"
        >
          <BookOpen className="h-4 w-4" />
        </a>
        <Link
          to={settingsTarget}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-default/50 hover:text-foreground",
            isSettings ? "text-primary" : "text-foreground/40",
          )}
          aria-label="Settings"
        >
          <Settings className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}

// ── AppSidebar ─────────────────────────────────────────────────────────────

export function AppSidebar({
  health,
  instanceSettingsTarget = "/instance/settings/general",
  onNavigate: _onNavigate,
  onCompanySwitcherOpen,
}: AppSidebarProps) {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const inboxBadge = useInboxBadge(selectedCompanyId);

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  // Placeholder user name until auth context is wired in
  const userName = "Me";

  function handleCompanySwitcherOpen() {
    if (onCompanySwitcherOpen) {
      onCompanySwitcherOpen();
    } else {
      document.dispatchEvent(new CustomEvent("paperclip:open-company-switcher"));
    }
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col overflow-hidden border-r border-default-200/40 bg-content1/60 backdrop-blur-md">
      {/* ── Header ── */}
      <div className="flex flex-col gap-2 px-2 pb-2 pt-3">
        <CompanySwitcher />
        <SearchTrigger />
      </div>

      {/* ── Nav ── */}
      <nav className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-2 scrollbar-hide">
        {/* Overview — no collapse */}
        <SidebarGroup label="Overview" collapsible={false}>
          <NavItem
            to="/dashboard"
            label="Dashboard"
            icon={LayoutDashboard}
            liveCount={liveRunCount}
          />
          <NavItem to="/activity" label="Activity" icon={History} />
          <NavItem
            to="/inbox"
            label="Inbox"
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
        </SidebarGroup>

        {/* Work */}
        <SidebarGroup label="Work">
          <NavItem to="/issues" label="Issues" icon={CircleDot} />
          <NavItem to="/projects" label="Projects" icon={FolderOpen} />
          <NavItem to="/goals" label="Goals" icon={Target} />
        </SidebarGroup>

        {/* Team */}
        <SidebarGroup label="Team">
          <NavItem
            to="/agents"
            label="Agents"
            icon={Bot}
            liveCount={liveRunCount > 0 ? liveRunCount : undefined}
          />
          <NavItem to="/skills" label="Skills" icon={Boxes} />
        </SidebarGroup>

        {/* Operations */}
        <SidebarGroup label="Operations">
          <NavItem to="/approvals" label="Approvals" icon={CheckCircle} />
          <NavItem to="/costs" label="Costs" icon={DollarSign} />
          <NavItem
            to="/routines"
            label="Routines"
            icon={Repeat}
            textBadge="Beta"
          />
          <NavItem to="/artifacts" label="Artifacts" icon={FolderOpen} />
        </SidebarGroup>

        {/* Plugin slots */}
        <PluginSlotOutlet
          slotTypes={["sidebar"]}
          context={pluginContext}
          className="flex flex-col gap-0.5"
          itemClassName="text-[13px] font-medium"
          missingBehavior="placeholder"
        />

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-2xl border border-default-200 p-3"
          missingBehavior="placeholder"
        />
      </nav>

      {/* ── Footer ── */}
      <UserFooter
        userName={userName}
        settingsTarget={instanceSettingsTarget}
        version={health?.version}
      />
    </aside>
  );
}
