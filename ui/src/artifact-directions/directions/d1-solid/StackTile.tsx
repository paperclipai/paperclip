import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LabGroup } from "../../kit";
import { Counts } from "./Counts";
import { kindTally, pileDepth, stackPreviews } from "./gallery-model";
import { GalleryPreview } from "./GalleryPreview";
import { plural } from "./kinds";
import { META_TEXT, MetaDot } from "./MetaLine";
import { CORNER_NOTCH } from "./StateMarker";
import { BUTTON, BUTTON_PRIMARY, COVER, SLAB, SLAB_HOVER } from "./slab";

/**
 * GALLERY — one task's stack.
 *
 *        ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁             pile: the slabs behind the face, each narrower
 *      ▁ MD 7 · PDF 4 · PPTX 4 · PNG 3 ▁▁▁       and one step nearer the canvas; the nearer one
 *    ┌──────────────────────┬─────────┐          says what is in the pile, on its edge
 *    │                      │ 12 slides│
 *    │  picture             ├─────────┤   mosaic: the newest three, each as its own preview;
 *    │ [PNG]                │ [ZIP] +18│  the one with most to show is large
 *    └──────────────────────┴─────────┘
 *    ACM-3 Create visual directions and first acmehats brand deck
 *    21 artifacts  ● 9 to review                          [→]
 *    Updated Sep 28, 2026
 *
 * The pile is made of flat fills only. Its depth says how much is in it: no
 * slab behind one artifact, one behind two or three, two behind more. A stack
 * of one is therefore an artifact tile with a task's name on it — one preview
 * at full size, a flat top — and cannot be mistaken for a pile.
 *
 * The whole object — face and pile — is the [→] action's target ("Open
 * stack"). Hover or keyboard focus steps the face, turns the action to ink,
 * and the pile rises 6px a slab (not under reduced motion).
 *
 * Pile geometry: 28px is kept above every face; the nearer slab shows 16px of
 * itself 12px in from each side, the farther one 12px more, 32px in.
 */

const LAYER =
  "pointer-events-none absolute h-10 overflow-hidden rounded-md transition-transform duration-(--motion-duration-fast) ease-(--motion-ease-standard) motion-reduce:transition-none";
const RISE_1 = "motion-safe:group-hover/pile:-translate-y-1.5 motion-safe:group-has-[[data-primary]:focus-visible]/pile:-translate-y-1.5";
const RISE_2 = "motion-safe:group-hover/pile:-translate-y-3 motion-safe:group-has-[[data-primary]:focus-visible]/pile:-translate-y-3";

function Pile({ group, depth }: { group: LabGroup; depth: 0 | 1 | 2 }) {
  if (depth === 0) return null;
  return (
    <>
      {depth > 1 ? <span aria-hidden data-solid="pile-layer" className={cn(LAYER, RISE_2, "inset-x-8 top-0 bg-(--solid-pile-2)")} /> : null}
      <span aria-hidden data-solid="pile-layer" className={cn(LAYER, RISE_1, "inset-x-3 top-3 bg-(--solid-pile-1)")}>
        {/* The slab's visible edge is 16px: one line of mono caps, cut clean where the pile runs out of room. */}
        <span className="block h-4 truncate px-3 font-mono text-(length:--text-nano) leading-4 font-medium tracking-(--tracking-label) text-(--solid-meta) uppercase">
          {kindTally(group.artifacts).map((entry, index) => (
            <span key={entry}>
              {index > 0 ? <MetaDot /> : null}
              {entry}
            </span>
          ))}
        </span>
      </span>
    </>
  );
}

/** The corner bite of the mosaic: how many artifacts it leaves out, in mono. */
function MoreTab({ count }: { count: number }) {
  return (
    <span aria-hidden className={cn(META_TEXT, CORNER_NOTCH, "px-2 pt-1 pb-0.5 font-medium text-foreground")}>
      +{count}
    </span>
  );
}

function Mosaic({ group }: { group: LabGroup }) {
  const [lead, ...rest] = stackPreviews(group);
  if (!lead) return null;
  if (rest.length === 0) return <GalleryPreview artifact={lead} state={false} />;
  const more = group.count - 1 - rest.length;
  return (
    <div data-solid="stack-mosaic" className="relative grid aspect-(--solid-plate-ratio) w-full grid-cols-3 grid-rows-2 gap-1 overflow-hidden rounded-md">
      <div className="col-span-2 row-span-2 min-h-0 min-w-0">
        <GalleryPreview artifact={lead} state={false} className="size-full" />
      </div>
      {rest.map((artifact) => (
        <div key={artifact.id} className={cn("min-h-0 min-w-0", rest.length === 1 ? "row-span-2" : null)}>
          <GalleryPreview artifact={artifact} scale="cell" state={false} className="size-full" />
        </div>
      ))}
      {more > 0 ? <MoreTab count={more} /> : null}
    </div>
  );
}

export function StackTile({ group }: { group: LabGroup }) {
  const depth = pileDepth(group.count);
  const count = plural(group.count, "artifact");
  return (
    // 28px above every face, so faces line up along a row whether or not a pile sits behind them.
    <article data-solid="stack-tile" data-count={group.count} data-pile={depth} className="group/pile relative flex h-full min-w-0 flex-col pt-7">
      <Pile group={group} depth={depth} />
      <div className={cn("group/slab @container/unit relative flex min-w-0 flex-1 flex-col gap-2.5 p-3", SLAB, SLAB_HOVER)}>
        <Mosaic group={group} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* h2: on the stacks page a stack sits directly under the page title. */}
          <h2 className="line-clamp-2 text-sm font-medium wrap-break-word text-foreground">
            <span className={cn(META_TEXT, "mr-2 font-normal text-(--solid-meta)")}>{group.taskIdentifier}</span>
            {group.title}
          </h2>
          <footer className="mt-auto flex items-end gap-2">
            {/* Always two lines — what is in it, then when — so the feet of a row line up; a long count wraps inside its own line. */}
            <p className={cn(META_TEXT, "flex min-w-0 flex-1 flex-col text-(--solid-meta)")}>
              <Counts lead={count} of={group.artifacts} />
              <span className="truncate">Updated {group.updatedLabel}</span>
            </p>
            <a
              data-primary
              href={`#stack-${group.taskIdentifier}`}
              aria-label={`Open stack ${group.taskIdentifier}: ${group.title}, ${count}`}
              title={`Open stack ${group.taskIdentifier}: ${group.title}\n${count} · Updated ${group.updatedLabel}`}
              // The cover reaches up over the pile, so the whole object is one target.
              className={cn(BUTTON, BUTTON_PRIMARY, COVER, "w-7 cursor-pointer px-0 after:-top-7 after:cursor-pointer")}
            >
              <ArrowRight aria-hidden className="size-3.5" />
            </a>
          </footer>
        </div>
      </div>
    </article>
  );
}
