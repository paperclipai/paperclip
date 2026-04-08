import { useMemo, useState } from "react";
import { NavLink } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, Users } from "lucide-react";
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

function TeamItem({ team, depth = 0 }: { team: TeamTreeNode; depth?: number }) {
  return (
    <>
      <NavLink
        to={`/teams/${team.id}`}
        className={({ isActive }) =>
          cn(
            "flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
            isActive
              ? "bg-accent text-foreground"
              : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
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
      {team.children.map((child) => (
        <TeamItem key={child.id} team={child} depth={depth + 1} />
      ))}
    </>
  );
}

export function SidebarTeams() {
  const [open, setOpen] = useState(true);
  const { selectedCompanyId } = useCompany();

  const { data: teams } = useQuery({
    queryKey: ["teams", selectedCompanyId],
    queryFn: () => teamsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const tree = useMemo(() => {
    const visible = (teams ?? []).filter((t) => t.status !== "deleted");
    return buildTeamTree(visible);
  }, [teams]);

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
            tree.map((team) => <TeamItem key={team.id} team={team} />)
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
