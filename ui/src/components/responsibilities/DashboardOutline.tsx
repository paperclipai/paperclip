import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ResponsibilityWithRollup } from "@paperclipai/shared";
import { Plus } from "lucide-react";
import { authApi } from "@/api/auth";
import { deriveInitials } from "@/components/Identity";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { queryKeys } from "@/lib/queryKeys";
import { RESPONSIBILITY_HEALTH_LABEL, responsibilityPath } from "@/lib/responsibilities";
import {
  activeResponsibilities,
  dashboardSnapshot,
  outlineAreaGroups,
  overallStanding,
  type OutlineAreaGroup,
  type OverallStanding,
  type SnapshotFigure,
} from "@/lib/responsibility-views";
import { Link } from "@/lib/router";
import { userProfilePath } from "@/lib/userProfileLinks";
import { cn } from "@/lib/utils";
import { useDashboardDemoPerson } from "./DashboardPersonaSwitcher";
import { ResponsibilitiesEmpty } from "./ResponsibilitiesEmpty";
import { HealthDot, HealthMark, ProposalsNotice } from "./ResponsibilityViewParts";
import type { DashboardViewProps } from "./view-props";

/**
 * Who is looking: their avatar and name from the signed-in session, opening
 * their profile. In the design exploration's demo organizations, the demo
 * person and role from the organization instead ("Scott", "Chief Product Officer").
 */
export function PersonHeading() {
  const { data: session, isPending } = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const demoPerson = useDashboardDemoPerson();
  const user = session?.user ?? null;
  if (demoPerson) {
    return (
      <div className="flex min-w-0 items-center gap-3" data-demo-person="">
        <Avatar size="lg">
          <AvatarFallback className="text-base">{deriveInitials(demoPerson.name)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-lg font-semibold text-foreground">{demoPerson.name}</span>
          {demoPerson.role ? <span className="truncate text-sm text-muted-foreground">{demoPerson.role}</span> : null}
        </div>
      </div>
    );
  }
  const name = user?.name?.trim() || user?.email?.trim() || "You";
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar size="lg">
        {user?.image ? <AvatarImage src={user.image} alt="" /> : null}
        <AvatarFallback className="text-base">{isPending ? "" : deriveInitials(name)}</AvatarFallback>
      </Avatar>
      {isPending ? (
        <Skeleton className="h-6 w-32" />
      ) : (
        <Link
          to={userProfilePath(user)}
          className="min-w-0 truncate text-lg font-semibold text-foreground underline-offset-4 hover:underline"
        >
          {name}
        </Link>
      )}
    </div>
  );
}

/** The overall status: a dot, its word, and the sentence from the counts. */
function OverallStatusCard({ standing, className }: { standing: OverallStanding; className?: string }) {
  return (
    <Card elevation="low" className={cn("gap-1.5 px-5 py-4", className)} data-overall-status={standing.health}>
      <p className="flex items-center gap-2 text-base font-semibold text-foreground">
        <HealthDot health={standing.health} />
        {RESPONSIBILITY_HEALTH_LABEL[standing.health]}
      </p>
      <p className="text-sm text-muted-foreground">{standing.sentence}</p>
    </Card>
  );
}

function Figure({ label, figure }: { label: string; figure: SnapshotFigure }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-3xl font-semibold tabular-nums text-foreground">{figure.value}</dd>
      <dd className={cn("text-sm", figure.alert ? "text-(--status-task-icon-blocked)" : "text-muted-foreground")}>{figure.line}</dd>
    </div>
  );
}

/** One responsibility as a statement of what must be true, with its title above it and its status at the right. */
function OutlineRow({ responsibility }: { responsibility: ResponsibilityWithRollup }) {
  const standard = responsibility.standard?.trim();
  return (
    <li data-responsibility-id={responsibility.id}>
      <Link
        to={responsibilityPath(responsibility.id)}
        className="flex items-center gap-4 py-3 pl-10 pr-5 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {standard ? (
            <>
              <span className="text-xs text-muted-foreground">{responsibility.title}</span>
              <span className="text-sm text-foreground">{standard}</span>
            </>
          ) : (
            <span className="text-sm text-foreground">{responsibility.title}</span>
          )}
        </span>
        <HealthMark health={responsibility.rollup.health} />
      </Link>
    </li>
  );
}

