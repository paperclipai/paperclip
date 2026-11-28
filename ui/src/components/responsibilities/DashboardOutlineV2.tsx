import { useCallback, useMemo, useState } from "react";
import type { Agent, ResponsibilityWithRollup } from "@paperclipai/shared";
import { ChevronRight, Plus } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  outlineV2Groups,
  outlineV2Href,
  outlineV2Line,
  outlineV2VisibleGroups,
  readCollapsedAreas,
  writeCollapsedAreas,
  type OutlineV2Group,
  type OutlineV2RoutineFilter,
} from "@/lib/responsibility-outline-v2";
import { activeResponsibilities } from "@/lib/responsibility-views";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { DashboardEditModule } from "./DashboardEditModule";
import { ProposalsNotice } from "./ResponsibilityViewParts";
import type { DashboardViewProps } from "./view-props";

/** Which areas are folded, remembered in the browser; works without storage. */
function useCollapsedAreas(scope: string): [ReadonlySet<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => readCollapsedAreas(scope));
  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsedAreas(next, scope);
      return next;
    });
  }, [scope]);
  return [collapsed, toggle];
}

const MAX_ROUTINE_AVATARS = 4;

/** Slightly overlapping avatars of the agents assigned to a responsibility's routines. */
function RoutineAgentAvatars({
  agentIds,
  agentsById,
  names,
}: {
  agentIds: readonly string[];
  agentsById: ReadonlyMap<string, Agent>;
  names: readonly string[];
}) {
  if (agentIds.length === 0) return null;
  const shown = agentIds.slice(0, MAX_ROUTINE_AVATARS);
  const extra = agentIds.length - shown.length;
  return (
    <span
      className="pointer-events-none flex shrink-0 items-center gap-1"
      role="img"
      aria-label={`Routine agents: ${names.join(", ")}`}
      title={names.join(", ")}
      data-routine-agents={agentIds.join(",")}
    >
      <span className="flex items-center -space-x-1.5" aria-hidden="true">
        {shown.map((id) => {
          const agent = agentsById.get(id);
          return <AgentAvatar key={id} agent={agent ?? { id }} name={agent?.name} size={20} />;
        })}
      </span>
      {extra > 0 ? <span className="text-xs tabular-nums text-muted-foreground" aria-hidden="true">+{extra}</span> : null}
    </span>
  );
}

/** One responsibility: its bar sentence (or its title), opening its page, with routine agent avatars on the right. */
function OutlineV2Row({
  responsibility,
  agentsById,
}: {
  responsibility: ResponsibilityWithRollup;
  agentsById: ReadonlyMap<string, Agent>;
}) {
  const routineAgentIds = responsibility.rollup.routines > 0 ? responsibility.rollup.routineAgentIds : [];
  const routineAgentNames = routineAgentIds.map((id) => agentsById.get(id)?.name ?? "An agent");
  return (
    <li
      data-responsibility-id={responsibility.id}
      className="relative flex items-center justify-between gap-4 py-3 pl-11 pr-5 text-sm text-foreground transition-colors hover:bg-accent/50"
    >
      <Link
        to={outlineV2Href(responsibility.id)}
        title={routineAgentNames.length > 0 ? `Routine agents: ${routineAgentNames.join(", ")}` : undefined}
        className="min-w-0 flex-1 break-words after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
      >
        {outlineV2Line(responsibility)}
      </Link>
      <RoutineAgentAvatars agentIds={routineAgentIds} agentsById={agentsById} names={routineAgentNames} />
    </li>
  );
}

/**
 * One area as a card: its name on a bar that folds and unfolds what is under
 * it, a small "+" to add a responsibility there, and the responsibilities as
 * one line each. An empty area offers its first one instead.
 */
