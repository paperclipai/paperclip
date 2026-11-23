import { useCallback, useMemo, useState } from "react";
import type { ResponsibilityWithRollup } from "@paperclipai/shared";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  outlineV2Groups,
  outlineV2Href,
  outlineV2Line,
  readCollapsedAreas,
  searchOutlineV2Groups,
  writeCollapsedAreas,
  type OutlineV2Group,
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

/** One responsibility: its bar sentence (or its title), opening its page. */
function OutlineV2Row({ responsibility }: { responsibility: ResponsibilityWithRollup }) {
  return (
    <li data-responsibility-id={responsibility.id}>
      <Link
        to={outlineV2Href(responsibility.id)}
        className="block break-words py-3 pl-11 pr-5 text-sm text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {outlineV2Line(responsibility)}
      </Link>
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
  expanded,
  onToggle,
  onAdd,
}: {
  group: OutlineV2Group;
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
              <OutlineV2Row key={item.id} responsibility={item} />
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
 * `search` narrows the areas to what matches and opens every match, whatever
 * was folded; the page owns the field, which sits where its headline was.
 */
export function DashboardOutlineV2({
  search = "",
  companyId,
  overview,
  agentsById,
  keepEmptyAreas,
  onAddResponsibility,
  onAddArea,
  onReviewProposals,
}: DashboardViewProps & { search?: string }) {
  const active = useMemo(() => activeResponsibilities(overview.responsibilities), [overview.responsibilities]);
  const groups = useMemo(
    () => outlineV2Groups(overview.areas, overview.responsibilities, keepEmptyAreas),
    [overview.areas, overview.responsibilities, keepEmptyAreas],
  );
  const [collapsed, toggle] = useCollapsedAreas(JSON.stringify([companyId, overview.ownerUserId]));
  const query = search.trim();
  const shown = useMemo(() => searchOutlineV2Groups(groups, query), [groups, query]);

  const renderArea = (group: OutlineV2Group) => (
    <OutlineV2Area
      key={group.key}
      group={group}
      expanded={query !== "" || !collapsed.has(group.key)}
      onToggle={() => toggle(group.key)}
      onAdd={() => onAddResponsibility(group.area?.id ?? null)}
    />
  );

  // Nothing owned and nothing proposed: only the module, and any area just added by hand.
  if (groups.length === 0 && active.length === 0 && overview.proposed.length === 0) {
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
        <p className="text-sm text-muted-foreground" role="status" data-outline-v2-no-match="">
          Nothing matches “{query}”.
        </p>
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
