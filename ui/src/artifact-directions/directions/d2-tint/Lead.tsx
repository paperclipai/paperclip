import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { KindGlyph, type GlyphSize } from "./KindGlyph";
import { glyphLabel } from "./kinds";

/**
 * THE ONE RULE — the lead of every unit, on every surface, is one of two things.
 *
 *   SHOWN  the artifact's own content wearing the kind's two marks: the top-
 *          right corner folded back as a solid kind-hue flap, and the
 *          extension as a hue tab on the bottom-left edge. A picture
 *          (`FoldedPreview`) or its text on a neutral sheet (`FoldedSheet`).
 *   NAMED  when there is nothing to show, or no room to show it: the kind
 *          glyph centred on a well filled with the kind's quiet hue (`KindWell`).
 *
 * So colour is the fold and tab on real content, or the glyph and its well —
 * never both, and nowhere else on the unit at rest. A missing or failed
 * picture falls back to NAMED, so the placeholder is never an empty box.
 */

type FoldSize = "sm" | "md" | "lg";
/** Where the extension tab sits. `top` is for a folder, where the bottom edge is tucked behind the pocket. */
type TabEdge = "bottom" | "top" | "none";

// The line-height sits AFTER the size in `tab`: tailwind-merge drops a leading that precedes a font size.
// `sheet` pads a text sheet so its first line clears the fold; `room` is the extra a tab needs on its edge.
const FOLD: Record<FoldSize, { clip: string; flap: string; tab: string; play: string; sheet: string; room: Record<"bottom" | "top", string> }> = {
  sm: { clip: "var(--tint-clip-fold-sm)", flap: "size-(--tint-fold-sm)", tab: "px-1 py-0.5 text-(length:--text-nano) leading-none", play: "top-(--tint-play-y-sm) size-5", sheet: "px-2 pt-2.5 pb-2", room: { bottom: "pb-5", top: "pt-5" } },
  md: { clip: "var(--tint-clip-fold-md)", flap: "size-(--tint-fold-md)", tab: "px-1.5 py-1 text-(length:--text-micro) leading-none", play: "top-1/2 size-9", sheet: "px-3 pt-4 pb-3", room: { bottom: "pb-7", top: "pt-7" } },
  lg: { clip: "var(--tint-clip-fold-lg)", flap: "size-(--tint-fold-lg)", tab: "px-2 py-1 text-xs leading-none", play: "top-1/2 size-11", sheet: "px-3.5 pt-6 pb-3.5", room: { bottom: "pb-8", top: "pt-8" } },
};

const TAB_EDGE = { bottom: "bottom-0 rounded-tr-(--rad-4)", top: "top-0 rounded-br-(--rad-4)" } as const;

/** The folded flap: the cut-off corner laid back, inner corner rounded. Square, scales with its box. */
function FoldFlap({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden focusable="false" className={cn("pointer-events-none absolute right-0 top-0", className)}>
      <path d="M0 0 12 12H3.2Q0 12 0 8.8Z" className="fill-(--kind)" />
    </svg>
  );
}

function Tab({ artifact, fold, edge }: { artifact: LabArtifact; fold: FoldSize; edge: TabEdge }) {
  const label = glyphLabel(artifact);
  if (!label || edge === "none") return null;
  return <span className={cn("pointer-events-none absolute left-0 bg-(--kind) font-sans font-bold text-(--kind-ink)", TAB_EDGE[edge], FOLD[fold].tab)}>{label}</span>;
}

/** The play mark on a video poster: white on a neutral scrim, never the kind hue. */
export function PlayMark({ fold, className }: { fold: FoldSize; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-(--tint-scrim) text-(--tint-on-kind)",
        FOLD[fold].play,
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="size-1/2 translate-x-(--tint-play-nudge)">
        <path d="M7 4.6 19.4 12 7 19.4Z" fill="currentColor" stroke="currentColor" strokeWidth="3.4" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

interface FrameProps {
  artifact: LabArtifact;
  fold: FoldSize;
  tab?: TabEdge;
  className?: string;
  children?: ReactNode;
}

/**
 * SHOWN, a picture. The caller sets the box (`className`) and picks the fold;
 * the image fills the box and can never set its height. `fit="contain"` shows
 * the whole picture on the neutral well (the panel, where it is judged).
 * Children render over the image (a duration, a play button).
 */
export function FoldedPreview({ artifact, fold, tab = "bottom", fit = "cover", play = true, className, onError, children }: FrameProps & { fit?: "cover" | "contain"; play?: boolean; onError?: () => void }) {
  // A cropped photograph keeps its middle; a cropped screenshot keeps its top-left, where a page starts.
  const crop = artifact.kind === "link" ? "object-cover object-left-top" : "object-cover";
  return (
    <span data-lead="preview" className={cn("relative block shrink-0 overflow-hidden rounded-(--tint-radius-glyph) bg-(--tint-well)", className)} style={{ clipPath: FOLD[fold].clip }}>
      <img src={artifact.thumbnailUrl} alt="" loading="lazy" onError={onError} className={cn("absolute inset-0 size-full", fit === "cover" ? crop : "object-contain")} />
      {artifact.kind === "video" && play ? <PlayMark fold={fold} /> : null}
      {children}
      <FoldFlap className={FOLD[fold].flap} />
      <Tab artifact={artifact} fold={fold} edge={tab} />
    </span>
  );
}

/**
 * SHOWN, text. A neutral sheet (a hole back to the page fill) holding the
 * artifact's own words at full width, in the frame a picture wears. Children
 * are the content (Content.tsx); anything that does not fit is clipped by the
 * sheet, so the caller clamps to whole lines.
 */
export function FoldedSheet({ artifact, fold, tab = "bottom", className, children }: FrameProps) {
  const spec = FOLD[fold];
  const tabbed = tab !== "none" && glyphLabel(artifact) ? spec.room[tab] : null;
  return (
    <div data-lead="sheet" className={cn("relative min-w-0 overflow-hidden rounded-(--tint-radius-glyph) bg-(--tint-well)", spec.sheet, tabbed, className)} style={{ clipPath: spec.clip }}>
      {children}
      <FoldFlap className={spec.flap} />
      <Tab artifact={artifact} fold={fold} edge={tab} />
    </div>
  );
}

/** NAMED. The glyph centred on its kind well; children sit beside it (a headline, a summary). */
export function KindWell({
  artifact,
  size = "md",
  className,
  glyphClassName,
  children,
}: {
  artifact: LabArtifact;
  size?: GlyphSize;
  className?: string;
  /** Overrides the glyph's box (the SVG scales), e.g. a container-query step down in a narrow unit. */
  glyphClassName?: string;
  children?: ReactNode;
}) {
  return (
    <div data-lead="well" className={cn("flex min-w-0 items-center justify-center gap-3 rounded-(--tint-radius-glyph) bg-(--kind-well)", className)}>
      <KindGlyph kind={artifact.kind} label={glyphLabel(artifact)} size={size} className={glyphClassName} />
      {children}
    </div>
  );
}

// 72×46: the one lead box of a thread row, so every title starts on the same edge.
const ROW_BOX = "h-11.5 w-18 shrink-0";

/** The lead of a thread row: a picture when there is one; otherwise the xs glyph on its well (no room to show text here). */
export function Lead({ artifact }: { artifact: LabArtifact }) {
  const [failed, setFailed] = useState(false);
  if (!artifact.thumbnailUrl || failed) return <KindWell artifact={artifact} size="xs" className={ROW_BOX} />;
  return <FoldedPreview artifact={artifact} fold="sm" className={ROW_BOX} onError={() => setFailed(true)} />;
}
