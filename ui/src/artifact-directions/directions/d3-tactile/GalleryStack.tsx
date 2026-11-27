import type { LabGroup } from "../../kit";
import { countLabel, daysOf, reviewCountOf } from "./gallery-model";
import { GalleryItem } from "./GalleryItem";
import { KindTally } from "./KindTally";
import { Folder } from "./objects/Folder";
import { StateFlag } from "./StateFlag";

/**
 * GALLERY — an opened stack: the folder's contents taken out and stood up by
 * day.
 *
 * First the folder itself — the same one as on the shelf, now open and
 * empty, its tab still the task identifier and its "Review · N" flag still
 * on the pocket's edge — with the task's title as the page's heading beside
 * it, then the count, the date and the tally by kind. Then the artifacts by
 * the day they were last edited, newest day first: each day under a heading
 * with its count and a tick ruler down the left margin, on a mat in the
 * ground tone, the objects in rows on ledges with their captions under
 * (`GalleryItem`). No tiles: the paper is the tile, the mat is the ground
 * every surface shares.
 */

function Summary({ group }: { group: LabGroup }) {
  const review = reviewCountOf(group.artifacts);
  return (
    <header className="flex items-end gap-5">
      {/* A little room each side: the open front is wider at its top than the board behind it. */}
      <span className="block w-52 shrink-0 px-2">
        <Folder
          size="hero"
          open
          tab={<span className="truncate pl-3 font-mono text-(length:--text-micro) font-medium tracking-wide text-(--tac-folder-ink)">{group.taskIdentifier}</span>}
          flag={review > 0 ? <StateFlag review="needs_review" count={review} /> : null}
        />
      </span>
      <div className="flex min-w-0 flex-col gap-1.5 pb-1.5">
        <h2 className="line-clamp-2 wrap-anywhere text-xl font-semibold leading-7 text-foreground" title={group.title}>
          {group.title}
        </h2>
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm text-(--tac-meta)">
          <span className="font-medium text-foreground">
            <span className="font-mono text-(length:--tac-mono-scale)">{group.count}</span> {countLabel(group.count)}
          </span>
          <span>
            Updated <span className="font-mono text-(length:--tac-mono-scale)">{group.updatedLabel}</span>
          </span>
          {review > 0 ? <span className="sr-only">{review} to review</span> : null}
        </p>
        <KindTally artifacts={group.artifacts} className="flex flex-wrap items-baseline gap-y-0.5 text-xs leading-4 text-(--tac-meta)" />
      </div>
    </header>
  );
}

export function GalleryStack({ group }: { group: LabGroup }) {
  const days = daysOf(group.artifacts);
  if (group.artifacts.length === 0) return <p className="py-16 text-center text-sm font-medium text-foreground">No artifacts in this stack match the current filters.</p>;
  return (
    <div className="flex flex-col gap-7 pt-1">
      <Summary group={group} />
      {days.map((day) => (
        // `day` is the container a day's objects measure themselves against (tokens-gallery.css).
        <section key={day.day} aria-label={`${day.label}, ${day.items.length} ${countLabel(day.items.length)}`} className="@container/day relative flex flex-col gap-3.5 pl-(--tac-ruler-gutter)">
          {/* The ruler: a long tick at the day, short ones down its rows. */}
          <span aria-hidden className="absolute bottom-0 left-0 top-2.5 block w-(--tac-ruler-w) bg-(image:--tac-ruler)" />
          <span aria-hidden className="absolute left-0 top-2.5 block h-px w-(--tac-ruler-major) bg-(--tac-rule-strong)" />
          <h3 className="flex items-baseline gap-2.5 text-sm font-semibold leading-5 text-foreground">
            {day.label}
            <span className="text-xs font-normal text-(--tac-meta)">
              <span className="font-mono text-(length:--tac-mono-scale)">{day.items.length}</span> {countLabel(day.items.length)}
            </span>
          </h3>
          {/* The mat. It clips on the x axis: each item's ledge runs out to its edges. */}
          <ul
            data-tac-mat
            className="grid grid-cols-(--tac-gl-cols) gap-x-(--tac-mat-gap) gap-y-6 overflow-x-clip rounded-xl bg-(--tac-ground) bg-(image:--tac-ground-grain) px-(--tac-mat-pad) pb-4 pt-7 shadow-(--tac-tray-rim)"
          >
            {day.items.map((artifact) => (
              <GalleryItem key={artifact.id} artifact={artifact} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
