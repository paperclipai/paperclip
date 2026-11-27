import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { actionName, externalProps, type SolidAction } from "./actions";
import { galleryActions } from "./gallery-model";
import { GalleryPreview } from "./GalleryPreview";
import { META_TEXT, MetaDot, MetaLine } from "./MetaLine";
import { shortStamp } from "./panel-model";
import { BUTTON, BUTTON_PRIMARY, COVER, ICON_BUTTON, SLAB, SLAB_HOVER } from "./slab";

/**
 * GALLERY — one artifact in an opened stack (or the ungrouped grid): a slab
 * tile, preview first.
 *
 *   ┌ preview, 18:11 ───────────────────────────────┐
 *   │ picture · words on a sheet · a file's facts    │
 *   │ [KIND]                              ● Review   │   ink bottom-left, state bite bottom-right
 *   └────────────────────────────────────────────────┘
 *   Title, the full width of the tile, up to two lines
 *   kind · size · rev · extent                          (mono)
 *   Sep 28, 11:07 AM · Author              [⧉] [↓] [→]  (stamp mono, author sans)
 *
 * The thread row's grammar turned on its end: block, title, mono meta, and
 * the actions at the far end of the foot — where the thread row and the panel
 * card end theirs. The whole tile is the [→] action's target (the owning
 * task, at this artifact), which turns to ink when the tile is hovered. Open
 * file in new tab and Download file are ghosts beside it, always visible, so
 * they are reachable by touch and by keyboard and sit in no other link; each
 * has its own glyph (a box with an arrow leaves the app, a tray downloads,
 * the arrow goes to the task). In a tile under 18rem the actions take a row of
 * their own.
 */

function Ghost({ action, artifact }: { action: SolidAction; artifact: LabArtifact }) {
  const Icon = action.icon;
  return (
    <a data-secondary href={action.href} {...externalProps(action)} aria-label={actionName(action, artifact)} title={action.label} className={ICON_BUTTON}>
      <Icon aria-hidden className="size-3.5" />
    </a>
  );
}

export function GalleryTile({ artifact }: { artifact: LabArtifact }) {
  const { primary, secondary } = galleryActions(artifact);
  const PrimaryIcon = primary.icon;
  return (
    <article
      data-solid="gallery-tile"
      data-kind={artifact.kind}
      className={cn("group/slab @container/unit relative flex h-full min-w-0 flex-col gap-2.5 p-3", SLAB, SLAB_HOVER)}
    >
      <GalleryPreview artifact={artifact} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="line-clamp-2 text-sm font-medium wrap-break-word text-foreground">{artifact.title}</h3>
        <footer className="mt-auto flex flex-wrap items-end justify-end gap-x-2 gap-y-1.5">
          <p className="flex min-w-0 grow basis-40 flex-col">
            <MetaLine artifact={artifact} className="truncate" />
            <span className={cn(META_TEXT, "flex min-w-0 text-(--solid-meta)")}>
              <time dateTime={artifact.updatedAt} className="shrink-0">
                <span className="sr-only">Last edited </span>
                {shortStamp(artifact.updatedLabel)}
              </time>
              <MetaDot />
              <span className="min-w-0 truncate font-sans">{artifact.author}</span>
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-1">
            {/* First in the DOM so it is first in the tab order; last in the row. */}
            <a
              data-primary
              href={primary.href}
              aria-label={actionName(primary, artifact)}
              title={[actionName(primary, artifact), artifact.summary, `Last edited ${artifact.updatedLabel} · ${artifact.author}`].filter(Boolean).join("\n")}
              className={cn(BUTTON, BUTTON_PRIMARY, COVER, "order-last w-7 cursor-pointer px-0 after:cursor-pointer")}
            >
              <PrimaryIcon aria-hidden className="size-3.5" />
            </a>
            {secondary.map((action) => (
              <Ghost key={action.label} action={action} artifact={artifact} />
            ))}
          </div>
        </footer>
      </div>
    </article>
  );
}
