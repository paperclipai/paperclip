import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { REVIEW_LABEL, excerptLead, isTaskDocument, metaParts, panelActions, splitName } from "./kind";
import { LIP } from "./ledge";
import { MetaLine } from "./MetaLine";
import { ArtifactObject, isPortraitKind, liesAcross } from "./objects/ArtifactObject";
import { PanelActions } from "./PanelActions";

/**
 * PANEL — one artifact on the desk. Two ways of lying there:
 *
 *   in a slot    paper and things (`pn`). The object is at the left with the
 *                caption beside it. A sheet is wide enough to read — headline
 *                about 13px, first lines about 10px — and its foot slides
 *                under the rail that ends the row; slides, ledgers, boxes and
 *                address cards lie whole above it. Below a 16rem body the
 *                caption goes under and the slot takes the whole width.
 *   across       pictures (`pw`): an image, a video — playable in place, its
 *                own controls — or a link with a preview. As wide as the
 *                desk, the caption under it.
 *
 * The review flag stands on the object's top edge. No card: the caption is
 * plain UI type — title, kind and machine values, the summary (a document
 * without one gets its own first lines), the filename and, for a file, its
 * content type, who and when — with the actions as ordinary buttons. Every
 * row ends in the rail, the same lip a thread row's tray has.
 */

const SLOT = { clipPath: "var(--tac-clip-slot)" } as const;
/** A sheet's slot takes the sheet's own size attributes, so it can measure itself against the page (tokens-panel.css). */
const SHEET_SLOT = { "data-tac-size": "pn", "data-tac-box": "page" } as const;

/** Kinds whose card in the product carries a content-type line. */
const FILE_KINDS = new Set(["pdf", "slides", "sheet", "archive", "code", "file"]);

function Slot({ artifact }: { artifact: LabArtifact }) {
  const sheet = isPortraitKind(artifact.kind);
  return (
    <span
      className={cn(
        "relative block w-full shrink-0 @3xs/desk:w-(--tac-stage-w)",
        sheet ? "h-(--tac-stage-min) @3xs/desk:h-auto @3xs/desk:min-h-(--tac-stage-min)" : "pb-1 @3xs/desk:min-h-(--tac-stage-min) @3xs/desk:pb-5",
      )}
      style={sheet ? SLOT : undefined}
      {...(sheet ? SHEET_SLOT : null)}
    >
      <span className={cn("flex justify-center", sheet && "absolute inset-x-0 top-(--tac-slot-top)")}>
        <ArtifactObject artifact={artifact} size="pn" flag="top" />
      </span>
      {/* Stacked, the slot ends in its own rail; beside the caption, the row's rail does it. */}
      {sheet ? <span aria-hidden className={cn(LIP, "@3xs/desk:hidden")} /> : null}
    </span>
  );
}

/**
 * A picture across the desk. It answers a click as the first action does; the keyboard and assistive technology use
 * that action's button in the caption, so this copy of the target is out of both. A video is not a copy of anything:
 * it is the player.
 */
function Across({ artifact }: { artifact: LabArtifact }) {
  const holder = "block w-full max-w-(--tac-wide-max) px-1.5";
  if (artifact.kind === "video") {
    return (
      <span className={holder}>
        <ArtifactObject artifact={artifact} size="pw" flag="top" player />
      </span>
    );
  }
  const object = <ArtifactObject artifact={artifact} size="pw" flag="top" />;
  const [action] = panelActions(artifact);
  return action.href ? (
    <a href={action.href} tabIndex={-1} aria-hidden className={cn(holder, "cursor-pointer")}>
      {object}
    </a>
  ) : (
    <button type="button" tabIndex={-1} aria-hidden className={cn(holder, "cursor-pointer text-left")}>
      {object}
    </button>
  );
}

function Dot({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-baseline">
      <span aria-hidden className="w-3 shrink-0 text-center">
        ·
      </span>
      {children}
    </span>
  );
}

export function PanelItem({ artifact, showAuthor }: { artifact: LabArtifact; /** False under a run's divider, which already names the agent. */ showAuthor: boolean }) {
  const [base, ext] = splitName(artifact);
  const name = artifact.kind === "link" ? (artifact.url ?? base) : `${base}${ext}`;
  const across = liesAcross(artifact);
  // A document with no summary of its own is previewed by its opening, in type one can read.
  const lead = artifact.summary ?? (artifact.kind === "document" ? excerptLead(artifact) : "");
  const mime = FILE_KINDS.has(artifact.kind) || (artifact.kind === "document" && !isTaskDocument(artifact)) ? artifact.contentType : undefined;
  return (
    <li data-tac-item={artifact.kind} className={cn("group/object relative flex flex-col gap-y-3 pt-4.5", across ? "items-start" : "gap-x-(--tac-slot-gap) @3xs/desk:flex-row")}>
      {across ? <Across artifact={artifact} /> : <Slot artifact={artifact} />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 self-stretch pb-4.5">
        <h4 className="line-clamp-3 wrap-anywhere text-sm font-medium leading-5 text-foreground" title={artifact.title}>
          {artifact.title}
          {/* Across the desk the object, flag included, is a hidden copy of the first action. */}
          {across && artifact.kind !== "video" && artifact.review ? <span className="sr-only"> — {REVIEW_LABEL[artifact.review]}</span> : null}
        </h4>
        <MetaLine parts={metaParts(artifact)} className="text-xs leading-4 text-(--tac-meta)" />
        {lead ? (
          <p className="line-clamp-2 wrap-anywhere pt-0.5 text-xs leading-4 text-(--tac-meta)" title={artifact.summary}>
            {lead}
          </p>
        ) : null}
        {/* The filename, whole, and a file's content type under it: both wrap rather than hide. */}
        <p className="wrap-anywhere pt-1 font-mono text-(length:--text-micro) leading-4 text-(--tac-meta)">
          {name}
          {mime ? <span className="block opacity-85">{mime}</span> : null}
        </p>
        {/* Who and when. Each part leads with its dot; the first dot on a line falls in the clipped margin, so a wrapped line never starts or ends with one. */}
        <p className="overflow-hidden text-(length:--text-micro) leading-4 text-(--tac-meta)">
          <span className="-ml-3 flex flex-wrap items-baseline">
            {showAuthor ? (
              <Dot>
                <span className="truncate">{artifact.author}</span>
              </Dot>
            ) : null}
            <Dot>
              <time dateTime={artifact.updatedAt} title={`${artifact.author} · ${artifact.updatedLabel}`} className="font-mono">
                {artifact.updatedLabel}
              </time>
            </Dot>
          </span>
        </p>
        <PanelActions artifact={artifact} overSlot={!across} />
      </div>
      {/* The rail that ends the row; a sheet's foot is behind it. */}
      <span aria-hidden className={LIP} />
    </li>
  );
}
