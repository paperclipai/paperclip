import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A folder: a group of artifacts as the thing that holds them.
 *
 *   back board   a step darker than the front, standing behind everything
 *   pile         separate blank sheet tops behind the contents, staggered and
 *                each with its own edge, when the folder holds more than it
 *                shows: one, two, or four for a full one (whose mouth is also
 *                in deeper shade)
 *   contents     whatever the caller tucks in; it stands in front of the board
 *                and goes down behind the pocket. Above the pocket's mouth it
 *                may lean out over the folder's sides; below it, it is cut to
 *                the pocket's walls
 *   pocket       the front: a label tab on its top-left with a curved
 *                shoulder (the same tab the panel's dividers have), then the
 *                body, which carries type; a flag stands on its top edge
 *
 * Graphite in the dark theme so the paper in it stays the brightest thing;
 * manila in the light theme. One shadow follows the whole silhouette,
 * contents included, and widens while an ancestor carrying `group/object` is
 * hovered or focused.
 *
 * Sizes come from `data-tac-folder` (tokens-folder.css): `shelf` fills its
 * grid cell; `hero` is the opened stack's own folder. `open` lets the front
 * fall toward the reader, as a folder lies once its contents are out.
 */

export type FolderSize = "shelf" | "hero";

const SHADOW =
  "filter-(--tac-fol-shadow) transition-(--tac-tp-fan) duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) group-hover/object:filter-(--tac-fol-shadow-lift) group-focus-visible/object:filter-(--tac-fol-shadow-lift)";

/** Blank sheet tops standing behind the contents: there is more in here than is shown. */
const PILE = [
  "left-1/20 w-2/5 h-(--tac-pile-a-h) rotate-(--tac-pile-a-tilt)",
  "left-11/20 w-9/25 h-(--tac-pile-b-h) rotate-(--tac-pile-b-tilt)",
  "left-3/10 w-2/5 h-(--tac-pile-c-h) rotate-(--tac-pile-c-tilt)",
  "left-7/10 w-1/4 h-(--tac-pile-d-h) rotate-(--tac-pile-d-tilt)",
] as const;
/** How many of them, by the `pile` level. */
const PILE_SHEETS = [0, 1, 2, 4] as const;

const CONTENTS = { clipPath: "var(--tac-clip-contents)" } as const;

export function Folder({
  size,
  tab,
  contents,
  pile = 0,
  flag,
  open = false,
  children,
  className,
}: {
  size: FolderSize;
  /** What is written on the label tab. */
  tab?: ReactNode;
  /** Objects standing in the folder, each positioned by the caller inside the area above the pocket. */
  contents?: ReactNode;
  /** 0-3: how much more the folder holds than it shows (none, a little, some, a lot). */
  pile?: 0 | 1 | 2 | 3;
  /** A flag stood on the pocket's top edge, toward its right end. */
  flag?: ReactNode;
  /** Opened and emptied: the front leans out toward the reader. */
  open?: boolean;
  /** What is printed on the pocket. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span data-tac-folder={size} data-tac-full={pile === 3 ? "" : undefined} className={cn("relative block h-(--tac-fol-h) select-none", SHADOW, className)}>
      <span aria-hidden className="absolute inset-x-0 bottom-0 top-(--tac-fol-rise) block rounded-(--tac-fol-r) bg-(--tac-folder-back) bg-(image:--tac-board-grain) shadow-(--tac-folder-edge)" />
      <span className="absolute inset-x-(--tac-fol-inset) bottom-(--tac-fol-pocket) top-0 block" style={CONTENTS}>
        {PILE.slice(0, PILE_SHEETS[pile]).map((place) => (
          <span key={place} aria-hidden className={cn("absolute bottom-0 block origin-bottom rounded-t-(--tac-pile-r) bg-(--tac-pile) bg-(image:--tac-grain) shadow-(--tac-pile-edge)", place)} />
        ))}
        {contents}
      </span>
      {/* The pocket's mouth: whatever goes in is in its shade for the last few px. */}
      <span aria-hidden className="absolute inset-x-0 bottom-(--tac-fol-pocket) block h-(--tac-fol-mouth-h) bg-(image:--tac-fol-mouth)" />
      <span className={cn("absolute inset-x-0 bottom-0 flex flex-col", open && "origin-bottom transform-(--tac-fol-open)")}>
        {/* Over the body's top highlight by a pixel, so tab and body are one piece of board. */}
        <span className="relative z-10 -mb-px flex h-(--tac-fol-tab-h)">
          <span className="flex w-(--tac-fol-tab-w) min-w-0 items-center rounded-tl-(--tac-fol-r) bg-(--tac-folder) shadow-(--tac-folder-tab-edge)">{tab}</span>
          <svg aria-hidden viewBox="0 0 28 24" preserveAspectRatio="none" className="h-full w-(--tac-fol-shoulder) shrink-0">
            <path d="M0 0C14 0 14 24 28 24H0z" className="fill-(--tac-folder)" />
            <path d="M0 0.5C14 0.5 14 24 28 24" fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke" className="stroke-(--tac-folder-lip)" />
          </svg>
        </span>
        <span className="relative flex h-(--tac-fol-pocket) flex-col rounded-b-(--tac-fol-r) rounded-tr-(--tac-fol-r) bg-(--tac-folder) bg-(image:--tac-folder-face) shadow-(--tac-folder-edge)">
          {children}
        </span>
        {/* Stuck to the pocket's top edge by its foot; it leans with the front when the folder is open. */}
        {flag ? <span className="absolute bottom-(--tac-fol-pocket) right-(--tac-fol-flag-x) z-10 -mb-(--tac-flag-tuck) flex">{flag}</span> : null}
      </span>
    </span>
  );
}
