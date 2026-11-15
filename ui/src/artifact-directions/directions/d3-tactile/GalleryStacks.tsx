import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact, LabGroup } from "../../kit";
import { countLabel, peekOf, pileOf, reviewCountOf, standsTall, widthOf } from "./gallery-model";
import { RING, RING_ON, metaParts } from "./kind";
import { KindTally } from "./KindTally";
import { LEDGE, LIP, LIP_CLIP, STAND, STAND_CLIP } from "./ledge";
import { MetaLine } from "./MetaLine";
import { ArtifactObject } from "./objects/ArtifactObject";
import { Folder } from "./objects/Folder";
import { StateFlag } from "./StateFlag";

/**
 * GALLERY — the shelf: one folder per task.
 *
 * A stack of several artifacts is a folder with its real contents standing
 * in it — the sheets and prints are the stack's own artifacts, picked so a
 * mixed stack shows its mix — and separate sheet tops behind them when it
 * holds more than it shows (one, two, or four for a full folder). The
 * pocket's tab is labelled with the task identifier; the pocket carries the
 * title, a one-line tally by kind, the count and the date, and a
 * "Review · N" flag stands on its top edge when anything inside waits for
 * review. Hovering lifts the contents out and fans them.
 *
 * A stack of one is not a folder: it is the object itself, stood on a mat in
 * the ground tone with the same lines beside it (a sheet, its foot behind
 * the mat's lip, as in a thread row) or under it (anything wider than tall,
 * on a ledge, as in an opened stack).
 */

const SLOT_LETTERS = "abcd";

const SLOT =
  "absolute bottom-0 left-(--tac-slot-left) block origin-bottom -translate-x-1/2 translate-y-(--tac-slot-y) rotate-(--tac-fan) transition-(--tac-tp-fan) duration-(--motion-duration-base) ease-(--motion-ease-out-expo) motion-safe:group-hover/object:translate-y-(--tac-slot-y-open) motion-safe:group-hover/object:rotate-(--tac-fan-open) motion-safe:group-focus-visible/object:translate-y-(--tac-slot-y-open) motion-safe:group-focus-visible/object:rotate-(--tac-fan-open)";

/** The stack's own artifacts, standing in the pocket. Each says how wide it is, so its slot can keep it inside the folder's sides. */
function FolderContents({ artifacts }: { artifacts: LabArtifact[] }) {
  return (
    <>
      {artifacts.map((artifact, index) => (
        <span
          key={artifact.id}
          data-tac-slot={`${artifacts.length}${SLOT_LETTERS[index]}`}
          data-tac-deep={standsTall(artifact) ? "" : undefined}
          className={SLOT}
          style={{ "--tac-slot-w": `${widthOf(artifact)}rem` } as CSSProperties}
        >
          <ArtifactObject artifact={artifact} size="fd" flag="nub" repose={2} />
        </span>
      ))}
    </>
  );
}

const FOCUS = cn(RING, RING_ON.canvas, "focus-visible:ring-offset-4");

function Count({ group, className }: { group: LabGroup; className?: string }) {
  return (
    <span className={className}>
      <span className="whitespace-nowrap">
        <span className="font-mono text-(length:--tac-mono-scale)">{group.count}</span> {countLabel(group.count)}
      </span>
      <span className="whitespace-nowrap">
        Updated <span className="font-mono text-(length:--tac-mono-scale)">{group.updatedLabel}</span>
      </span>
    </span>
  );
}

const stackLabel = (group: LabGroup, review: number) =>
  `Open stack ${group.taskIdentifier} ${group.title}: ${group.count} ${countLabel(group.count)}, updated ${group.updatedLabel}${review > 0 ? `, ${review} to review` : ""}`;

function StackFolder({ group }: { group: LabGroup }) {
  const peek = peekOf(group);
  const review = reviewCountOf(group.artifacts);
  return (
    <a href={`#stack-${group.taskIdentifier}`} aria-label={stackLabel(group, review)} data-tac-stack="many" className={cn("group/object block rounded-2xl", FOCUS)}>
      <Folder
        size="shelf"
        pile={pileOf(group.count, peek.length)}
        contents={<FolderContents artifacts={peek} />}
        tab={<span className="truncate pl-3.5 font-mono text-(length:--text-micro) font-medium tracking-wide text-(--tac-folder-ink)">{group.taskIdentifier}</span>}
        flag={review > 0 ? <StateFlag review="needs_review" count={review} /> : null}
      >
        <span className="flex min-h-0 flex-1 flex-col px-3.5 pb-3 pt-2.5">
          <span className="line-clamp-2 wrap-anywhere text-base font-semibold leading-5.5 text-(--tac-folder-ink)" title={group.title}>
            {group.title}
          </span>
          <KindTally artifacts={group.artifacts} className="block truncate pt-1 text-xs leading-4 text-(--tac-folder-meta)" />
          <Count group={group} className="mt-auto flex items-baseline justify-between gap-3 pt-1 text-xs leading-4 text-(--tac-folder-meta)" />
        </span>
      </Folder>
    </a>
  );
}

