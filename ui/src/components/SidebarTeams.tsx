import { useMemo, useState } from "react";
import { NavLink } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Users, CircleDot, Hexagon, Settings } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { teamsApi, type Team } from "../api/teams";
import { cn } from "../lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface TeamTreeNode extends Team {
  children: TeamTreeNode[];
}

function buildTeamTree(teams: Team[]): TeamTreeNode[] {
  const map = new Map<string, TeamTreeNode>();
  teams.forEach((t) => map.set(t.id, { ...t, children: [] }));

  const roots: TeamTreeNode[] = [];
  map.forEach((node) => {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

/**
 * Sub-menu under an expanded team — Issues / Projects / Settings.
 * Indent matches the team row so the hierarchy is clear.
 */
function TeamSubMenu({ team, depth }: { team: TeamTreeNode; depth: number }) {
  const subItems = [
    { to: `/teams/${team.id}/issues`, label: "Issues", Icon: CircleDot },
    { to: `/teams/${team.id}/projects`, label: "Projects", Icon: Hexagon },
    { to: `/teams/${team.id}/settings`, label: "Settings", Icon: Settings },
  ];
  return (
    <div className="flex flex-col">
      {subItems.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 py-1 text-[12px] font-medium transition-colors",
              isActive
                ? "bg-accent text-foreground"
                : "text-foreground/70 hover:bg-accent/50 hover:text-foreground",
            )
          }
          // indent: team row padding (12 + depth*14) + avatar column (20) + gap (4)
          style={{ paddingLeft: `${12 + depth * 14 + 24}px` }}
        >
          <Icon className="h-3 w-3 shrink-0" />
          <span className="flex-1 truncate">{label}</span>
        </NavLink>
      ))}
    </div>
  );
}

/**
 * A team with its own sub-menu AND child teams (if any).
 * Clicking the name navigates to /teams/:id (→ issues redirect).
 * The chevron toggles the sub-menu + child list.
 */
function TeamBranch({
  team,
  depth,
  onHoverPrefetch,
}: {
  team: TeamTreeNode;
  depth: number;
  onHoverPrefetch: (teamId: string) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group/branch flex items-center">
        <NavLink
          to={`/teams/${team.id}`}
          end
          onMouseEnter={() => onHoverPrefetch(team.id)}
          className={({ isActive }) =>
            cn(
              "flex-1 flex items-center gap-2.5 pr-1 py-1.5 text-[13px] font-semibold transition-colors min-w-0",
              isActive
                ? "bg-accent text-foreground"
                : "text-foreground/90 hover:bg-accent/50 hover:text-foreground",
            )
          }
          style={{ paddingLeft: `${12 + depth * 14}px` }}
        >
          <span
            className="shrink-0 h-3.5 w-3.5 rounded-sm flex items-center justify-center text-[9px] font-bold text-white"
            style={{ backgroundColor: team.color ?? "#6366f1" }}
          >
            {team.identifier.slice(0, 2)}
          </span>
          <span className="flex-1 truncate">{team.name}</span>
        </NavLink>
        <CollapsibleTrigger
          className="shrink-0 h-6 w-6 mr-2 flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 rounded"
          aria-label={open ? `Collapse ${team.name}` : `Expand ${team.name}`}
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        {/* Team's own Issues/Projects/Settings sub-menu */}
        <TeamSubMenu team={team} depth={depth} />
        {/* Then any child teams, recursive */}
        {team.children.map((child) => (
          <TeamBranch
            key={child.id}
            team={child}
            depth={depth + 1}
            onHoverPrefetch={onHoverPrefetch}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SidebarTeams() {
  const [open, setOpen] = useState(true);
  const { selectedCompanyId } = useCompany();
  const qc = useQueryClient();

  const { data: teams } = useQuery({
    queryKey: ["teams", selectedCompanyId],
    queryFn: () => teamsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const tree = useMemo(() => {
    const visible = (teams ?? []).filter((t) => t.status !== "deleted");
    return buildTeamTree(visible);
  }, [teams]);

  // Prefetch team detail + members + workflow statuses on hover so that
  // clicking the link renders instantly from cache with no flicker.
  const prefetchTeam = (teamId: string) => {
    if (!selectedCompanyId) return;
    qc.prefetchQuery({
      queryKey: ["team", selectedCompanyId, teamId],
      queryFn: () => teamsApi.get(selectedCompanyId, teamId),
      staleTime: 5_000,
    });
  };

  if (!selectedCompanyId) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                open && "rotate-90",
              )}
            />
            <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
              Teams
            </span>
          </CollapsibleTrigger>
          <NavLink
            to="/teams/new"
            className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
            aria-label="New team"
          >
            <Plus className="h-3 w-3" />
          </NavLink>
        </div>
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-0.5 mt-0.5">
          {tree.length === 0 ? (
            <div className="px-3 py-1.5 text-[12px] text-muted-foreground/60 italic flex items-center gap-2">
              <Users className="h-3 w-3" />
              No teams yet
            </div>
          ) : (
            tree.map((team) => (
              <TeamBranch
                key={team.id}
                team={team}
                depth={0}
                onHoverPrefetch={prefetchTeam}
              />
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
