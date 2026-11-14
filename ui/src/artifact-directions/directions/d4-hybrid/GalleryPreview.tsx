import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { CodeLines, ProseExcerpt, SheetTable } from "./Content";
import { FileName } from "./FileName";
import { KindWell, Picture } from "./Lead";
import { PaperSheet } from "./PaperSheet";
import { hasTextPreview, headlineFact, linkLabel } from "./kinds";

/**
 * GALLERY — the preview of one artifact, the largest object a tile has, by
 * the lead rule (Lead.tsx). Never an empty box:
 *
 *   picture  image, video poster, link screenshot — corner label lg, the
 *            play mark and duration on a video. No fold.
 *   paper    document, Markdown, sheet, code — the paper sheet standing at
 *            the left of the tile's mono well and running to its bottom edge
 *            (there is more below), with the document's own first lines
 *            beside it in UI type, as on the panel card (screen 10), and the
 *            filename under them
 *   named    PDF, slides, archive, generic file, or a picture that failed —
 *            the lg glyph on the mono well with what is known beside it: the
 *            countable fact as a headline ("12 slides", else the size), the
 *            summary, and the filename.
 *
 * The box is 16:9 and the tile is its `@container`.
 */

type PreviewKind = "picture" | "paper" | "named";

/** Which preview an artifact gets, and the handler that turns a failed picture into a named one. */
export function usePreviewKind(artifact: LabArtifact): [PreviewKind, () => void] {
  const [failed, setFailed] = useState(false);
  const kind: PreviewKind = artifact.thumbnailUrl && !failed ? "picture" : hasTextPreview(artifact) ? "paper" : "named";
  return [kind, () => setFailed(true)];
}

const BOX = "aspect-video w-full";
const WELL = "relative flex overflow-hidden rounded-(--hy-radius-glyph) bg-(--hy-well-mono) px-5 @max-xs:px-3.5";
const SMALL = "relative z-10 mt-1.5 cursor-text select-text text-(length:--text-micro) leading-4 text-(--hy-ink-2)";
const MONO = "text-(length:--text-micro) leading-4";

/** What is known beside the object: what the caller leads with, then the filename or address. */
function Words({ artifact, children }: { artifact: LabArtifact; children?: ReactNode }) {
  const address = linkLabel(artifact.url);
  if (!children && !artifact.filename && !address) return null;
  return (
    <div className="min-w-0 flex-1">
      {children}
      {artifact.filename ? (
        <FileName name={artifact.filename} className={SMALL} />
      ) : address ? (
        <span data-address className={cn("block truncate font-mono", SMALL)}>
          {address}
        </span>
      ) : null}
    </div>
  );
}

/** The document's own opening beside its paper: four lines of prose, a sheet's header and first rows, or six lines of code. */
function FirstLines({ artifact }: { artifact: LabArtifact }) {
  if (artifact.kind === "sheet") return <SheetTable artifact={artifact} rows={3} className={MONO} />;
  if (artifact.kind === "code") return <CodeLines artifact={artifact} lines={6} className={MONO} />;
  return <ProseExcerpt artifact={artifact} maxChars={240} className="line-clamp-4 text-xs leading-4.5" />;
}

function Paper({ artifact, className }: { artifact: LabArtifact; className?: string }) {
  return (
    <div data-lead="paper-well" className={cn(BOX, WELL, "gap-5 pt-5 @max-xs:gap-3.5 @max-xs:pt-3.5", className)}>
      {/* The sheet stands from the well's top padding to its bottom edge, where it is cut. */}
      <PaperSheet artifact={artifact} size="tile" className="aspect-auto self-stretch" />
      <div className="flex min-w-0 flex-1 items-center pb-5 @max-xs:pb-3.5">
        <Words artifact={artifact}>
          <FirstLines artifact={artifact} />
        </Words>
      </div>
    </div>
  );
}

function Named({ artifact, className }: { artifact: LabArtifact; className?: string }) {
  const headline = headlineFact(artifact);
  const words = Boolean(headline ?? artifact.summary ?? artifact.filename ?? linkLabel(artifact.url));
  return (
    <KindWell
      artifact={artifact}
      size="lg"
      // Below a 20rem tile the glyph steps down to md, so the words keep their room.
      glyphClassName="@max-xs:h-16 @max-xs:w-14"
      className={cn(BOX, WELL, "gap-4 @max-xs:gap-3", words ? "justify-start" : null, className)}
    >
      <Words artifact={artifact}>
        {/* A count is a machine value: the mono voice, at headline size. */}
        {headline ? <p data-headline className="truncate font-mono text-lg font-medium leading-6 tracking-tight text-foreground @max-xs:text-sm @max-xs:leading-5">{headline}</p> : null}
        {artifact.summary ? (
          <p data-summary className="mt-0.5 line-clamp-2 wrap-anywhere text-sm leading-5 text-foreground">
            {artifact.summary}
          </p>
        ) : null}
      </Words>
    </KindWell>
  );
}

const DURATION = "absolute bottom-2 right-2 rounded-(--rad-4) bg-(--hy-scrim) px-1.5 py-1 font-mono text-(length:--text-micro) leading-none text-(--hy-on-kind)";

export function GalleryPreview({ artifact, kind, onError, className }: { artifact: LabArtifact; kind: PreviewKind; onError: () => void; className?: string }) {
  if (kind === "paper") return <Paper artifact={artifact} className={className} />;
  if (kind === "named") return <Named artifact={artifact} className={className} />;
  return (
    <Picture artifact={artifact} label="lg" className={cn(BOX, className)} onError={onError}>
      {artifact.kind === "video" && artifact.durationLabel ? <span className={DURATION}>{artifact.durationLabel}</span> : null}
    </Picture>
  );
}
