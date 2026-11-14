import { useMemo, useState } from "react";
import type { LabGroup } from "../../kit";
import { KindTally } from "./KindTally";
import { MetaLine } from "./MetaLine";
import { StackFace } from "./StackFace";
import { ReviewTally } from "./StateMark";
import { MOTION, TitleAction } from "./UnitAction";
import { stackAction } from "./actions";
import { artifactCount, stackFaces } from "./gallery-model";
import { countReview } from "./panel-model";

/**
 * GALLERY — a stack of two or more artifacts: a flat folder.
 *
 *    ┌ ACM-3 ╲___________________________   tab + back panel   --hy-folder-back
 *    │  ▙ZIP  ▙PPTX  ┌─ picture ─◥       │   what is inside, standing in it
 *   ┌┴────────────────────────────────────┴┐
 *   │ Task title, two lines at most        │  pocket            --hy-slab
 *   │ 21 artifacts · Updated Sep 28, 2026  │
 *   │ ▙10 ▙3 ▙3 ▙3 ▙2         ○ 9 to review│
 *   └──────────────────────────────────────┘
 *
 * Two neutral fills, no shadow, no gradient: the pocket is the slab every
 * card is made of, and the back panel is one neutral step further from the
 * page. A folder has no hue of its own; what colours it is its contents
 * (StackFace.tsx) — pictures and white paper sheets first, a full-colour
 * glyph only for a kind with nothing to show — and the same kinds counted on
 * the pocket as a caption.
 *
 * The mouth is inset 32px at each side (Tint's: 16px) and 20px at the top,
 * where Tint's is 4px; the faces inside rest a further 12px down in both
 * (StackFace.tsx), so the first face stands 32px below the back panel's top
 * edge against Tint's 16px — the inset the artifacts see is double on all
 * three sides (R7, screen 6). The mouth is 9:4 of its own width: 304px wide
 * where Tint's was 336, it is as tall as Tint's 5:2 was, so the doubled
 * margins add only air and the contents keep the height and the clipping
 * Tint's had. It takes whatever height the row has to spare, so the pocket
 * is exactly as tall as its three lines.
 *
 * The task identifier is the label on the tab. The folder's body is one link
 * (the title, stretched; the tab is a second, pointer-only way in). On hover
 * the title underlines and the contents rise 12px out of the folder, each a
 * beat after the last — unless motion is reduced; the pocket keeps its fill,
 * so it never merges with the back panel.
 */
export function StackFolder({ group }: { group: LabGroup }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const faces = useMemo(() => stackFaces(group, failed), [group, failed]);
  const action = stackAction(group);
  return (
    <li data-unit="stack-folder" data-count={group.count} className="group/unit relative flex min-w-0 flex-col">
      <div className="flex h-6 shrink-0">
        {/* Pointer-only: the title below is the folder's link for the keyboard and for assistive technology. */}
        <a href={action.href} tabIndex={-1} aria-hidden className="flex items-center rounded-tl-xl bg-(--hy-folder-back) pl-3.5 pr-1 font-mono text-(length:--text-micro) font-medium leading-none text-foreground">
          {group.taskIdentifier}
        </a>
        {/* The tab's shoulder: one curve from the tab's top down to the back panel's. */}
        <svg viewBox="0 0 28 24" aria-hidden focusable="false" className="h-6 w-7 shrink-0">
          <path d="M0 0C14 0 14 24 28 24H0Z" className="fill-(--hy-folder-back)" />
        </svg>
      </div>
      <div className="flex flex-1 flex-col rounded-b-xl rounded-tr-xl bg-(--hy-folder-back)">
        {/* The mouth clips at the pocket's edge. Its contents rest 12px down and rise on hover, one after another (StackFace.tsx). */}
        <div aria-hidden data-mouth className="relative mx-8 mt-5 aspect-9/4 flex-auto overflow-hidden">
          <div className="absolute inset-x-0 -bottom-2 top-0 grid grid-cols-12 grid-rows-1 gap-2">
            {faces.map((face, index) => (
              <StackFace key={face.artifact.id} face={face} index={index} onFail={(id) => setFailed((prev) => new Set(prev).add(id))} />
            ))}
          </div>
        </div>
        <div className={`flex flex-col rounded-b-xl rounded-t-lg bg-(--hy-slab) p-3.5 group-active/unit:bg-(--hy-slab-raised) ${MOTION}`}>
          <h3 className="line-clamp-2 wrap-anywhere text-sm font-medium leading-5 text-foreground">
            <TitleAction action={action} stretch="after:top-6 after:rounded-xl after:rounded-tl-none" title={`${group.taskIdentifier} ${group.title}`}>
              {group.title}
            </TitleAction>
          </h3>
          <MetaLine wrap parts={[artifactCount(group.count), `Updated ${group.updatedLabel}`]} className="mt-1" />
          {/* Directly under the meta line: a row's spare height goes to the mouth, not to a gap in the pocket. */}
          <div className="flex min-w-0 items-center gap-3 pt-2.5">
            <KindTally artifacts={group.artifacts} className="flex-1" />
            <ReviewTally count={countReview(group.artifacts)} />
          </div>
        </div>
      </div>
    </li>
  );
}
