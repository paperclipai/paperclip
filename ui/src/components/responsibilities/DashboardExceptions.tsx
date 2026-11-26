import { Fragment, useMemo } from "react";
import type { ResponsibilityArea } from "@paperclipai/shared";
import { Card } from "@/components/ui/card";
import { RESPONSIBILITY_HEALTH_LABEL, responsibilityPath } from "@/lib/responsibilities";
import {
  activeResponsibilities,
  overallStanding,
  responsibilityExceptions,
  type ResponsibilityException,
} from "@/lib/responsibility-views";
import { Link } from "@/lib/router";
import { ResponsibilitiesEmpty } from "./ResponsibilitiesEmpty";
import { ResponsibilityHealthBadge } from "./ResponsibilityHealthBadge";
import { HealthDot, ProposalsNotice } from "./ResponsibilityViewParts";
import type { DashboardViewProps } from "./view-props";
import { WorkSignalList } from "./WorkSignalList";

function ExceptionRow({ entry, areaTitle }: { entry: ResponsibilityException; areaTitle: string | null }) {
  const { responsibility, signal } = entry;
  return (
    <li className="flex flex-col gap-1 px-5 py-3.5" data-responsibility-id={responsibility.id} data-reason={entry.reason}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link
          to={responsibilityPath(responsibility.id)}
          className="text-sm font-semibold text-foreground underline-offset-4 hover:underline"
        >
          {responsibility.title}
        </Link>
        <ResponsibilityHealthBadge health={responsibility.rollup.health} overridden={responsibility.rollup.healthOverridden} />
        {areaTitle ? <span className="text-xs text-muted-foreground">{areaTitle}</span> : null}
      </div>
      <p className="text-sm text-muted-foreground">{responsibility.rollup.statusSentence}</p>
      {signal ? <WorkSignalList signals={[signal]} size="xs" responsibilityHref={responsibilityPath} className="pt-0.5" /> : null}
    </li>
  );
}

/**
 * "Exceptions": only what is wrong. One overall sentence, then the
 * responsibilities that are behind, at risk, on a stale number or not
 * measured, each with its status sentence and its most important attention
 * signal. What is on track collapses to one line per area.
 */
export function DashboardExceptions({ companyId, overview, onAddResponsibility, onReviewProposals }: DashboardViewProps) {
  const activeCount = useMemo(() => activeResponsibilities(overview.responsibilities).length, [overview.responsibilities]);
  const standing = useMemo(() => overallStanding(overview.totals.byHealth), [overview.totals.byHealth]);
  const { exceptions, onTrack } = useMemo(
    () => responsibilityExceptions(overview.areas, overview.responsibilities),
    [overview.areas, overview.responsibilities],
  );
  const areaTitles = useMemo(
    () => new Map(overview.areas.map((area: Pick<ResponsibilityArea, "id" | "title">) => [area.id, area.title])),
    [overview.areas],
  );

  if (activeCount === 0 && overview.proposed.length === 0) {
    return <ResponsibilitiesEmpty companyId={companyId} onAdd={() => onAddResponsibility(null)} />;
  }

  return (
    <div className="flex flex-col gap-6" data-dashboard-view="exceptions">
      <p className="flex items-start gap-2.5 text-lg font-medium text-foreground" data-overall-status={standing.health}>
        <HealthDot health={standing.health} label={`${RESPONSIBILITY_HEALTH_LABEL[standing.health]}:`} className="mt-2.5" />
        <span>{standing.sentence}</span>
      </p>

      <ProposalsNotice count={overview.proposed.length} onReview={onReviewProposals} />

      {exceptions.length > 0 ? (
        <section aria-labelledby="exceptions-needs-a-look-heading" className="flex flex-col gap-2">
          <h2 id="exceptions-needs-a-look-heading" className="text-sm font-semibold text-foreground">
            Needs a look <span className="font-normal tabular-nums text-muted-foreground">{exceptions.length}</span>
          </h2>
          <Card elevation="low" className="gap-0 py-0">
            <ul className="flex flex-col divide-y divide-border">
              {exceptions.map((entry) => (
                <ExceptionRow
                  key={entry.responsibility.id}
                  entry={entry}
                  areaTitle={entry.responsibility.areaId ? areaTitles.get(entry.responsibility.areaId) ?? null : null}
                />
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {onTrack.length > 0 ? (
        <section aria-labelledby="exceptions-on-track-heading" className="flex flex-col gap-2">
          <h2 id="exceptions-on-track-heading" className="sr-only">On track</h2>
          <ul className="flex flex-col gap-1.5">
            {onTrack.map((line) => (
              <li key={line.areaId ?? "__no_area__"} className="flex items-start gap-2 text-sm" data-on-track-area={line.areaId ?? "none"}>
                <HealthDot health="on_track" className="mt-1.5 size-2" />
                <span className="min-w-0">
                  <span className="text-foreground">{line.label}</span>
                  {line.responsibilities.length > 0 ? (
                    <span className="text-muted-foreground">
                      {" · "}
                      {line.responsibilities.map((item, index) => (
                        <Fragment key={item.id}>
                          {index > 0 ? ", " : null}
                          <Link to={responsibilityPath(item.id)} className="underline-offset-4 hover:text-foreground hover:underline">
                            {item.title}
                          </Link>
                        </Fragment>
                      ))}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
