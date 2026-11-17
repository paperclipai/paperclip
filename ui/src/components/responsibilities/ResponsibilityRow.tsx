import { memo } from "react";
import type { Agent, ResponsibilityArea, ResponsibilityWithRollup } from "@paperclipai/shared";
import { MoreHorizontal } from "lucide-react";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "@/lib/router";
import { agentIdsFromSignals, responsibilityPath, topWorkSignals } from "@/lib/responsibilities";
import { cn } from "@/lib/utils";
import { MetricGlance } from "./MetricGlance";
import { AreaRadioItems, useMoveToArea } from "./MoveToArea";
import { ResponsibilityHealthBadge } from "./ResponsibilityHealthBadge";
import { AgentsWorkingLabel } from "./AgentsWorking";
import { WorkSignalList } from "./WorkSignalList";

type AreaRef = Pick<ResponsibilityArea, "id" | "title" | "status">;

export interface ResponsibilityRowProps {
  responsibility: ResponsibilityWithRollup;
  agentsById: ReadonlyMap<string, Agent>;
  areas: readonly AreaRef[];
  now: Date;
}

/**
 * One responsibility on the home page: its name and status, the status
 * sentence, the most important signals from the work under it, the number
 * against its target, and the agents working under it. Memoized on the responsibility object
 * (structurally shared by the query), so a refetch re-renders only rows that changed.
 */
export const ResponsibilityRow = memo(function ResponsibilityRow({
  responsibility,
  agentsById,
  areas,
  now,
}: ResponsibilityRowProps) {
  const { rollup } = responsibility;
  const letGo = responsibility.status === "let_go";
  const signals = topWorkSignals(rollup);
  const move = useMoveToArea(responsibility.id);
  return (
    <li
      data-responsibility-id={responsibility.id}
      className={cn("flex flex-col gap-3 px-5 py-4 md:flex-row md:items-start md:gap-6", letGo && "opacity-70")}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={responsibilityPath(responsibility.id)}
            className="min-w-0 text-sm font-semibold text-foreground underline-offset-4 hover:underline"
          >
            {responsibility.title}
          </Link>
          <ResponsibilityHealthBadge health={rollup.health} overridden={rollup.healthOverridden} />
          {letGo ? <span className="text-xs text-muted-foreground">Let go</span> : null}
        </div>
        <p className="text-sm text-muted-foreground">{rollup.statusSentence}</p>
        {signals.length > 0 ? (
          <WorkSignalList signals={signals} size="xs" responsibilityHref={responsibilityPath} className="pt-1" />
        ) : null}
        {move.error ? (
          <p role="alert" className="text-xs text-destructive">Couldn’t move it. {describeError(move.error).body}</p>
        ) : null}
      </div>
      <MetricGlance metric={rollup.metric} health={rollup.health} now={now} className="md:w-48 md:shrink-0" />
      <div className="flex items-center justify-between gap-2 md:w-48 md:shrink-0 md:justify-end">
        <AgentsWorkingLabel agentIds={agentIdsFromSignals(rollup)} agentsById={agentsById} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label={`More for ${responsibility.title}`}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={move.isPending}>Move to area</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-(--sz-50vh) overflow-y-auto">
                <AreaRadioItems
                  areas={areas}
                  value={responsibility.areaId}
                  onChange={(areaId) => {
                    if (areaId !== responsibility.areaId) move.mutate(areaId);
                  }}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
});
