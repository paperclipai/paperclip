import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { actionName, downloadAction, externalProps, threadAction } from "./actions";
import { extent, isWaiting, metaParts } from "./kinds";
import { KindBlock } from "./KindBlock";
import { MetaLine } from "./MetaLine";
import { StateMarker } from "./StateMarker";
import { BUTTON, BUTTON_PRIMARY, COVER, ICON_BUTTON, primaryRest, SLAB, SLAB_HOVER } from "./slab";

/**
 * THREAD — one work product between turns: a 60px slab.
 *
 *   [kind block 72×44]  Title                                  ● Review  [Open gallery ⤢]
 *                       kind · size · rev · extent — summary
 *
 * One grammar for all ten kinds (today: three). The whole slab is the primary
 * action's target; hovering it steps the fill and turns the action to ink. An
 * artifact that waits for review has its action in ink already.
 *
 * The row gives way in order of what matters least (by its own width, inside its inset):
 *   from 48rem  one-line title, summary on the meta line after a dash
 *   under 48rem two-line title, summary on its own line under the meta, two lines at most
 *               (a row with a summary grows to 76px; nothing is left to a tooltip)
 *   from 42rem  every action is the same 136px block, as every row starts with the same 72px one
 *   under 36rem the state is its dot alone
 *   under 28rem the action is its icon alone
 * and the text column never goes under 8rem, so the title is the last thing to yield.
 */
export function ThreadWorkProduct({ artifact }: { artifact: LabArtifact }) {
  const action = threadAction(artifact);
  const Icon = action.icon;
  // A text-like file opens in the side panel, so Download becomes its own small target.
  const download = action.id === "tab" ? downloadAction(artifact) : null;
  const DownloadIcon = download?.icon;
  // "Slides · 90.1 KB · 12 slides — 12 editable slides…" stutters: the summary keeps the figure, the meta lets it go.
  const figure = extent(artifact)?.split(" ")[0];
  const echoed = Boolean(figure && artifact.summary?.startsWith(`${figure} `));

  const primary = {
    "data-primary": true,
    "aria-label": actionName(action, artifact),
    title: actionName(action, artifact),
    // First in the DOM so it is first in the tab order; last in the row.
    className: cn(
      BUTTON,
      primaryRest(isWaiting(artifact)),
      BUTTON_PRIMARY,
      COVER,
      "order-last cursor-pointer after:cursor-pointer @2xl:min-w-34 @2xl:justify-between @2xl:px-2.5",
    ),
  };
  const face = (
    <>
      <span className="hidden @md:inline">{action.label}</span>
      <Icon aria-hidden className="size-3.5" />
    </>
  );

  return (
    <article
      data-solid="thread-row"
      data-kind={artifact.kind}
      className={cn("group/slab @container relative flex min-w-0 items-center gap-3 p-2 pr-3", SLAB, SLAB_HOVER)}
    >
      <KindBlock artifact={artifact} size="sm" />
      <div className="min-w-32 flex-1">
        <p className="line-clamp-2 text-sm font-medium wrap-break-word text-foreground @3xl:line-clamp-1">{artifact.title}</p>
        <p className="mt-0.5 flex min-w-0 items-baseline">
          <MetaLine artifact={artifact} max={echoed ? metaParts(artifact).length - 1 : undefined} className="min-w-0 truncate @3xl:shrink-0" />
          {artifact.summary ? (
            <span className="hidden min-w-0 truncate text-xs text-(--solid-meta) @3xl:inline">
              <span aria-hidden className="px-2">
                —
              </span>
              {artifact.summary}
            </span>
          ) : null}
        </p>
        {artifact.summary ? <p className="mt-0.5 line-clamp-2 text-xs text-(--solid-meta) @3xl:hidden">{artifact.summary}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {action.href ? (
          <a href={action.href} {...externalProps(action)} {...primary}>
            {face}
          </a>
        ) : (
          <button type="button" {...primary}>
            {face}
          </button>
        )}
        <StateMarker review={artifact.review} collapse />
        {download && DownloadIcon ? (
          <a data-secondary href={download.href} aria-label={actionName(download, artifact)} title={download.label} className={ICON_BUTTON}>
            <DownloadIcon aria-hidden className="size-3.5" />
          </a>
        ) : null}
      </div>
    </article>
  );
}
