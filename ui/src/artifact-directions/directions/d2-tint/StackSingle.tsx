import { cn } from "@/lib/utils";
import type { LabGroup } from "../../kit";
import { GalleryPreview, usePreviewKind } from "./GalleryPreview";
import { KindGlyph } from "./KindGlyph";
import { MetaLine } from "./MetaLine";
import { StateMark } from "./StateMark";
import { SLAB, TitleAction } from "./UnitAction";
import { stackAction } from "./actions";
import { artifactCount } from "./gallery-model";

/**
 * GALLERY — a stack that holds one artifact is not a folder. It is that
 * artifact, lying on the page as the same slab an opened stack's tiles are:
 * its preview, then the task it belongs to where a folder has its pocket.
 *
 *   ┌──────── the artifact's preview ────────┐
 *   └────────────────────────────────────────┘
 *   ACM-2  Task title                           identifier + title, two lines at most
 *   1 artifact · Updated Sep 25, 2026
 *   ▙ The artifact's own title        ○ Review
 *
 * No tab, no back panel, nothing standing behind anything: a pile is a
 * folder, one thing is a tile. It still opens the stack, like a folder.
 *
 * The preview box takes the height the folders beside it give the row (never
 * less than 136px), and the picture fills that box — it can never set it, so
 * the row does not move when an image arrives.
 */
export function StackSingle({ group }: { group: LabGroup }) {
  const artifact = group.artifacts[0];
  const [kind, onError] = usePreviewKind(artifact);
  return (
    <li data-kind={artifact.kind} data-unit="stack-single" data-count={group.count} className={cn("group/unit @container relative flex min-w-0 flex-col p-2", SLAB)}>
      <div className="relative min-h-34 flex-1">
        <GalleryPreview artifact={artifact} kind={kind} onError={onError} depth="short" className="absolute inset-0 aspect-auto h-full" />
      </div>
      <div className="flex min-w-0 flex-col px-1.5 pb-1.5 pt-2.5">
        {/* Two lines at most, like a folder's pocket; the identifier a folder wears on its tab leads the first. */}
        <h3 className="line-clamp-2 wrap-anywhere text-sm font-medium leading-5 text-foreground">
          <span className="mr-2 whitespace-nowrap font-mono text-(length:--text-micro) leading-none">{group.taskIdentifier}</span>
          <TitleAction action={stackAction(group)} stretch="after:rounded-lg" title={`${group.taskIdentifier} ${group.title}`}>
            {group.title}
          </TitleAction>
        </h3>
        <MetaLine wrap parts={[artifactCount(group.count), `Updated ${group.updatedLabel}`]} className="mt-1" />
        <div className="flex min-w-0 items-center gap-1.5 pt-2.5">
          <KindGlyph kind={artifact.kind} size="mini" />
          <span className="min-w-0 flex-1 truncate text-xs leading-4 text-(--tint-ink-2)">{artifact.title}</span>
          <StateMark review={artifact.review} />
        </div>
      </div>
    </li>
  );
}