function OutlineV2Area({
  group,
  agentsById,
  expanded,
  onToggle,
  onAdd,
}: {
  group: OutlineV2Group;
  agentsById: ReadonlyMap<string, Agent>;
  expanded: boolean;
  onToggle: () => void;
  onAdd: () => void;
}) {
  const name = group.area?.title ?? "No area";
  const listId = `outline-v2-area-${group.key}`;
  const canAdd = group.area?.status !== "archived";
  return (
    <Card elevation="low" className="gap-0 overflow-hidden py-0" data-outline-v2-area={group.key}>
      <div className="relative flex items-center gap-2 py-3 pl-5 pr-3 transition-colors hover:bg-accent/50">
        <h3 className="min-w-0 flex-1 text-lg font-semibold text-foreground">
          {/* The button's hit area covers the whole bar; the "+" sits above it. */}
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={onToggle}
            className="flex w-full items-center gap-2 text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
            />
            <span className="min-w-0 break-words">{name}</span>
          </button>
        </h3>
        {canAdd ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="relative z-10 text-muted-foreground"
            aria-label={`Add a responsibility to ${name}`}
            onClick={onAdd}
          >
            <Plus aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div id={listId} hidden={!expanded}>
        {group.items.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {group.items.map((item) => (
              <OutlineV2Row key={item.id} responsibility={item} agentsById={agentsById} />
            ))}
          </ul>
        ) : canAdd ? (
          <button
            type="button"
            onClick={onAdd}
            className="block w-full border-t border-border py-3 pl-11 pr-5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            Add a responsibility
          </button>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * "Outline v2": only the areas, each a card whose bar folds it, and under
 * each the responsibilities as the sentence of what must be true. No status,
 * numbers or labels anywhere. Each area's bar has a "+" to add a
 * responsibility; the page's header holds "New area". Below the areas, the edit module:
 * "Edit your dashboard" with an agent, and its saved versions. An empty
 * dashboard shows only the module, offering to create it with an agent.
 *
 * `search` and `routineFilter` narrow the areas to what matches and open every
 * match, whatever was folded; the page owns both controls.
 */
export function DashboardOutlineV2({
  search = "",
  routineFilter = "all",
  visibleGroups,
  onClearFilter,
  companyId,
  overview,
  agentsById,
  keepEmptyAreas,
  onAddResponsibility,
  onAddArea,
  onReviewProposals,
}: DashboardViewProps & {
  search?: string;
  routineFilter?: OutlineV2RoutineFilter;
  /** Pre-filtered visible groups from the page, avoiding a duplicate filter+search pass. */
  visibleGroups?: readonly OutlineV2Group[];
  onClearFilter?: () => void;
}) {
  const active = useMemo(() => activeResponsibilities(overview.responsibilities), [overview.responsibilities]);
  const groups = useMemo(
    () => (visibleGroups ? null : outlineV2Groups(overview.areas, overview.responsibilities, keepEmptyAreas)),
    [visibleGroups, overview.areas, overview.responsibilities, keepEmptyAreas],
  );
  const [collapsed, toggle] = useCollapsedAreas(JSON.stringify([companyId, overview.ownerUserId]));
  const query = search.trim();
  const shown = useMemo(
    () => visibleGroups ?? outlineV2VisibleGroups(groups ?? [], { search: query, routineFilter }),
    [visibleGroups, groups, query, routineFilter],
  );
  const isNarrowed = query !== "" || routineFilter !== "all";
  const hasAnyGroups = visibleGroups
    ? overview.areas.some((area) => area.status === "active" || keepEmptyAreas.has(area.id)) || active.length > 0
    : (groups?.length ?? 0) > 0;

  const renderArea = (group: OutlineV2Group) => (
    <OutlineV2Area
      key={group.key}
      group={group}
      agentsById={agentsById}
      expanded={isNarrowed || !collapsed.has(group.key)}
      onToggle={() => toggle(group.key)}
      onAdd={() => onAddResponsibility(group.area?.id ?? null)}
    />
  );

  // Nothing owned and nothing proposed: only the module, and any area just added by hand.
  if (!hasAnyGroups && active.length === 0 && overview.proposed.length === 0) {
    return (
      <div className="flex flex-col gap-4" data-dashboard-view="outline_v2" data-dashboard-empty="">
        <DashboardEditModule
          companyId={companyId}
          ownerUserId={overview.ownerUserId}
          empty
          agentsById={agentsById}
          onAddArea={onAddArea}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-dashboard-view="outline_v2">
      <ProposalsNotice count={overview.proposed.length} onReview={onReviewProposals} />
      {shown.length > 0 ? (
        shown.map(renderArea)
      ) : query ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" role="status" data-outline-v2-no-match="">
          <span>
            {routineFilter === "all"
              ? `Nothing matches “${query}”.`
              : `Nothing matches “${query}” with this filter.`}
          </span>
          {routineFilter !== "all" && onClearFilter ? (
            <Button type="button" size="xs" variant="ghost" onClick={onClearFilter}>Clear filter</Button>
          ) : null}
        </div>
      ) : routineFilter !== "all" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" role="status" data-outline-v2-no-match="">
          <span>
            {routineFilter === "has_routines"
              ? "None of your responsibilities have routines yet."
              : "Every responsibility has at least one routine."}
          </span>
          {onClearFilter ? (
            <Button type="button" size="xs" variant="ghost" onClick={onClearFilter}>Clear filter</Button>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No areas yet.</p>
      )}
      <DashboardEditModule
        companyId={companyId}
        ownerUserId={overview.ownerUserId}
        empty={false}
        agentsById={agentsById}
        onAddArea={onAddArea}
      />
    </div>
  );
}
