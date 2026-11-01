import { cn } from "@/lib/utils";
import type { LabGroup } from "../../kit";
import { Counts } from "./Counts";
import { daySections, type DaySection } from "./gallery-model";
import { GalleryTile } from "./GalleryTile";
import { plural } from "./kinds";
import { META_TEXT } from "./MetaLine";
import { StackTile } from "./StackTile";

/**
 * GALLERY — the company Artifacts page, below its toolbar.
 *
 * The product's grid (1 / 2 / 3 columns at <768 / 768 / 1280px, 24px gutters
 * both ways, inside the page's 1152px column), with the direction's mono
 * count label above it — the line that heads the thread's attachments and the
 * panel's shelf.
 *
 *   stacks   6 stacks · 43 artifacts  ● 12 to review  ● 1 change requested
 *            [stack] [stack] [stack] …
 *
 *   stack    21 artifacts  ● 9 to review
 *
 *            Monday, September 28                         ← a day: the page's one large line
 *            17 artifacts  ● 9 to review
 *            [tile] [tile] [tile] …
 *
 *            Saturday, September 26
 *            2 artifacts
 *            [tile] [tile]
 *
 * (`?days=off`: the same tiles in the product's flat grid, without the days.)
 */

const GRID = "grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3";
const COUNT_LINE = cn(META_TEXT, "px-1 text-muted-foreground");

export function GalleryStacks({ groups }: { groups: LabGroup[] }) {
  if (groups.length === 0) return <p className="px-1 py-16 text-center text-sm font-medium text-foreground">No artifact stacks yet.</p>;
  const all = groups.flatMap((group) => group.artifacts);
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return (
    <div data-solid="gallery-stacks" className="flex flex-col gap-2">
      <p className={COUNT_LINE}>
        <Counts lead={plural(groups.length, "stack")} parts={[plural(total, "artifact")]} of={all} />
      </p>
      {/* Each tile keeps 28px above its face for the pile; the 24px row gap leaves a risen pile clear of the row above. */}
      <ul className={GRID}>
        {groups.map((group) => (
          <li key={group.id} className="min-w-0">
            <StackTile group={group} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Day({ id, section }: { id: string; section: DaySection }) {
  return (
    <section data-solid="gallery-day" aria-labelledby={id} className="flex flex-col gap-4">
      <header className="flex flex-col gap-0.5 px-1">
        <h2 id={id} className="text-lg font-semibold text-foreground">
          {section.label}
        </h2>
        <p className={cn(META_TEXT, "text-muted-foreground")}>
          <Counts lead={plural(section.items.length, "artifact")} of={section.items} />
        </p>
      </header>
      <ul className={GRID}>
        {section.items.map((artifact) => (
          <li key={artifact.id} className="min-w-0">
            <GalleryTile artifact={artifact} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The lab's one switch. Sectioning an opened stack by day is a change of
 * structure riding on a visual direction; `?days=off` lists the stack as the
 * product does today — one flat grid in the page's order — so the tiles can be
 * judged like for like.
 */
const flat = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("days") === "off";

export function GalleryStack({ group }: { group: LabGroup }) {
  if (group.artifacts.length === 0) {
    return <p className="px-1 py-16 text-center text-sm font-medium text-foreground">No artifacts in this stack match the current filters.</p>;
  }
  return (
    <div data-solid="gallery-stack" className="flex flex-col gap-6">
      <p className={COUNT_LINE}>
        <Counts lead={plural(group.count, "artifact")} of={group.artifacts} />
      </p>
      {flat() ? (
        <ul className={GRID}>
          {group.artifacts.map((artifact) => (
            <li key={artifact.id} className="min-w-0">
              <GalleryTile artifact={artifact} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-10">
          {daySections(group.artifacts).map((section) => (
            <Day key={section.id} id={`solid-gallery-day-${group.id}-${section.id}`} section={section} />
          ))}
        </div>
      )}
    </div>
  );
}
