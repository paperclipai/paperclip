import { useCallback } from "react";
import { NavLink } from "@/lib/router";
import { Plus, Search } from "lucide-react";
import { useDialogActions } from "@/context/DialogContext";
import {
  EAOS_NAV_GROUPS,
  EAOS_OPERATOR_ONLY_ZONE_IDS,
  EAOS_PRIMARY_NAV_ZONES,
  type EaosNavGroup,
  type EaosNavZone,
} from "./nav-zones";
import { useEaosViewerRole } from "./useEaosViewerRole";

// LET-506 (Multica adaptation, round-1) — the EAOS rail now mirrors the
// Multica three-group sidebar: a header with prominent Search + New
// mission triggers (replacing Multica's "New issue" affordance), a
// label-less personal section (Dashboard), then "Workspace" and
// "Configure" groups. Visuals stay Paperclip-native — no Multica source,
// brand mark, or copyright is introduced. The single-noun labels and the
// operator-gated Admin entry from LET-502/LET-503 are preserved.

export interface EaosPrimaryNavProps {
  // Mobile/tablet drawer state. When true, the nav renders inside a slide-in
  // panel with focus visible. Desktop layouts ignore this flag.
  drawerOpen: boolean;
  onClose: () => void;
}

// LET-513 §4 — operator gating is now data-driven via the `operatorOnly`
// flag on each EaosNavZone (`nav-zones.ts`). The rail filters against the
// set exposed here; `RequireOperator` in App.tsx uses the same source so
// direct-URL access also fails closed.

function openCommandPalette() {
  if (typeof window === "undefined") return;
  const event = new KeyboardEvent("keydown", {
    key: "k",
    ctrlKey: true,
    metaKey: true,
    bubbles: true,
  });
  document.dispatchEvent(event);
}

function NavItem({ zone, end }: { zone: EaosNavZone; end?: boolean }) {
  const Icon = zone.icon;
  return (
    <li>
      <NavLink
        to={zone.path}
        end={end}
        title={zone.description}
        className={({ isActive }) =>
          "group/eaos-nav flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
          (isActive
            ? "bg-accent text-foreground font-medium"
            : "text-muted-foreground hover:bg-accent hover:text-foreground")
        }
        data-testid={`eaos-primary-nav-link-${zone.id}`}
      >
        <Icon
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted-foreground/80 group-[.active]/eaos-nav:text-foreground"
        />
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

function NavGroup({
  group,
  label,
  zones,
}: {
  group: EaosNavGroup;
  label: string | null;
  zones: readonly EaosNavZone[];
}) {
  if (zones.length === 0) return null;
  return (
    <div
      className="flex flex-col"
      data-testid={`eaos-primary-nav-group-${group}`}
      data-eaos-nav-group={group}
    >
      {label ? (
        <h2
          id={`eaos-primary-nav-group-${group}-label`}
          className="px-2 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70"
        >
          {label}
        </h2>
      ) : null}
      <ul
        className="flex flex-col gap-0.5 px-2"
        aria-labelledby={label ? `eaos-primary-nav-group-${group}-label` : undefined}
        aria-label={label ? undefined : "Primary navigation"}
      >
        {zones.map((zone) => (
          <NavItem key={zone.id} zone={zone} end={zone.path === "/eaos"} />
        ))}
      </ul>
    </div>
  );
}

export function EaosPrimaryNav({ drawerOpen, onClose }: EaosPrimaryNavProps) {
  const { isOperator } = useEaosViewerRole();
  const { openNewIssue } = useDialogActions();

  const visibleZones = EAOS_PRIMARY_NAV_ZONES.filter(
    (zone) => !EAOS_OPERATOR_ONLY_ZONE_IDS.has(zone.id) || isOperator,
  );

  const openNewMission = useCallback(() => {
    // Mirrors Multica's sidebar "New issue" trigger. The dialog itself is
    // mounted by EaosProductLayout so the surface is reachable from
    // anywhere under /eaos.
    openNewIssue();
  }, [openNewIssue]);

  return (
    <nav
      role="navigation"
      aria-label="Primary"
      data-testid="eaos-primary-nav"
      data-drawer-open={drawerOpen ? "true" : "false"}
      data-viewer-role={isOperator ? "operator" : "customer"}
      className={
        "w-60 shrink-0 border-r border-border bg-sidebar text-sidebar-foreground " +
        "absolute inset-y-0 left-0 z-20 transition-transform duration-150 ease-out md:static md:inset-auto md:translate-x-0 " +
        (drawerOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0")
      }
    >
      <div className="flex h-full min-h-0 flex-col overflow-y-auto pb-3">
        <div
          className="flex flex-col gap-1 border-b border-border/60 px-2 pb-3 pt-3"
          data-testid="eaos-primary-nav-header"
        >
          <button
            type="button"
            onClick={openCommandPalette}
            data-testid="eaos-primary-nav-search"
            className="flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2 text-xs text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="Search (Ctrl/Cmd + K)"
          >
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1 text-left">Search</span>
            <kbd
              aria-hidden="true"
              className="ml-auto rounded border border-border bg-background px-1 font-mono text-[10px] text-muted-foreground"
            >
              ⌘K
            </kbd>
          </button>
          <button
            type="button"
            onClick={openNewMission}
            data-testid="eaos-primary-nav-new-mission"
            className="flex h-8 items-center gap-2 rounded-md border border-transparent px-2 text-[13px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="New mission"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1 text-left">New mission</span>
            <kbd
              aria-hidden="true"
              className="ml-auto rounded border border-border bg-background px-1 font-mono text-[10px] text-muted-foreground"
            >
              C
            </kbd>
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-1 pt-1">
          {EAOS_NAV_GROUPS.map((group) => (
            <NavGroup
              key={group.id}
              group={group.id}
              label={group.label}
              zones={visibleZones.filter((zone) => zone.group === group.id)}
            />
          ))}
        </div>

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