const ID = "shrink-0 font-mono text-(length:--text-micro) font-medium tracking-wide text-(--tac-meta)";
const MAT = "absolute inset-x-0 bottom-0 top-(--tac-mat-top) block rounded-xl bg-(--tac-ground) bg-(image:--tac-ground-grain) shadow-(--tac-tray-rim) transition-colors duration-(--motion-duration-fast) group-hover/object:bg-(--tac-tray-hover)";

/**
 * One artifact is not a stack: the object stands on a mat by itself, labelled like a folder's pocket. A sheet stands
 * at the mat's left with its foot behind the lip and its head proud of the mat's top edge, its lines beside it;
 * anything wider than tall stands on a ledge with its lines under, the identifier leading the title as it does in
 * the product.
 */
function StackLone({ group }: { group: LabGroup }) {
  const artifact = group.artifacts[0];
  const review = reviewCountOf(group.artifacts);
  const tall = standsTall(artifact);
  return (
    <a
      href={`#stack-${group.taskIdentifier}`}
      aria-label={stackLabel(group, review)}
      data-tac-stack="one"
      data-tac-folder="shelf"
      className={cn("group/object @container/lone relative flex h-(--tac-fol-h) rounded-xl", tall ? "items-end" : "flex-col justify-end overflow-x-clip px-4", FOCUS)}
    >
      <span aria-hidden className={MAT} />
      {tall ? (
        <>
          <span className="relative z-10 mb-(--tac-row-foot) ml-5 flex shrink-0 @max-2xs/lone:ml-3" style={STAND_CLIP}>
            <ArtifactObject artifact={artifact} size="gl" flag="top" />
          </span>
          <span aria-hidden className={cn(LIP_CLIP, "top-(--tac-mat-top) rounded-xl")}>
            <span className={LIP} />
          </span>
          {/* In a compact cell (under 18rem) the lines have about 5rem: smaller type, and the date may wrap. */}
          <span className="relative ml-5 mr-4 flex min-w-0 flex-1 flex-col gap-1 pb-5 @max-2xs/lone:ml-3 @max-2xs/lone:mr-3 @max-2xs/lone:pb-4">
            <span className={ID}>{group.taskIdentifier}</span>
            <span className="line-clamp-4 wrap-anywhere text-base font-semibold leading-5.5 text-foreground @max-2xs/lone:text-sm @max-2xs/lone:leading-5" title={group.title}>
              {group.title}
            </span>
            <MetaLine parts={metaParts(artifact)} className="text-xs leading-4 text-(--tac-meta)" />
            <Count group={group} className="flex flex-col pt-2 text-xs leading-4 text-(--tac-meta) @max-2xs/lone:*:whitespace-normal" />
          </span>
        </>
      ) : (
        <>
          <span className={cn("block", LEDGE)}>
            <span className="flex items-end" style={STAND_CLIP}>
              <span className={cn("flex", STAND)}>
                <ArtifactObject artifact={artifact} size="gl" flag="top" />
              </span>
            </span>
          </span>
          <span className="relative flex min-w-0 flex-col gap-0.5 pb-3 pt-(--tac-gl-gap)">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={ID}>{group.taskIdentifier}</span>
              <span className="truncate text-sm font-semibold leading-5 text-foreground" title={group.title}>
                {group.title}
              </span>
            </span>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-xs leading-4 text-(--tac-meta)">
              <MetaLine parts={metaParts(artifact).slice(0, 2)} />
              <Count group={group} className="flex items-baseline gap-3" />
            </span>
          </span>
        </>
      )}
    </a>
  );
}

export function GalleryStacks({ groups }: { groups: LabGroup[] }) {
  if (groups.length === 0) return <p className="py-16 text-center text-sm font-medium text-foreground">No artifact stacks yet.</p>;
  return (
    // The shelf, measured: under 40rem it keeps two columns of compact folders (tokens-gallery.css).
    <div className="@container/shelf">
      <ul data-tac-shelf className="grid grid-cols-(--tac-shelf-cols) gap-x-6 gap-y-10 pt-1">
        {groups.map((group) => (
          <li key={group.id} className="min-w-0">
            {group.count > 1 ? <StackFolder group={group} /> : <StackLone group={group} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
