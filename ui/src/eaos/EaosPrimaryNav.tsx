import { NavLink } from "@/lib/router";
import { EAOS_PRIMARY_NAV_ZONES, type EaosNavZone } from "./nav-zones";

// LET-503 (LET-502 contract §2) — single-level, single-noun rail. No
// section headers, no dashed "Stub" count pills, no icons. Counts appear
// later only when backed by a live read (e.g. Approvals badge); the rail
// itself stays calm so the active item is the visual focus.

export interface EaosPrimaryNavProps {
  // Mobile/tablet drawer state. When true, the nav renders inside a slide-in
  // panel with focus visible. Desktop layouts ignore this flag.
  drawerOpen: boolean;
  onClose: () => void;
}

function NavItem({ zone, end }: { zone: EaosNavZone; end?: boolean }) {
  return (
    <li>
      <NavLink
        to={zone.path}
        end={end}
        title={zone.description}
        className={({ isActive }) =>
          "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
          (isActive
            ? "bg-accent text-foreground font-medium"
            : "text-muted-foreground hover:bg-accent hover:text-foreground")
        }
        data-testid={`eaos-primary-nav-link-${zone.id}`}
      >
        <span
          data-testid={`eaos-primary-nav-label-${zone.id}`}
          className="flex-1 truncate"
        >
          {zone.label}
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
        "absolute inset-y-0 left-0 z-20 transition-transform duration-150 ease-out md:static md:inset-auto md:translate-x-0 " +
        (drawerOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0")
      }
    >
      <div className="flex h-full min-h-0 flex-col overflow-y-auto py-3">
        <ul
          className="flex flex-col gap-0.5 px-2"
          aria-label="Primary navigation"
          data-testid="eaos-primary-nav-group-primary"
        >
          {EAOS_PRIMARY_NAV_ZONES.map((zone) => (
            <NavItem key={zone.id} zone={zone} end={zone.path === "/eaos"} />
          ))}
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
