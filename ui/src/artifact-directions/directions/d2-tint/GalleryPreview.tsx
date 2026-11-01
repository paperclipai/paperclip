import { useState } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { CodeLines, ProseExcerpt, SheetTable } from "./Content";
import { FileName } from "./FileName";
import { FoldedPreview, FoldedSheet, KindWell } from "./Lead";
import { hasTextPreview, headlineFact, linkLabel } from "./kinds";

/**
 * GALLERY — the preview of one artifact, the largest object a tile has, by
 * the one rule (Lead.tsx). Never an empty box:
 *
 *   picture  image, video poster, link screenshot — fold lg, extension tab,
 *            play mark and duration on a video
 *   sheet    document, Markdown, sheet, code — its own text at full width on
 *            a neutral sheet in the same frame (fold lg, tab). Clamped to
 *            whole lines for the tile's width, so nothing is sliced.
 *   named    PDF, slides, archive, generic file, or a picture that failed —
 *            the lg glyph on its kind well with what is known beside it: the
 *            countable fact as a headline ("12 slides", else the size), what
 *            the agent said is inside, and the filename. This replaces
 *            today's empty box that says FILE.
 *
 * The box is 16:9 and the tile is its `@container`. `depth="short"` is the
 * shallower box of a single-artifact stack, whose height the caller sets.
 */

type PreviewKind = "picture" | "sheet" | "named";
type PreviewDepth = "tile" | "short";

/** Which preview an artifact gets, and the handler that turns a failed picture into a named one. */
export function usePreviewKind(artifact: LabArtifact): [PreviewKind, () => void] {
  const [failed, setFailed] = useState(false);
  const kind: PreviewKind = artifact.thumbnailUrl && !failed ? "picture" : hasTextPreview(artifact) ? "sheet" : "named";
  return [kind, () => setFailed(true)];
}

const BOX = "aspect-video w-full";
const TEXT = "text-(length:--text-compact) leading-5";
const MONO = "text-(length:--text-micro) leading-5";
// Whole lines that fit a 16:9 sheet, by the tile's width: 20px lines under a 24px head, above the tab.
const CLAMP: Record<PreviewDepth, string> = { tile: "line-clamp-3 @3xs:line-clamp-4 @2xs:line-clamp-5 @xs:line-clamp-6 @sm:line-clamp-8", short: "line-clamp-4" };
const CODE_STEP = ["", "", "", "hidden @3xs:block", "hidden @2xs:block", "hidden @xs:block", "hidden @sm:block", "hidden @sm:block"];
const CODE_LINES: Record<PreviewDepth, number> = { tile: CODE_STEP.length, short: 4 };

/** Data rows that fit a 16:9 sheet whose text column is `width` wide: its lines, less the header and the "+N more" note. */
function rowsThatFit(width: number): number {
  const SIDE = 28; // the sheet's two side insets
  const HEAD_AND_TAB = 44; // top inset + the tab's height
  const lines = Math.floor((((width + SIDE) * 9) / 16 - HEAD_AND_TAB) / 20);
  return Math.max(1, lines - 2);
}

function Sheet({ artifact, depth, className }: { artifact: LabArtifact; depth: PreviewDepth; className?: string }) {
  return (
    <FoldedSheet artifact={artifact} fold="lg" className={cn(BOX, className)}>
      {artifact.kind === "document" ? (
        <ProseExcerpt artifact={artifact} maxChars={depth === "tile" ? 320 : 160} className={cn(TEXT, CLAMP[depth])} />
      ) : artifact.kind === "sheet" ? (
        <SheetTable artifact={artifact} rows={depth === "tile" ? rowsThatFit : 2} className={MONO} />
      ) : (
        <CodeLines artifact={artifact} lines={CODE_LINES[depth]} step={depth === "tile" ? CODE_STEP : undefined} className={MONO} />
      )}
    </FoldedSheet>
  );
}

function Named({ artifact, depth, className }: { artifact: LabArtifact; depth: PreviewDepth; className?: string }) {
  const headline = headlineFact(artifact);
  const address = linkLabel(artifact.url);
  const words = Boolean(headline ?? artifact.summary ?? artifact.filename ?? address);
  const small = "relative z-10 mt-1.5 cursor-text select-text text-(length:--text-micro) leading-4 text-(--tint-ink-2)";
  return (
    <KindWell
      artifact={artifact}
      size={depth === "tile" ? "lg" : "md"}
      // Below a 20rem tile the glyph steps down to md, so the words keep their room.
      glyphClassName={depth === "tile" ? "@max-xs:h-16 @max-xs:w-14" : undefined}
      className={cn(BOX, "gap-4 bg-(--kind-well-lg) px-5 @max-xs:gap-3 @max-xs:px-3.5", words ? "justify-start" : null, className)}
    >
      {words ? (
        <div className="min-w-0 flex-1">
          {/* A count is a machine value: the mono voice, at headline size. */}
          {headline ? <p data-headline className={cn("truncate font-mono font-medium tracking-tight text-foreground", depth === "tile" ? "text-lg leading-6 @max-xs:text-sm @max-xs:leading-5" : "text-sm leading-5")}>{headline}</p> : null}
          {artifact.summary ? (
            <p data-summary className={cn("mt-0.5 wrap-anywhere text-sm leading-5 text-foreground", depth === "tile" ? "line-clamp-2" : "line-clamp-1")}>
              {artifact.summary}
            </p>
          ) : null}
          {artifact.filename ? (
            <FileName name={artifact.filename} className={small} />
          ) : address ? (
            <span data-address className={cn("block truncate font-mono", small)}>
              {address}
            </span>
          ) : null}
        </div>
      ) : null}
    </KindWell>
  );
}

const DURATION = "absolute bottom-2 right-2 rounded-(--rad-4) bg-(--tint-scrim) px-1.5 py-1 font-mono text-(length:--text-micro) leading-none text-(--tint-on-kind)";

export function GalleryPreview({
  artifact,
  kind,
  onError,
  depth = "tile",
  className,
}: {
  artifact: LabArtifact;
  kind: PreviewKind;
  onError: () => void;
  depth?: PreviewDepth;
  className?: string;
}) {
  if (kind === "sheet") return <Sheet artifact={artifact} depth={depth} className={className} />;
  if (kind === "named") return <Named artifact={artifact} depth={depth} className={className} />;
  return (
    <FoldedPreview artifact={artifact} fold="lg" className={cn(BOX, className)} onError={onError}>
      {artifact.kind === "video" && artifact.durationLabel ? <span className={DURATION}>{artifact.durationLabel}</span> : null}
    </FoldedPreview>
  );
}
