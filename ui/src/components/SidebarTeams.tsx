import { useMemo, useState } from "react";
import { NavLink, useNavigate, useLocation } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import {
  ChevronRight,
  Plus,
  Users,
  CircleDot,
  Hexagon,
  Settings,
  MoreHorizontal,
  Link as LinkIcon,
  Archive,
  FileText,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { teamsApi, type Team } from "../api/teams";
import { cn } from "../lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
 * Sub-menu under an expanded team — Issues / Projects only.
 * Settings moved to the "..." context menu (Linear pattern).
 * Indent matches the team row so the hierarchy is clear.
 *
 * `activeIssueTeamId` is the teamId of the currently-open issue detail
 * page (if any). When the user navigates to /issues/:id, the sidebar
 * highlights the matching team's Issues sub-item so the team context
 * stays visible.
 */
function TeamSubMenu({
  team,
  depth,
  activeIssueTeamId,
}: {
  team: TeamTreeNode;
  depth: number;
  activeIssueTeamId: string | null;
}) {
  const subItems = [
    {
      to: `/teams/${team.id}/issues`,
      label: "Issues",
      Icon: CircleDot,
      forceActive: activeIssueTeamId === team.id,
    },
    { to: `/teams/${team.id}/projects`, label: "Projects", Icon: Hexagon, forceActive: false },
    { to: `/teams/${team.id}/docs`, label: "Docs", Icon: FileText, forceActive: false },
  ];
  return (
    <div className="flex flex-col">
      {subItems.map(({ to, label, Icon, forceActive }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 py-1 text-[12px] font-medium transition-colors",
              isActive || forceActive
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
 * "..." context menu for a team row — Linear pattern.
 * Shown on hover at the right edge of the team row.
 */
function TeamMoreMenu({ team }: { team: TeamTreeNode }) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/teams/${team.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label={`More options for ${team.name}`}
          className="shrink-0 h-6 w-6 mr-2 flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 rounded opacity-0 group-hover/branch:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={() => navigate(`/teams/${team.id}/settings`)}>
          <Settings className="h-4 w-4 mr-2" />
          Team settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCopyLink}>
          <LinkIcon className="h-4 w-4 mr-2" />
          {copied ? "Copied!" : "Copy link"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <Archive className="h-4 w-4 mr-2" />
          Open archive
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  activeIssueTeamId,
}: {
  team: TeamTreeNode;
  depth: number;
  onHoverPrefetch: (teamId: string) => void;
  activeIssueTeamId: string | null;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group/branch flex items-center pr-0">
        <NavLink
          to={`/teams/${team.id}`}
          end
          onMouseEnter={() => onHoverPrefetch(team.id)}
          className={({ isActive }) =>
            cn(
              "flex-1 flex items-center gap-2 pr-1 py-1.5 text-[13px] font-semibold transition-colors min-w-0",
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
          {/* Chevron sits inside the NavLink right next to the name, Linear style.
              stopPropagation so clicking the chevron toggles without navigating. */}
          <CollapsibleTrigger asChild>
            <span
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpen(!open);
              }}
              className="shrink-0 inline-flex items-center justify-center h-4 w-4 text-muted-foreground/60 hover:text-foreground rounded"
              aria-label={open ? `Collapse ${team.name}` : `Expand ${team.name}`}
              role="button"
            >
              <ChevronRight
                className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
              />
            </span>
          </CollapsibleTrigger>
        </NavLink>
        <TeamMoreMenu team={team} />
      </div>
      <CollapsibleContent>
        {/* Team's own Issues/Projects sub-menu */}
        <TeamSubMenu team={team} depth={depth} activeIssueTeamId={activeIssueTeamId} />
        {/* Then any child teams, recursive */}
        {team.children.map((child) => (
          <TeamBranch
            key={child.id}
            team={child}
            depth={depth + 1}
            onHoverPrefetch={onHoverPrefetch}
            activeIssueTeamId={activeIssueTeamId}
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
  const location = useLocation();

  const { data: teams } = useQuery({
    queryKey: ["teams", selectedCompanyId],
    queryFn: () => teamsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // If the current URL is an issue detail page (/BBR/issues/ENG2-3 or
  // /BBR/issues/<uuid>), fetch the issue to learn its teamId so we can
  // highlight the matching team's Issues sub-menu. That gives the user
  // a clear "you're inside Engine2's issues" context even though the
  // URL itself is the global /issues route.
  const issueIdFromUrl = useMemo(() => {
    const m = location.pathname.match(/\/issues\/([^/?#]+)/);
    if (!m) return null;
    // Skip the team-scoped issues list path /teams/:id/issues
    if (location.pathname.includes("/teams/")) return null;
    return m[1];
  }, [location.pathname]);

  const { data: activeIssue } = useQuery({
    queryKey: ["sidebar-active-issue-team", selectedCompanyId, issueIdFromUrl],
    queryFn: () => issuesApi.get(issueIdFromUrl!),
    enabled: !!selectedCompanyId && !!issueIdFromUrl,
    staleTime: 30_000,
  });
  const activeIssueTeamId = (activeIssue as any)?.teamId ?? null;

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
                activeIssueTeamId={activeIssueTeamId}
              />
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
