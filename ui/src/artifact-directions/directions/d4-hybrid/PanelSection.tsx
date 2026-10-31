import { useId } from "react";
import { MetaLine } from "./MetaLine";
import { PanelCard } from "./PanelCard";
import { ReviewTally } from "./StateMark";
import { shortDateTime } from "./kinds";
import type { PanelSection as Section } from "./panel-model";

/**
 * PANEL — one section of the shelf: a producing run (agent + run start), or
 * the task's documents. The heading is type on the pane, not a card: the
 * agent in the sans, the machine line under it in the mono token, and — when
 * the section holds something waiting — the review tally at the right end,
 * using the same ring the cards' state marks use.
 *
 * The machine line wraps between its parts in a narrow pane (the run's start
 * is what tells two same-day runs apart, so it is never cut).
 */
export function PanelSection({ section }: { section: Section }) {
  const count = section.artifacts.length;
  const headingId = useId();
  // A run's start keeps its year (the product prints it); the cards under it drop theirs while it is the current one.
  const when = section.run ? `Run ${section.run.startedLabel}` : `Latest ${shortDateTime(section.latest.updatedLabel, section.latest.updatedAt)}`;
  return (
    <section data-section={section.run ? "run" : "documents"} aria-labelledby={headingId} className="flex flex-col gap-2">
      <header className="flex min-w-0 items-start gap-3 px-1">
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="wrap-anywhere text-xs font-medium leading-4 text-foreground">
            {section.title}
          </h3>
          <MetaLine wrap parts={[when, `${count} ${count === 1 ? "artifact" : "artifacts"}`]} />
        </div>
        <ReviewTally count={section.reviewCount} className="mt-2" />
      </header>
      {/* One column in the docked pane; two and three when the pane is maximized (the product keeps one, stretched). Sixteen between cards: double Tint's. Each card at its own height: a PDF beside a tall picture does not stretch to match it. */}
      <ul className="grid grid-cols-1 items-start gap-4 @3xl/panel:grid-cols-2 @6xl/panel:grid-cols-3">
        {section.artifacts.map((artifact) => (
          <PanelCard key={artifact.id} artifact={artifact} />
        ))}
      </ul>
    </section>
  );
}
