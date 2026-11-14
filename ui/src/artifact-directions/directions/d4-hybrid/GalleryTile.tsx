import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { GalleryPreview, usePreviewKind } from "./GalleryPreview";
import { MetaLine } from "./MetaLine";
import { StateMark } from "./StateMark";
import { SLAB, SecondaryAction, TitleAction } from "./UnitAction";
import { galleryAction, gallerySecondary } from "./actions";
import { headlineFact, metaParts, shortDateTime, timeOnly } from "./kinds";

/**
 * GALLERY — one artifact in an opened stack.
 *
 * The panel card made preview-first for every kind: the same filled slab, a
 * 16px inset (double Tint's 8 — R5, screen 3), the lead across the whole
 * width, then three lines —
 *
 *   ┌───────────── preview, 16:9 ──────────────┐
 *   │ picture · white paper sheet · mono well  │
 *   └──────────────────────────────────────────┘
 *   Title                                          one line
 *   kind · size · rev · fact            ○ Review   the mono meta line
 *   Author · 11:07 AM                    ↗  ↓      icon actions, always visible
 *
 * The title is the link (stretched over the tile); it goes to the artifact in
 * its task, as today's whole-card link does. "Open file in new tab" and
 * "Download file" are their own targets, visible at rest and reachable by
 * keyboard — today they exist only on hover.
 *
 * A fact the preview already states (a video's duration chip, a kind well's
 * headline) is not repeated on the meta line. The author truncates before the
 * time does. Under a day heading the tile shows the time; under a heading
 * that spans days (`dated`) it shows the date too.
 */
export function GalleryTile({ artifact, dated = false }: { artifact: LabArtifact; dated?: boolean }) {
  const [kind, onError] = usePreviewKind(artifact);
  const secondary = gallerySecondary(artifact);
  const stated = kind === "named" ? headlineFact(artifact) : kind === "picture" ? artifact.durationLabel : undefined;
  return (
    <li data-kind={artifact.kind} data-unit="gallery-tile" className={cn("group/unit @container relative flex min-w-0 flex-col p-4", SLAB)}>
      <GalleryPreview artifact={artifact} kind={kind} onError={onError} />
      <div className="flex min-w-0 flex-col px-1.5 pt-3">
        <h4 className="truncate text-sm font-medium leading-5 text-foreground">
          <TitleAction action={galleryAction(artifact)} stretch="after:rounded-lg" title={artifact.title}>
            {artifact.title}
          </TitleAction>
        </h4>
        {/* Every tile keeps the height of a state mark here, so a row of tiles stays level whether or not one is waiting. */}
        <div className="mt-0.5 flex h-5.5 min-w-0 items-center gap-2">
          <MetaLine parts={metaParts(artifact, { facts: true, omit: stated })} className="min-w-0 flex-1" />
          <StateMark review={artifact.review} />
        </div>
        <footer className="mt-1 flex h-7 min-w-0 items-center gap-2">
          <p data-byline className="flex min-w-0 flex-1 items-baseline text-xs leading-4 text-(--hy-ink-2)">
            <span className="truncate">{artifact.author}</span>
            <span className="mx-(--hy-meta-gap) shrink-0">·</span>
            <time dateTime={artifact.updatedAt} className="shrink-0 font-mono text-(length:--text-micro)">
              {dated ? shortDateTime(artifact.updatedLabel, artifact.updatedAt) : timeOnly(artifact.updatedLabel)}
            </time>
          </p>
          {secondary.length > 0 ? (
            <div className="-mr-1.5 flex shrink-0 items-center">
              {secondary.map((action, index) => (
                <SecondaryAction key={`${action.intent}-${index}`} action={action} />
              ))}
            </div>
          ) : null}
        </footer>
      </div>
    </li>
  );
}
