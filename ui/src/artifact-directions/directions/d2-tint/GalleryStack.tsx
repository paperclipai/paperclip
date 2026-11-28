import { useId } from "react";
import type { LabGroup } from "../../kit";
import { GalleryTile } from "./GalleryTile";
import { KindTally } from "./KindTally";
import { MetaLine } from "./MetaLine";
import { ReviewTally } from "./StateMark";
import { artifactCount, stackSections, type StackSection } from "./gallery-model";
import { countReview } from "./panel-model";

/**
 * GALLERY — one opened stack: everything below the "← All stacks" row.
 *
 *   caption   what the folder's pocket said, as one line of type on the
 *             page: the kinds spelled out with their mini glyphs, how much
 *             is waiting, the count and the updated date. A caption, not a
 *             control — it has no fill, so it cannot be mistaken for a second
 *             row of the page's own filter tabs right above it.
 *   sections  the artifacts by the day of their last edit, newest first; a
 *             day that cannot fill a row shares its heading with its quiet
 *             neighbours (gallery-model.ts), so headings do not strand tiles
 *   tiles     GalleryTile.tsx, three to a row on the page's grid
 */

function Caption({ group }: { group: LabGroup }) {
  return (
    <div data-stack-caption className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 px-1">
      <KindTally artifacts={group.artifacts} named />
      <ReviewTally count={countReview(group.artifacts)} />
      <MetaLine wrap parts={[artifactCount(group.count), `Updated ${group.updatedLabel}`]} className="ml-auto" />
    </div>
  );
}

function Section({ section }: { section: StackSection }) {
  const headingId = useId();
  return (
    <section data-section={section.spansDays ? "days" : "day"} aria-labelledby={headingId} className="flex flex-col gap-3">
      <header className="flex min-w-0 items-baseline gap-2.5 px-1">
        <h3 id={headingId} className="truncate text-sm font-medium leading-5 text-foreground">
          {section.label}
        </h3>
        <span className="shrink-0 font-mono text-(length:--text-micro) leading-5 text-(--tint-ink-2)">{artifactCount(section.artifacts.length)}</span>
      </header>
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {section.artifacts.map((artifact) => (
          <GalleryTile key={artifact.id} artifact={artifact} dated={section.spansDays} />
        ))}
      </ul>
    </section>
  );
}

export function GalleryStack({ group }: { group: LabGroup }) {
  if (group.artifacts.length === 0) {
    // The shipped empty state's copy.
    return <p className="py-16 text-center text-sm font-medium text-foreground">No artifacts in this stack match the current filters.</p>;
  }
  return (
    <div data-surface="gallery-stack" className="flex flex-col gap-6">
      <Caption group={group} />
      {stackSections(group.artifacts).map((section) => (
        <Section key={section.id} section={section} />
      ))}
    </div>
  );
}
