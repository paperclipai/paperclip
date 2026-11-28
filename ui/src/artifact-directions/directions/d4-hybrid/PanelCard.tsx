import { useState } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { Character } from "./Character";
import { FileName } from "./FileName";
import { MetaLine } from "./MetaLine";
import { PanelNamed, PanelPaper, PanelPicture, PanelVideo, namedFacts, panelLeadKind } from "./PanelLead";
import { StateMark } from "./StateMark";
import { ButtonAction, SLAB, SecondaryAction } from "./UnitAction";
import { panelAction, panelSecondary } from "./actions";
import { kindLabel, linkLabel, metaParts, shortDateTime } from "./kinds";

/**
 * PANEL — one artifact on the task's shelf: screen 10's card. One skeleton
 * for every kind; only the well at the top changes (PanelLead.tsx):
 *
 *   ┌── the well: paper + first lines · the picture · glyph + facts ──┐
 *   └─────────────────────────────────────────────────────────────────┘
 *   Title                                   sans 14px, two lines at most
 *   interface-craft-critique.md             mono: the filename, or a link's address
 *   Document · rev 1              ○ Review  mono: the kind line; the state chip at its right
 *   Summary, where the agent wrote one      sans 12px
 *
 *   ◉ Agent name                ⧉ ⤓ [Open ↗]   the agent's character, the name in bold,
 *     Sep 28, 11:07 AM                         the time in mono; targets at the right
 *
 * Twelve pixels of padding all round (Tint's card had eight) and sixteen
 * between cards (Tint had eight). The words start 14px under the well, the
 * mono lines sit on an 18px pitch and the footer stands 16px below the words
 * — screen 10's measures. A named well says the file's facts (its count and
 * its size) beside the glyph, so the kind line does not say them again; the
 * content type is the facts' tooltip. A paper card's extension is on its
 * label. Hover is neutral (the hue is spent in the well): the slab steps up
 * — the well with it — and the button inverts. In a wide pane the cards sit
 * two or three to a row at their own heights (`items-start`, PanelSection.tsx),
 * so a short card beside a tall picture does not carry empty slab.
 */

// Machine values a reviewer may want to copy: above the stretched link, selectable.
const COPYABLE = "relative z-10 cursor-text select-text";
const MONO_LINE = "font-mono text-(length:--text-micro) leading-4.5 text-(--hy-ink-2)";

function Byline({ artifact }: { artifact: LabArtifact }) {
  return (
    <div data-byline className="flex min-w-0 flex-auto items-center gap-2">
      <Character name={artifact.author} />
      <p className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-semibold leading-4 text-foreground">{artifact.author}</span>
        <time dateTime={artifact.updatedAt} className="truncate font-mono text-(length:--text-micro) leading-4 text-(--hy-ink-2)">
          {shortDateTime(artifact.updatedLabel, artifact.updatedAt)}
        </time>
      </p>
    </div>
  );
}

export function PanelCard({ artifact }: { artifact: LabArtifact }) {
  const [failed, setFailed] = useState(false);
  const lead = panelLeadKind(artifact, failed);
  const primary = panelAction(artifact);
  const secondary = panelSecondary(artifact);
  // A link's address is too long for the kind line at this width; it takes the filename's place.
  const address = artifact.kind === "link" ? linkLabel(artifact.url) : undefined;
  // A named well already says the count and the size as its facts, so the kind line does not say them again.
  const meta = address ? [kindLabel(artifact)] : metaParts(artifact, { facts: true, omit: lead === "named" ? namedFacts(artifact) : undefined });
  const { filename } = artifact;
  // A video keeps its play button whether its poster is up or has failed (PanelVideo owns the fallback).
  const video = artifact.kind === "video" && Boolean(artifact.videoUrl);
  return (
    <li data-kind={artifact.kind} data-unit="panel-card" data-lead-kind={lead} className={cn("group/unit @container relative flex min-w-0 flex-col p-3", SLAB)}>
      {video ? (
        <PanelVideo artifact={artifact} failed={failed} onError={() => setFailed(true)} />
      ) : lead === "picture" ? (
        <PanelPicture artifact={artifact} onError={() => setFailed(true)} />
      ) : lead === "paper" ? (
        <PanelPaper artifact={artifact} />
      ) : (
        <PanelNamed artifact={artifact} />
      )}
      <div className="mt-3.5 min-w-0">
        {/* Long titles wrap rather than truncate, as the shipped card's do; a third line in a narrow pane. */}
        <h4 className="line-clamp-2 wrap-anywhere text-sm font-medium leading-5 text-foreground @max-xs:line-clamp-3">{artifact.title}</h4>
        {filename ? (
          <FileName name={filename} className={cn("mt-1", MONO_LINE, COPYABLE)} />
        ) : address ? (
          <span data-address className={cn("mt-1 block truncate", MONO_LINE, COPYABLE)}>
            {address}
          </span>
        ) : null}
        {/* The state mark shares the kind line when both fit and drops under it when they do not; neither truncates the other. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <MetaLine parts={meta} wrap className="max-w-full leading-4.5" />
          <StateMark review={artifact.review} className="ml-auto" />
        </div>
        {artifact.summary ? (
          <p data-summary className="mt-1.5 line-clamp-2 wrap-anywhere text-xs leading-4 text-foreground">
            {artifact.summary}
          </p>
        ) : null}
      </div>
      {/* `mt-auto`: the footer stands at the card's foot however many lines the words took. */}
      <footer className="mt-auto flex min-w-0 flex-wrap items-center gap-2 pt-4">
        <Byline artifact={artifact} />
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
          {/* The button says "Open" (screen 10); its accessible name keeps the product's words — "Read document: …". */}
          <ButtonAction action={{ ...primary, label: "Open" }} stretch="after:rounded-lg" className={secondary.length > 0 ? "ml-1" : undefined} />
        </div>
      </footer>
    </li>
  );
}
