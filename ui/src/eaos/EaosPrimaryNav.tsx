import { NavLink } from "@/lib/router";
import {
  AlertOctagon,
  BookOpen,
  Compass,
  Cpu,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  Package,
  ScrollText,
  Server,
  ShieldCheck,
  Target,
  type LucideIcon,
} from "lucide-react";
import {
  EAOS_KERNEL_NAV,
  EAOS_PRIMARY_NAV_ZONES,
  EAOS_SECONDARY_NAV_ZONES,
  type EaosNavZone,
} from "./nav-zones";
import { STUB_COUNT_NOTE, STUB_COUNT_PLACEHOLDER } from "./state-labels";

// LET-484 — icon glyph per zone gives the sidebar a dense command-center
// aesthetic without changing the zone IDs or labels. Counts stay marked as
// Stub here per the LET-187 semantic-trust rule; backend-backed counts live
// on the Command Center landing.
const ZONE_ICONS: Record<string, LucideIcon> = {
  "command-center": LayoutDashboard,
  missions: Target,
  "agents-teams": Cpu,
  "approvals-risk": ShieldCheck,
  "knowledge-playbooks": BookOpen,
  "projects-goals": Compass,
  "runs-observability": GitBranch,
  "capabilities-mcp": Package,
  "sandbox-runtime": Server,
  "admin-security": AlertOctagon,
  "kernel-admin": KeyRound,
};

const FALLBACK_ICON: LucideIcon = ScrollText;

export interface EaosPrimaryNavProps {
  // Mobile/tablet drawer state. When true, the nav renders inside a slide-in
  // panel with focus visible. Desktop layouts ignore this flag.
  drawerOpen: boolean;
  onClose: () => void;
}

function NavItem({ zone, end }: { zone: EaosNavZone; end?: boolean }) {
  const Icon = ZONE_ICONS[zone.id] ?? FALLBACK_ICON;
  return (
    <li>
      <NavLink
        to={zone.path}
        end={end}
        title={zone.description}
        className={({ isActive }) =>
          "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
          (isActive
            ? "bg-accent text-foreground font-medium"
            : "text-muted-foreground hover:bg-accent hover:text-foreground")
        }
        data-testid={`eaos-primary-nav-link-${zone.id}`}
      >
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span data-testid={`eaos-primary-nav-label-${zone.id}`} className="flex-1 truncate">
          {zone.label}
        </span>
        <span
          aria-label={`${zone.label} count (${STUB_COUNT_NOTE})`}
          title={STUB_COUNT_NOTE}
          data-eaos-nav-count-stub="true"
          className="rounded-full border border-dashed border-border bg-card px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {STUB_COUNT_PLACEHOLDER}
        </span>
      </NavLink>
    </li>
  );
}

export function EaosPrimaryNav({ drawerOpen, onClose }: EaosPrimaryNavProps) {
  return (
    <nav
      role="navigation"
      aria-label="Primary"
      data-testid="eaos-primary-nav"
      data-drawer-open={drawerOpen ? "true" : "false"}
      className={
        "w-60 shrink-0 border-r border-border bg-sidebar text-sidebar-foreground " +
        // Desktop: persistent sidebar. Mobile: off-canvas drawer toggled via
        // the top-bar hamburger button. Nav lives inside the EAOS section
        // (which itself sits inside the kernel Layout's main), so the drawer
        // is absolutely positioned within the section — not fixed to the
        // viewport.
        "absolute inset-y-0 left-0 z-20 transition-transform duration-150 ease-out md:static md:inset-auto md:translate-x-0 " +
        (drawerOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0")
      }
    >
      <div className="flex h-full flex-col overflow-y-auto py-3">
        <div className="px-3 pb-1.5" aria-hidden="true">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Operator
          </div>
        </div>
        <ul
          className="flex flex-col gap-0.5 px-2"
          aria-label="Operator navigation"
          data-testid="eaos-primary-nav-group-primary"
        >
          {EAOS_PRIMARY_NAV_ZONES.map((zone) => (
            <NavItem key={zone.id} zone={zone} end={zone.path === "/eaos"} />
          ))}
        </ul>
        <div className="px-3 pb-1.5 pt-4" aria-hidden="true">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Build / Admin
          </div>
        </div>
        <ul
          className="flex flex-col gap-0.5 px-2"
          aria-label="Build and admin navigation"
          data-testid="eaos-primary-nav-group-secondary"
        >
          {EAOS_SECONDARY_NAV_ZONES.map((zone) => (
            <NavItem key={zone.id} zone={zone} />
          ))}
        </ul>
        <hr aria-hidden="true" className="my-3 border-border" />
        <div className="px-3 pb-1.5" aria-hidden="true">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Escape hatch
          </div>
        </div>
        <ul className="flex flex-col gap-0.5 px-2" aria-label="Kernel and admin">
          <NavItem zone={EAOS_KERNEL_NAV} />
        </ul>
        <button
          type="button"
          onClick={onClose}
          className="mt-auto block px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background md:hidden"
          data-testid="eaos-primary-nav-close"
        >
          Close menu
        </button>
      </div>
    </nav>
  );
}
