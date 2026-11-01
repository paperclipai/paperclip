import type { ReactNode } from "react";
import {
  Boxes,
  ChevronsUpDown,
  CircleCheck,
  FolderOpen,
  GitBranch,
  History,
  Inbox,
  LayoutDashboard,
  LifeBuoy,
  Package,
  Repeat,
  Search,
  SquarePen,
  Unplug,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { COMPANY, TASKS } from "../fixtures";

/**
 * Static mock of the streamlined app shell (Layout.tsx:618-795): the primary
 * sidebar and the main column. Class strings are the product's, cited inline.
 *
 * One deliberate difference: the real shell is `h-dvh` with an internally
 * scrolling `<main>`. Here the shell is at least 900px and grows with its
 * content, so a full-page capture shows everything.
 */

export type ShellNav = "tasks" | "artifacts";

interface NavEntry {
  label: string;
  icon: LucideIcon;
  nav?: ShellNav;
}

const TOP: NavEntry[] = [
  { label: "New Task", icon: SquarePen },
  { label: "Search", icon: Search },
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Inbox", icon: Inbox },
];
const WORK: NavEntry[] = [
  { label: "Tasks", icon: CircleCheck, nav: "tasks" },
  { label: "Projects", icon: FolderOpen },
  { label: "Routines", icon: Repeat },
  { label: "Artifacts", icon: Package, nav: "artifacts" },
  { label: "Workspaces", icon: GitBranch },
];
const ORG: NavEntry[] = [
  { label: "Agents", icon: Users },
  { label: "Skills", icon: Boxes },
  { label: "Connectors", icon: Unplug },
  { label: "Audit", icon: History },
];
const RECENT = [TASKS["ACM-1"], TASKS["ACM-3"], TASKS["ACM-2"]];

// SidebarNavItem.tsx:129-133
function NavItem({ label, icon: Icon, active }: { label: string; icon?: LucideIcon; active?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80",
      )}
    >
      {Icon ? (
        <span className="relative shrink-0">
          <Icon className="h-4 w-4" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </span>
  );
}

// SidebarSection.tsx:77,155-156
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="px-3 py-1.5">
        <div className="relative flex min-h-6 min-w-0 items-center gap-1">
          <div className="inline-flex min-w-0 max-w-full items-center px-1 py-0.5">
            <span className="text-(length:--text-nano) font-medium uppercase tracking-widest font-mono text-muted-foreground/60">{label}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-0.5 mt-0.5">{children}</div>
    </div>
  );
}

function Sidebar({ nav }: { nav: ShellNav }) {
  return (
    // SidebarShell.tsx:15 (240px), Sidebar.tsx:128 — no right border; the edge is the surface change.
    <aside className="flex w-60 shrink-0 flex-col primary-sidebar-surface" aria-label="Primary">
      {/* Sidebar.tsx:142 + SidebarCompanyMenu.tsx:268-291 */}
      <div className="flex h-(--sz-60px) shrink-0 items-center gap-1 px-3">
        <span className="flex h-9 min-w-0 flex-1 items-center justify-start gap-2 rounded-md px-4 text-left">
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className="flex size-5 shrink-0 items-center justify-center rounded-md text-(length:--text-micro) font-semibold text-white"
              style={{ background: "var(--status-task-done)" }}
            >
              A
            </span>
            <span className="min-w-0 truncate text-sm font-bold text-foreground">{COMPANY.name}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </span>
      </div>
      {/* primary-sidebar-styles.ts */}
      <nav className="flex min-h-0 flex-1 flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {TOP.map((entry) => (
            <NavItem key={entry.label} {...entry} />
          ))}
        </div>
        <Section label="Work">
          {WORK.map((entry) => (
            <NavItem key={entry.label} {...entry} active={entry.nav === nav} />
          ))}
        </Section>
        <Section label="Org">
          {ORG.map((entry) => (
            <NavItem key={entry.label} {...entry} />
          ))}
        </Section>
        <Section label="Recent Tasks">
          {RECENT.map((title) => (
            <NavItem key={title} label={title} />
          ))}
        </Section>
      </nav>
      {/* SidebarAccountMenu.tsx:172-188 */}
      <div className="bg-border/50 px-3 py-2 dark:bg-muted">
        <div className="flex items-center gap-0.5 px-2">
          <span className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-(length:--text-compact) font-medium text-foreground/80">
            <Avatar size="sm">
              <AvatarFallback>TO</AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate">tonio+canary62@paperclip.example</span>
          </span>
        </div>
      </div>
    </aside>
  );
}

/**
 * The Support button is injected by a cloud plugin through the
 * `globalToolbarButton` slot (BreadcrumbBar.tsx:43); drawn here from the
 * screenshots as a ghost button.
 */
export function SupportButton() {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
      <span className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground">
        <LifeBuoy className="size-4" />
        Support
      </span>
    </span>
  );
}

export function AppShell({ nav, children }: { nav: ShellNav; children: ReactNode }) {
  return (
    // Layout.tsx:621-638, with min-height in place of h-dvh (see above).
    <div className="bg-background text-foreground flex min-h-225 flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar nav={nav} />
        {/* Layout.tsx:700 */}
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}
