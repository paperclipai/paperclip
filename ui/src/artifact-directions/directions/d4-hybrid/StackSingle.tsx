import { cn } from "@/lib/utils";
import type { LabGroup } from "../../kit";
import { ProseExcerpt } from "./Content";
import { usePreviewKind } from "./GalleryPreview";
import { KindWell, Picture } from "./Lead";
import { MetaLine } from "./MetaLine";
import { PaperSheet } from "./PaperSheet";
import { StateMark } from "./StateMark";
import { SLAB, TitleAction } from "./UnitAction";
import { stackAction } from "./actions";
import { artifactCount } from "./gallery-model";
import { metaParts } from "./kinds";

/**
 * GALLERY — a stack that holds one artifact is not a folder. It is Tactile's
 * single-document lockup (screen 5) in Tint's container: the artifact itself
 * standing at the left of the slab, its words at the right.
 *
 *   ┌──────────┐  ACM-2
 *   │  paper   │  Task title, up to four lines
 *   │  (whole, │  Document · rev 1
 *   │  fading  │
 *   │  toward  │  1 artifact
 *   │  its     │  Updated Sep 25, 2026                    ○ Review
 *   │  foot)   │
 *   └──────────┘
 *
 * The object at the left is the lead by the rule (Lead.tsx): the paper sheet
 * with the document's own words — the WHOLE sheet at its own proportion,
 * standing in the slab's 20px inset on every side as screen 5 has it, its
 * print fading toward the foot (there is more below); a picture with its
 * corner label; or the glyph on the mono well. Nothing stands behind
 * anything, nothing is angled: a pile is a folder, one thing is this.
 * It still opens the stack, like a folder. The sheet is `aria-hidden`, so a
 * document's opening is also here as an sr-only excerpt — its one copy.
 */

const OBJECT = "w-(--hy-paper-tile-w) shrink-0";

export function StackSingle({ group }: { group: LabGroup }) {
  const artifact = group.artifacts[0];
  const [kind, onError] = usePreviewKind(artifact);
  return (
    <li data-kind={artifact.kind} data-unit="stack-single" data-count={group.count} className={cn("group/unit @container relative flex min-h-34 min-w-0 gap-5 overflow-hidden p-5", SLAB)}>
      {kind === "paper" ? (
        <PaperSheet artifact={artifact} size="tile" className="self-start" />
      ) : kind === "picture" ? (
        <Picture artifact={artifact} label="md" className={cn(OBJECT, "self-start aspect-4/3")} onError={onError} />
      ) : (
        <KindWell artifact={artifact} size="lg" className={cn(OBJECT, "self-stretch")} />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-mono text-(length:--text-micro) leading-4 text-(--hy-ink-2)">{group.taskIdentifier}</span>
        {/* Four lines at most, a size up from a folder's pocket: this is the stack's whole face. */}
        <h3 className="mt-1 line-clamp-4 wrap-anywhere text-base font-semibold leading-6 text-foreground">
          <TitleAction action={stackAction(group)} stretch="after:rounded-lg" title={`${group.taskIdentifier} ${group.title}`}>
            {group.title}
          </TitleAction>
        </h3>
        <MetaLine wrap parts={metaParts(artifact)} className="mt-1" />
        {kind === "paper" && artifact.kind === "document" ? <ProseExcerpt artifact={artifact} maxChars={240} className="sr-only" /> : null}
        {/* The count and the date on their own lines (screen 5), in the meta line's voice; in a narrow cell the date wraps rather than truncates. */}
        <div className="mt-auto flex min-w-0 items-end gap-3 pt-4">
          <p className="flex min-w-0 flex-1 flex-col gap-0.5 font-mono text-(length:--text-micro) leading-4 text-(--hy-ink-2)">
            <span>{artifactCount(group.count)}</span>
            <span>Updated {group.updatedLabel}</span>
          </p>
          <StateMark review={artifact.review} />
        </div>
      </div>
    </li>
  );
}