function OutlineArea({ group, onAddResponsibility }: { group: OutlineAreaGroup; onAddResponsibility: (areaId: string | null) => void }) {
  const headingId = `outline-area-${group.area?.id ?? "none"}`;
  return (
    <div className="flex flex-col gap-1" data-outline-area={group.area?.id ?? "none"}>
      <Card elevation="low" className="gap-0 overflow-hidden py-0" aria-labelledby={headingId}>
        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 id={headingId} className="truncate text-base font-semibold text-foreground">
              {group.area?.title ?? "Not in an area"}
              {group.area?.status === "archived" ? <span className="font-normal text-muted-foreground"> · Archived</span> : null}
            </h3>
            <p className="text-sm text-muted-foreground">{group.ownedLabel}</p>
          </div>
          {group.share ? <p className="shrink-0 text-sm font-medium tabular-nums text-foreground">{group.share.label}</p> : null}
        </div>
        {group.items.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {group.items.map((item) => (
              <OutlineRow key={item.id} responsibility={item} />
            ))}
          </ul>
        ) : (
          <p className="border-t border-border py-3 pl-10 pr-5 text-sm text-muted-foreground">Nothing you own is filed here yet.</p>
        )}
      </Card>
      {group.area?.status === "archived" ? null : (
        <div className="flex justify-end">
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => onAddResponsibility(group.area?.id ?? null)}>
            <Plus aria-hidden="true" />
            New responsibility
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * "Outline": who you are and how things stand overall, four numbers with
 * one exception each, then each area with the responsibilities under it as
 * statements of what must be true. Keeps two actions: a new area and a new
 * responsibility.
 */
export function DashboardOutline({
  companyId,
  overview,
  keepEmptyAreas,
  onAddResponsibility,
  onAddArea,
  onReviewProposals,
}: DashboardViewProps) {
  const active = useMemo(() => activeResponsibilities(overview.responsibilities), [overview.responsibilities]);
  const groups = useMemo(
    () => outlineAreaGroups(overview.areas, overview.responsibilities, keepEmptyAreas),
    [overview.areas, overview.responsibilities, keepEmptyAreas],
  );
  const standing = useMemo(() => overallStanding(overview.totals.byHealth), [overview.totals.byHealth]);
  const snapshot = useMemo(() => dashboardSnapshot(overview), [overview]);

  if (active.length === 0 && overview.proposed.length === 0 && groups.length === 0) {
    return <ResponsibilitiesEmpty companyId={companyId} onAdd={() => onAddResponsibility(null)} />;
  }

  return (
    <div className="flex flex-col gap-10" data-dashboard-view="outline">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <PersonHeading />
        <OverallStatusCard standing={standing} className="md:w-96 md:shrink-0" />
      </div>

      <ProposalsNotice count={overview.proposed.length} onReview={onReviewProposals} />

      <section aria-labelledby="outline-overview-heading" className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 id="outline-overview-heading" className="text-lg font-semibold text-foreground">Overview</h2>
          <p className="text-sm text-muted-foreground">A snapshot of your work</p>
        </div>
        <dl className="grid grid-cols-2 gap-6 md:grid-cols-4">
          <Figure label="Areas" figure={snapshot.areas} />
          <Figure label="Responsibilities" figure={snapshot.responsibilities} />
          <Figure label="Projects" figure={snapshot.projects} />
          <Figure label="Tasks" figure={snapshot.tasks} />
        </dl>
      </section>

      <section aria-labelledby="outline-areas-heading" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h2 id="outline-areas-heading" className="text-lg font-semibold text-foreground">Areas</h2>
            <p className="text-sm text-muted-foreground">What do you care about?</p>
          </div>
          <Button size="sm" onClick={onAddArea}>
            <Plus aria-hidden="true" />
            New area
          </Button>
        </div>
        {groups.length > 0 ? (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <OutlineArea key={group.area?.id ?? "__no_area__"} group={group} onAddResponsibility={onAddResponsibility} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing you own yet. Review what was proposed for you, or add a new responsibility.</p>
        )}
      </section>
    </div>
  );
}
