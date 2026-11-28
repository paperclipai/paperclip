import { memo, useMemo } from "react";
import type { ResponsibilityHealth, ResponsibilityWithRollup } from "@paperclipai/shared";
import { Clock } from "lucide-react";
import {
  RESPONSIBILITY_HEALTH_LABEL,
  RESPONSIBILITY_HEALTH_ORDER,
  RESPONSIBILITY_HEALTH_TEXT_VAR,
  responsibilityPath,
} from "@/lib/responsibilities";
import {
  activeResponsibilities,
  boardAreaRows,
  describeReadingValue,
  describeTargetPhrase,
  explainResponsibilityStatus,
  type BoardAreaRow,
  type ExplanationLine,
} from "@/lib/responsibility-views";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { BoardAreaHeader, BoardAreaSection, BoardGrid } from "./BoardLayout";
import { ResponsibilitiesEmpty } from "./ResponsibilitiesEmpty";
import { healthStatusStyle } from "./ResponsibilityHealthBadge";
import { ResponsibilityStandingSummary } from "./ResponsibilityMeasures";
import { NarrativeParagraph, useDashboardNarrative } from "./ResponsibilityNarrative";
import { HEALTH_ICON, ProposalsNotice } from "./ResponsibilityViewParts";
import type { DashboardViewProps } from "./view-props";

const LINE_TEXT: Record<ExplanationLine["role"], string> = {
  holding: "text-foreground",
  keeping: "text-foreground",
  note: "text-muted-foreground",
};

/** A dot before each reason: the status hue of what it says (holding back, keeping on track, or a note). */
function LineMark({ role }: { role: ExplanationLine["role"] }) {
  const health: ResponsibilityHealth = role === "holding" ? "behind" : role === "keeping" ? "on_track" : "not_measured";
  return <span aria-hidden="true" className="status-fill mt-1.5 size-1.5 shrink-0 rounded-full" style={healthStatusStyle(health)} />;
}

/**
 * One responsibility as a card of one fixed height: its name, its bar, the
 * number against its target with the metric named, how far it is from the
 * target, and what in the work holds it back (or keeps it on track). Every
 * line is clamped at a word, with the full text as a tooltip, so a card
 * never grows. The column says the status; the card says it to screen
 * readers and keeps the status tint.
 */
const BoardCard = memo(function BoardCard({ responsibility }: { responsibility: ResponsibilityWithRollup }) {
  const { health, metric } = responsibility.rollup;
  const value = metric ? describeReadingValue(metric) : null;
  const why = useMemo(() => explainResponsibilityStatus(responsibility), [responsibility]);
  const standard = responsibility.standard?.trim();
  const gapLine = why.gap ?? why.missing;
  const target = metric ? describeTargetPhrase(metric) : null;
  const metricLine = metric ? (target ? `${target} · ${metric.name}` : metric.name) : "Nothing measured";
  return (
    <li className="min-w-0" data-responsibility-id={responsibility.id} data-health={health}>
      <Link
        to={responsibilityPath(responsibility.id)}
        className="status-chip flex h-(--responsibility-board-card-h) flex-col overflow-hidden rounded-lg border px-3 py-3 transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={healthStatusStyle(health)}
      >
        <span className="sr-only">{RESPONSIBILITY_HEALTH_LABEL[health]}: </span>
        <span className="line-clamp-2 text-sm font-medium text-foreground" title={responsibility.title}>
          {responsibility.title}
        </span>
        <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" title={standard || undefined}>
          {standard || "No bar yet."}
        </span>

        <span className="mt-2.5 flex min-w-0 items-center gap-1.5 tabular-nums" data-board-reading="">
          <span className={cn("whitespace-nowrap text-lg font-semibold", value ? "text-foreground" : "text-muted-foreground")}>
            {value ?? (metric ? "No reading" : "No number")}
          </span>
          {metric?.stale ? (
            <span className="text-(--status-task-icon-todo)" title="Not updated recently">
              <Clock aria-hidden="true" className="size-3.5" />
              <span className="sr-only">, not updated recently</span>
            </span>
          ) : null}
        </span>
        <span className="line-clamp-1 text-xs text-muted-foreground" title={metricLine}>
          {metricLine}
        </span>

        {gapLine ? (
          <span className="mt-1 line-clamp-2 text-xs font-medium text-foreground" title={gapLine} data-board-gap="">
            {gapLine}
          </span>
        ) : null}

        {why.lines.length > 0 ? (
          <span className="mt-2 flex min-h-0 flex-col gap-1" data-board-why="">
            {why.lines.map((line) => (
              <span key={`${line.kind}:${line.text}`} className="flex min-w-0 items-start gap-1.5" data-why-role={line.role}>
                <LineMark role={line.role} />
                <span className={cn("line-clamp-2 text-xs", LINE_TEXT[line.role])} title={line.text}>
                  {line.text}
                </span>
              </span>
            ))}
            {why.more > 0 ? <span className="pl-3 text-xs text-muted-foreground">and {why.more} more</span> : null}
          </span>
        ) : null}
      </Link>
    </li>
  );
});

