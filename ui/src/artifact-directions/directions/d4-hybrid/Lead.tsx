import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { CornerLabel, type LabelSize } from "./CornerLabel";
import { KindGlyph, type GlyphSize } from "./KindGlyph";
import { glyphLabel } from "./kinds";

/**
 * THE LEAD RULE — the lead of every unit, on every surface, is one of three
 * things, and the page curl survives on exactly one of them.
 *
 *   PICTURE  the real thumbnail — image, video poster, link screenshot — in a
 *            rounded box, the extension as a CORNER LABEL inset top-left. No
 *            fold, no flap, no tab. (`Picture`)
 *   PAPER    a text-like artifact — document, Markdown, sheet, code — as a
 *            white paper sheet with its own words on it, the corner label
 *            top-left and the paper's small dog-ear top-right. (PaperSheet.tsx)
 *   GLYPH    nothing to show, or no room to show it: the kind glyph, the one
 *            object that keeps its folded corner, centred on the MONOCHROME
 *            well — a fill just lighter than the card, never a kind tint.
 *            (`KindWell`)
 *
 * Colour is the corner label on content, or the glyph on its grey well — one
 * place per unit, and nowhere else at rest. A missing or failed picture
 * falls back to the glyph, so the placeholder is never an empty box.
 */

const PLAY: Record<LabelSize, string> = { sm: "top-(--hy-play-y-sm) size-5", md: "top-1/2 size-9", lg: "top-1/2 size-11" };

/** The play mark on a video poster: white on a neutral scrim, never the kind hue. */
export function PlayMark({ size, className }: { size: LabelSize; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-(--hy-scrim) text-(--hy-on-kind)",
        PLAY[size],
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="size-1/2 translate-x-(--hy-play-nudge)">
        <path d="M7 4.6 19.4 12 7 19.4Z" fill="currentColor" stroke="currentColor" strokeWidth="3.4" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/**
 * PICTURE. The caller sets the box (`className`); the image fills it and can
 * never set its height. `fit="contain"` shows the whole picture on the mono
 * well (the panel, where it is judged). Children render over the image (a
 * duration, a play button).
 */
export function Picture({
  artifact,
  label,
  fit = "cover",
  play = true,
  className,
  onError,
  children,
}: {
  artifact: LabArtifact;
  label: LabelSize;
  fit?: "cover" | "contain";
  play?: boolean;
  className?: string;
  onError?: () => void;
  children?: ReactNode;
}) {
  // A cropped photograph keeps its middle; a cropped screenshot keeps its top-left, where a page starts.
  const crop = artifact.kind === "link" ? "object-cover object-left-top" : "object-cover";
  return (
    <span data-lead="picture" className={cn("relative block shrink-0 overflow-hidden rounded-(--hy-radius-glyph) bg-(--hy-well-mono)", className)}>
      <img src={artifact.thumbnailUrl} alt="" loading="lazy" onError={onError} className={cn("absolute inset-0 size-full", fit === "cover" ? crop : "object-contain")} />
      {artifact.kind === "video" && play ? <PlayMark size={label} /> : null}
      {children}
      <CornerLabel artifact={artifact} size={label} />
    </span>
  );
}

/** GLYPH. The glyph (curl kept) centred on the monochrome well; children sit beside it (a headline, a summary). */
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
    <div data-lead="well" className={cn("flex min-w-0 items-center justify-center gap-3 rounded-(--hy-radius-glyph) bg-(--hy-well-mono)", className)}>
      <KindGlyph kind={artifact.kind} label={glyphLabel(artifact)} size={size} className={glyphClassName} />
      {children}
    </div>
  );
}

// 72×46: the one lead box of a thread row, so every title starts on the same edge.
const ROW_BOX = "h-11.5 w-18 shrink-0";

/** The lead of a thread row: a picture when there is one; otherwise the xs glyph on the mono well (no room to show text here). */
export function Lead({ artifact }: { artifact: LabArtifact }) {
  const [failed, setFailed] = useState(false);
  if (!artifact.thumbnailUrl || failed) return <KindWell artifact={artifact} size="xs" className={ROW_BOX} />;
  return <Picture artifact={artifact} label="sm" className={ROW_BOX} onError={() => setFailed(true)} />;
}
