import { useMemo, useState } from "react";
import type { Agent, ResponsibilityHealth, ResponsibilityOverview, ResponsibilityWithRollup } from "@paperclipai/shared";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  groupByArea,
  otherActiveAreas,
  RESPONSIBILITY_HEALTH_LABEL,
  sortByStatus,
  type AttentionItem,
} from "@/lib/responsibilities";
import { AreaHeading, NeedsYouSection, OtherAreas, RunningWithoutYouSection, type AreaActions } from "./HomeSections";
import { LooseWorkSection } from "./LooseWorkSection";
import { ProposedResponsibilitiesReview } from "./ProposedResponsibilitiesReview";
import { ResponsibilitiesEmpty } from "./ResponsibilitiesEmpty";
import { AgentPoweredSummary, ResponsibilityStandingSummary } from "./ResponsibilityMeasures";
import { ResponsibilityRow } from "./ResponsibilityRow";

/**
 * Everything the home layout needs: the loaded overview and agents, and the
 * page's actions. The page owns loading, mutations and dialogs, so another
 * layout can take the same props.
 */
export interface ResponsibilitiesHomeLayoutProps {
  companyId: string;
  overview: ResponsibilityOverview;
  agents: readonly Agent[];
  agentsById: ReadonlyMap<string, Agent>;
  /** One clock per visit, for day-level judgements. */
  now: Date;
  includeLetGo: boolean;
  onToggleLetGo: () => void;
  /** Areas added in this visit: shown even before anything is filed under them. */
  keepEmptyAreas: ReadonlySet<string>;
  onAddResponsibility: (areaId: string | null) => void;
  /** Open "New task for an agent" under a responsibility, prefilled from a reason. */
  onNewTask: (responsibility: ResponsibilityWithRollup, item: AttentionItem) => void;
  areaActions: AreaActions;
}

/**
 * The home layout: proposals to review; "What you own" with where things
 * stand, then what needs the person, then the area groups; what runs without
 * them; and the work outside any responsibility.
 */
export function ResponsibilitiesHomeLayout({
  companyId,
  overview,
  agents,
  agentsById,
  now,
  includeLetGo,
  onToggleLetGo,
  keepEmptyAreas,
  onAddResponsibility,
  onNewTask,
  areaActions,
}: ResponsibilitiesHomeLayoutProps) {
  const [healthFilter, setHealthFilter] = useState<ResponsibilityHealth | null>(null);

  const owned = overview.responsibilities;
  const active = useMemo(() => owned.filter((item) => item.status === "active"), [owned]);
  const sorted = useMemo(() => sortByStatus(owned), [owned]);
  const filtered = useMemo(
    () => (healthFilter ? sorted.filter((item) => item.rollup.health === healthFilter) : sorted),
    [sorted, healthFilter],
  );
  const groups = useMemo(
    () => groupByArea(overview.areas, filtered, healthFilter ? new Set() : keepEmptyAreas),
    [overview.areas, filtered, healthFilter, keepEmptyAreas],
  );
  const shownAreaIds = useMemo(
    () => new Set(groups.map((group) => group.area?.id).filter((id): id is string => !!id)),
    [groups],
  );
  const otherAreas = useMemo(() => otherActiveAreas(overview.areas, owned, shownAreaIds), [overview.areas, owned, shownAreaIds]);
  const movableAreas = useMemo(() => overview.areas.filter((area) => area.status !== "archived"), [overview.areas]);

  const loose = (
    <LooseWorkSection
      companyId={companyId}
      loose={overview.loose}
      responsibilities={active}
      areas={overview.areas}
      agents={agents}
      now={now}
    />
  );

  if (owned.length === 0 && overview.proposed.length === 0) {
    return (
      <>
        <ResponsibilitiesEmpty companyId={companyId} onAdd={() => onAddResponsibility(null)} />
        {loose}
      </>
    );
  }

  const hasLetGo = owned.some((item) => item.status === "let_go");

  return (
    <>
      <ProposedResponsibilitiesReview
        companyId={companyId}
        proposed={overview.proposed}
        areas={overview.areas}
        ownerUserId={overview.ownerUserId}
      />

      {owned.length > 0 ? (
        <>
          <section aria-labelledby="responsibilities-owned-heading" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div className="flex flex-col gap-1">
                <h2 id="responsibilities-owned-heading" className="text-base font-semibold text-foreground">
                  What you own
                </h2>
                <p className="text-sm text-muted-foreground">Is each one meeting its bar?</p>
              </div>
              <Button size="sm" variant="ghost" onClick={onToggleLetGo} aria-pressed={includeLetGo}>
                {includeLetGo ? "Hide let-go responsibilities" : "Show let-go responsibilities"}
              </Button>
            </div>
            <ResponsibilityStandingSummary counts={overview.totals.byHealth} selected={healthFilter} onSelect={setHealthFilter} />
            <NeedsYouSection companyId={companyId} responsibilities={active} agents={agents} onNewTask={onNewTask} />
            {healthFilter ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>Showing only {RESPONSIBILITY_HEALTH_LABEL[healthFilter].toLowerCase()}.</span>
                <Button size="xs" variant="ghost" onClick={() => setHealthFilter(null)}>Show all</Button>
              </div>
            ) : null}
            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {healthFilter
                  ? `None of your responsibilities are ${RESPONSIBILITY_HEALTH_LABEL[healthFilter].toLowerCase()}.`
                  : "Nothing to show."}
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.area?.id ?? "__no_area__"} className="flex flex-col gap-2" data-area-group={group.area?.id ?? "none"}>
                  <AreaHeading area={group.area} count={group.items.length} actions={areaActions} />
                  <Card elevation="low" className="gap-0 py-0">
                    {group.items.length > 0 ? (
                      <ul className="flex flex-col divide-y divide-border">
                        {group.items.map((item) => (
                          <ResponsibilityRow key={item.id} responsibility={item} agentsById={agentsById} areas={movableAreas} now={now} />
                        ))}
                      </ul>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
                        <p className="text-sm text-muted-foreground">Nothing you own is filed here yet.</p>
                        {group.area ? (
                          <Button size="sm" variant="ghost" onClick={() => onAddResponsibility(group.area!.id)}>
                            <Plus aria-hidden="true" />
                            Add a responsibility here
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </Card>
                </div>
              ))
            )}
            {includeLetGo && !hasLetGo ? (
              <p className="text-xs text-muted-foreground">You have not let go of any responsibilities.</p>
            ) : null}
            {healthFilter ? null : <OtherAreas areas={otherAreas} actions={areaActions} />}
          </section>

          <RunningWithoutYouSection
            responsibilities={active}
            agentsById={agentsById}
            summary={
              <AgentPoweredSummary
                agentTasks={overview.totals.agentTasks}
                userTasks={overview.totals.userTasks}
                openTasks={overview.totals.openTasks}
              />
            }
          />
        </>
      ) : null}

      {loose}
    </>
  );
}
