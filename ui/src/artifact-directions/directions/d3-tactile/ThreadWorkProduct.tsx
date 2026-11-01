import { Download, ExternalLink, Maximize2, PanelRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { RING, RING_AFTER, RING_ON, metaParts, primaryAction, secondaryAction, type ActionIcon, type ArtifactAction } from "./kind";
import { LIP, LIP_CLIP, STAND_CLIP } from "./ledge";
import { MetaLine } from "./MetaLine";
import { ArtifactObject } from "./objects/ArtifactObject";
import { StateFlag } from "./StateFlag";

/**
 * THREAD — one work product between turns: a shallow pocket with the artifact
 * standing in it.
 *
 * The tray is a filled, softly inset slab with a front lip across its bottom
 * edge. The artifact stands at the left as a small object, its foot behind
 * the lip; a sheet is taller than the tray and stands 10px proud of its top
 * edge, a print or a slide stands inside it. Beside it, ordinary UI type:
 * title, kind and machine values, the summary (two lines at most), and the
 * one action. The whole tray is the primary action's hit area; a text-like
 * file keeps Download as its own small target. The review flag is stuck over
 * the tray's top edge.
 *
 * In a wide column the tray keeps its own measure (40rem); in a column under
 * 48rem — the thread beside an open pane — it runs the full width, so its
 * right edge meets the message actions above it.
 */

const ICON: Record<ActionIcon, LucideIcon> = { open: PanelRight, gallery: Maximize2, download: Download, external: ExternalLink };

function RowAction({ action, title, primary }: { action: ArtifactAction; title: string; primary: boolean }) {
  const Icon = ICON[action.icon];
  const className = cn(
    "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md text-xs font-medium text-foreground",
    primary
      ? // The label drops below a 24rem tray, as in the product; the hit area is the tray itself, and so is the focus ring.
        cn("px-1.5 after:absolute after:inset-0 after:cursor-pointer after:rounded-xl focus-visible:after:ring-offset-background", RING_AFTER)
      : cn("relative z-10 w-7 justify-center text-(--tac-meta) transition-colors hover:bg-(--tac-tray-press) hover:text-foreground", RING, RING_ON.ground),
  );
  const label = `${action.label}: ${title}`;
  const content = (
    <>
      {primary ? <span className="hidden @sm:inline">{action.label}</span> : null}
      <Icon className="size-3.5" aria-hidden />
    </>
  );
  return action.href ? (
    <a href={action.href} aria-label={label} title={primary ? undefined : action.label} className={className}>
      {content}
    </a>
  ) : (
    <button type="button" aria-label={label} className={className}>
      {content}
    </button>
  );
}

export function ThreadWorkProduct({ artifact }: { artifact: LabArtifact }) {
  const secondary = secondaryAction(artifact);
  return (
    // The column, measured: the tray answers its width, not the viewport's.
    <div className="@container/col w-full">
      <article
        aria-label={artifact.title}
        data-tac-row={artifact.kind}
        className="group/object @container relative flex min-h-18 w-full max-w-(--tac-tray-max) items-center gap-3 rounded-xl bg-(--tac-tray) bg-(image:--tac-ground-grain) pb-(--tac-row-pb) pl-2.5 pr-2 pt-1.5 shadow-(--tac-tray-rim) transition-(--tac-tp-lift) duration-(--motion-duration-fast) ease-(--motion-ease-standard) hover:bg-(--tac-tray-hover) active:bg-(--tac-tray-press) @max-3xl/col:max-w-none"
      >
        {/* The object's place in the row; the object itself hangs from the tray's bottom edge, whatever the row's height. */}
        <span aria-hidden className="block w-21 shrink-0" />
        {/* Above the action's hit-area overlay, so the focus ring passes behind the standing sheet; clicks fall through. */}
        <span className="pointer-events-none absolute bottom-(--tac-row-foot) left-2.5 z-10 flex w-21 justify-center" style={STAND_CLIP}>
          <ArtifactObject artifact={artifact} size="xs" flag="none" />
        </span>
        <span aria-hidden className={cn(LIP_CLIP, "rounded-xl")}>
          <span className={LIP} />
        </span>
        {/* In a tray narrow enough that the title runs to its right end, a flagged row's text starts below the flag. */}
        <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", artifact.review && "@max-sm:pt-2.5")}>
          <span className="line-clamp-1 wrap-anywhere text-sm font-medium text-foreground @max-sm:line-clamp-2" title={artifact.title}>
            {artifact.title}
          </span>
          <MetaLine parts={metaParts(artifact)} className="text-xs text-(--tac-meta)" />
          {artifact.summary ? (
            <span className="line-clamp-2 wrap-anywhere text-xs text-(--tac-meta)" title={artifact.summary}>
              {artifact.summary}
            </span>
          ) : null}
        </div>
        {/* Above the hit-area overlay too; clicks fall through. */}
        {artifact.review ? <StateFlag review={artifact.review} className="pointer-events-none absolute -top-2 right-4 z-10" /> : null}
        <div className="flex shrink-0 items-center gap-0.5">
          {secondary ? <RowAction action={secondary} title={artifact.title} primary={false} /> : null}
          <RowAction action={primaryAction(artifact)} title={artifact.title} primary />
        </div>
      </article>
    </div>
  );
}
