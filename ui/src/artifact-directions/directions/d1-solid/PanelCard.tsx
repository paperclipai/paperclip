import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { actionName, externalProps } from "./actions";
import { ExcerptSheet, hasExcerpt } from "./ExcerptSheet";
import { hasThumbnail, isWaiting, plural } from "./kinds";
import { KindBlock } from "./KindBlock";
import { META_TEXT, MetaDot, MetaLine } from "./MetaLine";
import { panelActions } from "./panel-actions";
import { stampUnder, type PanelSection } from "./panel-model";
import { PanelLead } from "./PanelLead";
import { PanelMenu } from "./PanelMenu";
import { StateMarker } from "./StateMarker";
import { BUTTON, BUTTON_HOVER, COUNT_BUTTON, FOCUS, primaryRest, SLAB } from "./slab";

/**
 * PANEL — one artifact on the task's shelf: a thread row with its drawer open.
 *
 *   [kind block 72×44]  Title, wraps                     a picture leads its card instead:
 *                       Summary, wraps                   ┌ picture 16:9, kind tab ┐
 *                       kind · size · rev · extent       └────────────────────────┘
 *                       filename.ext / content type      Title …
 *   ┌ sheet: the excerpt as text ───────────────────┐    (only for text kinds)
 *   └────────────────────────────────────────────────┘
 *   ● Review  11:07 AM                 [💬 0] [⋯] [Read document ⌄]
 *
 * The head is the thread row at the same size. The foot is ONE row with the
 * same three places on every card: the state (or nothing); who and when in
 * mono (the author only where the section does not name them; the time alone
 * where the section carries the day; it breaks between the two when short of
 * room, never inside either); and at the far end the comments count (Markdown
 * files), "More actions" (where there are any) and the primary — the thread's
 * 136px block, in ink when the artifact waits for review.
 *
 * This is the reading surface, so the card is NOT a click target: text can be
 * selected, tooltips show, and nothing downloads from a stray click. Only the
 * controls act.
 *
 * Nothing in the head is clamped: titles, summaries, filenames and content
 * types wrap. Under 20rem of card (a pane dragged narrow) the foot's two ends
 * stack.
 */

/** Kinds whose card is the product's file card, which carries the content type. */
const FILE_KINDS = new Set<LabArtifact["kind"]>(["pdf", "slides", "sheet", "archive", "code", "file"]);

export function PanelCard({ artifact, section }: { artifact: LabArtifact; section: PanelSection }) {
  const [pictureFailed, setPictureFailed] = useState(false);
  const { primary, more } = panelActions(artifact);
  const PrimaryIcon = primary.icon;
  const waiting = isWaiting(artifact);
  const leads = hasThumbnail(artifact) && !pictureFailed;
  const showAuthor = artifact.author !== section.agent;
  const mono = cn(META_TEXT, "wrap-anywhere text-(--solid-meta)");

  const button = {
    "aria-label": actionName(primary, artifact),
    // First in the DOM so it is first in the tab order; last in the row.
    className: cn(BUTTON, primaryRest(waiting), BUTTON_HOVER, FOCUS, "order-last min-w-34 cursor-pointer justify-between px-2.5"),
  };
  const face = (
    <>
      {primary.label}
      <PrimaryIcon aria-hidden className="size-3.5" />
    </>
  );

  return (
    <article data-solid="panel-card" data-kind={artifact.kind} className={cn("flex min-w-0 flex-col gap-2.5 p-3", SLAB)}>
      {leads ? <PanelLead artifact={artifact} onPictureError={() => setPictureFailed(true)} /> : null}

      <div className="flex min-w-0 items-start gap-3">
        {leads ? null : <KindBlock artifact={artifact} size="sm" ink />}
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium wrap-break-word text-foreground">{artifact.title}</h4>
          {artifact.summary ? <p className="mt-0.5 text-xs wrap-break-word text-(--solid-meta)">{artifact.summary}</p> : null}
          <p className="mt-1 flex flex-col">
            <MetaLine artifact={artifact} wrap />
            {artifact.filename ? <span className={mono}>{artifact.filename}</span> : null}
            {FILE_KINDS.has(artifact.kind) && artifact.contentType ? <span className={mono}>{artifact.contentType}</span> : null}
            {hasThumbnail(artifact) && pictureFailed ? <span className={mono}>No preview available</span> : null}
          </p>
        </div>
      </div>

      {/* What waits for review is given room to be read here; the rest shows enough to be told apart. */}
      {hasExcerpt(artifact) ? <ExcerptSheet artifact={artifact} shape="drawer" lines={waiting ? 6 : 3} /> : null}

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* State, then who and when. The line breaks between the two when the row is short of room, never inside either. */}
        <div className="flex min-w-0 grow basis-28 flex-wrap items-center gap-x-2.5 gap-y-0.5">
          <StateMarker review={artifact.review} />
          <p className={cn(META_TEXT, "min-w-0 text-(--solid-meta)")}>
            {showAuthor ? (
              <span className="inline-block max-w-full truncate align-bottom font-sans">
                {artifact.author}
                <MetaDot />
              </span>
            ) : (
              <span className="sr-only">{artifact.author}, </span>
            )}
            <wbr />
            <time dateTime={artifact.updatedAt} title={artifact.updatedLabel} className="whitespace-nowrap">
              {stampUnder(artifact.updatedLabel, section.startedLabel)}
            </time>
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {primary.href ? (
            <a href={primary.href} {...externalProps(primary)} {...button}>
              {face}
            </a>
          ) : (
            <button type="button" {...button}>
              {face}
            </button>
          )}
          {artifact.commentCount != null ? (
            <button
              type="button"
              aria-label={`${plural(artifact.commentCount, "comment")}: ${artifact.title}`}
              title={plural(artifact.commentCount, "comment")}
              className={cn(COUNT_BUTTON, artifact.commentCount > 0 ? "text-foreground" : null)}
            >
              <MessageSquare aria-hidden className="size-3.5" />
              {artifact.commentCount}
            </button>
          ) : null}
          <PanelMenu actions={more} artifact={artifact} />
        </div>
      </footer>
    </article>
  );
}
