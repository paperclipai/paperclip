import { Fragment, useState } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { FileName } from "./FileName";
import { MetaLine } from "./MetaLine";
import { PanelNamed, PanelPicture, PanelSheet, panelLeadKind } from "./PanelLead";
import { StateMark } from "./StateMark";
import { ButtonAction, SLAB, SecondaryAction } from "./UnitAction";
import { panelAction, panelSecondary } from "./actions";
import { kindLabel, linkLabel, metaParts, shortDateTime } from "./kinds";

/**
 * PANEL — one artifact on the task's shelf. One skeleton for every kind; the
 * lead follows the one rule (PanelLead.tsx):
 *
 *   SHOWN (picture, or text on a sheet)        NAMED (nothing to show)
 *   ┌──────── lead, full width ────────┐       ┌ well ┐ title
 *   └──────────────────────────────────┘       │ glyph│ kind · size · fact  ○ Review
 *   title                                      │      │ summary
 *   kind · size · rev · fact     ○ Review      └──────┘ filename · MIME type
 *   summary · filename
 *   author · updated      icon actions  [Primary]   (the same footer on both)
 *
 * Everything the shipped card prints is printed here — nothing lives only in
 * a tooltip. Filename, address and MIME type sit above the card's stretched
 * action so they can be selected and copied. Hover is neutral (the hue is
 * spent on the lead): the slab steps up and the primary button inverts.
 */

// Machine values a reviewer may want to copy: above the stretched link, selectable.
const COPYABLE = "relative z-10 cursor-text select-text";
const SMALL = "mt-1 text-(length:--text-micro) leading-4 text-(--tint-ink-2)";

/** The product prints the MIME type on file cards — not on documents, pictures or links. */
const showsMime = (a: LabArtifact) => Boolean(a.contentType) && a.kind !== "document" && a.kind !== "image" && a.kind !== "video" && a.kind !== "link";

/** A long MIME type wraps after its own separators, not in the middle of a word — and still copies as the plain string. */
function breakable(value: string) {
  return value.split(/(?<=[/.+-])/).map((part, index) => (
    <Fragment key={index}>
      {index > 0 ? <wbr /> : null}
      {part}
    </Fragment>
  ));
}

function Byline({ artifact, grouped }: { artifact: LabArtifact; grouped: boolean }) {
  return (
    <p data-byline className="flex min-w-0 flex-auto flex-col text-xs leading-4 text-(--tint-ink-2)">
      {/* Inside a run section the agent is the section's heading; only the edit time is the card's own. */}
      {grouped ? null : <span className="truncate">{artifact.author}</span>}
      <time dateTime={artifact.updatedAt} className="truncate font-mono text-(length:--text-micro)">
        {shortDateTime(artifact.updatedLabel, artifact.updatedAt)}
      </time>
    </p>
  );
}

export function PanelCard({ artifact, grouped }: { artifact: LabArtifact; grouped: boolean }) {
  const [failed, setFailed] = useState(false);
  const lead = panelLeadKind(artifact, failed);
  const shown = lead !== "named";
  const primary = panelAction(artifact);
  const secondary = panelSecondary(artifact);
  // A link's address is too long for the meta line at this width; it takes the filename's place.
  const address = artifact.kind === "link" ? linkLabel(artifact.url) : undefined;
  const meta = address ? [kindLabel(artifact)] : metaParts(artifact, { facts: true });
  const { filename } = artifact;
  return (
    <li data-kind={artifact.kind} data-unit="panel-card" data-lead-kind={lead} className={cn("group/unit @container relative flex min-w-0 flex-col gap-2 p-2", SLAB)}>
      {lead === "picture" ? <PanelPicture artifact={artifact} onError={() => setFailed(true)} /> : lead === "sheet" ? <PanelSheet artifact={artifact} /> : null}
      <div className={cn("flex min-w-0 gap-3", shown ? "px-1.5" : null)}>
        {lead === "named" ? <PanelNamed artifact={artifact} /> : null}
        <div className="min-w-0 flex-1 py-0.5">
          {/* Long titles wrap rather than truncate, as the shipped card's do; a third line in a narrow pane. */}
          <h4 className="line-clamp-2 wrap-anywhere text-sm font-medium leading-5 text-foreground @max-xs:line-clamp-3">{artifact.title}</h4>
          {/* The state mark shares the meta line when both fit and drops under it when they do not; neither truncates the other. */}
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <MetaLine parts={meta} wrap className="max-w-full" />
            <StateMark review={artifact.review} className="ml-auto" />
          </div>
          {artifact.summary ? (
            <p data-summary className="mt-1 line-clamp-2 wrap-anywhere text-xs leading-4 text-foreground">
              {artifact.summary}
            </p>
          ) : null}
          {filename ? (
            <FileName name={filename} className={cn(SMALL, COPYABLE)} />
          ) : address ? (
            <span data-address className={cn("block truncate font-mono", SMALL, COPYABLE)}>
              {address}
            </span>
          ) : null}
          {showsMime(artifact) ? (
            <span data-mime className={cn("block wrap-anywhere font-mono", SMALL, "mt-0", COPYABLE)}>
              {breakable(artifact.contentType ?? "")}
            </span>
          ) : null}
        </div>
      </div>
      {/* `mt-auto`: in a wide pane the cards sit two or three to a row and share its height. */}
      <footer className={cn("mt-auto flex min-w-0 flex-wrap items-center gap-2", shown ? "pl-1.5" : "pl-1")}>
        <Byline artifact={artifact} grouped={grouped} />
        {/* If the byline and the actions do not fit one row (a narrow pane), the actions wrap under it, still at the right. */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {secondary.map((action) => (
            <SecondaryAction
              key={action.intent}
              action={action}
              count={action.intent === "comments" ? artifact.commentCount : undefined}
              // A Markdown file carries four of these beside its button; 26px each keeps the row on one line at 434px.
              className={action.intent === "comments" ? undefined : "w-6.5"}
            />
          ))}
          <ButtonAction action={primary} stretch="after:rounded-lg" className={secondary.length > 0 ? "ml-1" : undefined} />
        </div>
      </footer>
    </li>
  );
}