/** A status's icon, name and count: the column header on wide boards, a group label on narrow ones. */
function StatusLabel({ health, count, className }: { health: ResponsibilityHealth; count: number; className?: string }) {
  const Icon = HEALTH_ICON[health];
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground", className)}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" style={{ color: `var(${RESPONSIBILITY_HEALTH_TEXT_VAR[health]})` }} />
      <span className="truncate">{RESPONSIBILITY_HEALTH_LABEL[health]}</span>
      <span className="font-normal tabular-nums text-muted-foreground">{count}</span>
    </span>
  );
}

/** One area: its name, how many you own in it and the share on track, then its cards in the status columns. */
function AreaRow({ row }: { row: BoardAreaRow }) {
  const headingId = `board-area-${row.area?.id ?? "none"}`;
  return (
    <BoardAreaSection
      headingId={headingId}
      areaKey={row.area?.id ?? "none"}
      header={
        <BoardAreaHeader
          headingId={headingId}
          title={row.area?.title ?? "Not in an area"}
          archived={row.area?.status === "archived"}
          ownedLabel={row.ownedLabel}
          shareLabel={row.share?.label ?? null}
        />
      }
      columns={RESPONSIBILITY_HEALTH_ORDER}
      cells={row.byHealth}
      renderLabel={(health, count, className) => <StatusLabel health={health} count={count} className={className} />}
      renderCard={(item) => <BoardCard key={item.id} responsibility={item} />}
    />
  );
}

/**
 * "Board": where things stand (the four counts, then a written summary),
 * then the areas as rows and the four statuses as columns in the order of
 * those counts, each responsibility a card of one size saying why it has its
 * status. Narrow boards keep the grouping as labelled groups per area.
 */
export function DashboardBoard({ companyId, overview, onAddResponsibility, onReviewProposals }: DashboardViewProps) {
  const active = useMemo(() => activeResponsibilities(overview.responsibilities), [overview.responsibilities]);
  const rows = useMemo(() => boardAreaRows(overview.areas, overview.responsibilities), [overview.areas, overview.responsibilities]);
  const narrative = useDashboardNarrative(companyId);
  const counts = overview.totals.byHealth;

  if (active.length === 0 && overview.proposed.length === 0) {
    return <ResponsibilitiesEmpty companyId={companyId} onAdd={() => onAddResponsibility(null)} />;
  }

  return (
    <div className="@container flex flex-col gap-6" data-dashboard-view="board">
      <ProposalsNotice count={overview.proposed.length} onReview={onReviewProposals} />
      <ResponsibilityStandingSummary counts={counts}>
        <NarrativeParagraph summary={narrative.summary} stillWaiting={narrative.stillWaiting} className="border-t border-border pt-3" />
      </ResponsibilityStandingSummary>
      {rows.length > 0 ? (
        <BoardGrid
          headers={RESPONSIBILITY_HEALTH_ORDER.map((health) => (
            <StatusLabel key={health} health={health} count={counts[health]} />
          ))}
        >
          {rows.map((row) => (
            <AreaRow key={row.area?.id ?? "__no_area__"} row={row} />
          ))}
        </BoardGrid>
      ) : null}
    </div>
  );
}
