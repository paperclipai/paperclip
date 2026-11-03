import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { CodeLines, ProseExcerpt, SheetTable } from "./Content";
import { KindGlyph } from "./KindGlyph";
import { Picture, PlayMark } from "./Lead";
import { PaperSheet } from "./PaperSheet";
import { MOTION } from "./UnitAction";
import { glyphLabel, hasTextPreview, headlineFact } from "./kinds";

/**
 * PANEL — the lead of a card: the WELL at the top of screen 10, by the lead
 * rule (Lead.tsx). A mono well across the card, 100px tall, with the object
 * standing in a 104px column at its left and what is known beside it:
 *
 *   paper    document, Markdown, sheet, code — the panel paper 24px in from
 *            the well's left edge and 8px down, its foot cut by the well's
 *            bottom edge; beside it, vertically centred, the artifact's own
 *            first lines in UI type — a document's opening in four lines, a
 *            sheet's header and first rows, a file's first lines of code.
 *   named    PDF, slides, archive, generic file, a picture that failed — the
 *            md glyph centred in the paper's column, and its FACTS beside it:
 *            the countable fact as a headline ("12 pages", else the size) and
 *            the size under it, both in mono and neither ever more than one
 *            line. The content type is the facts' tooltip, not a line of its
 *            own: a PPTX's ran to three wrapped lines, and at a 260px pane to
 *            ten, cut top and bottom. What the well says, the kind line does
 *            not repeat (PanelCard.tsx).
 *   picture  image, video poster, link screenshot — the picture is the well:
 *            full width, its own shape held between 4:3 and 16:9, shown whole
 *            (never cropped: this is where it is judged), corner label lg.
 *   video    plays in place: the poster is a real button (`PanelVideo`), and
 *            when the poster has failed the glyph's column on the named well
 *            is the button instead — the affordance never goes with the
 *            picture.
 *
 * Below a 20rem card the column narrows to 80px and the well's margins close
 * up, so the words keep two thirds of the width.
 */

type PanelLeadKind = "picture" | "paper" | "named";

export function panelLeadKind(a: LabArtifact, failed: boolean): PanelLeadKind {
  if (a.thumbnailUrl && !failed) return "picture";
  return hasTextPreview(a) ? "paper" : "named";
}

/** The well: the mono fill, the object's column at the left, the words' margin at the right. */
const WELL = "relative flex h-25 min-w-0 gap-6 overflow-hidden rounded-(--hy-radius-glyph) bg-(--hy-well-mono) pl-6 pr-3 @max-xs:gap-4 @max-xs:pl-4";
const COLUMN = "w-26 shrink-0 @max-xs:w-20";
/** The glyph's column with the well's left margin: where the play button goes on a named well. */
const COLUMN_HIT = "inset-y-0 left-6 w-26 @max-xs:left-4 @max-xs:w-20";
const MONO = "text-(length:--text-micro) leading-4";

/** The named well's facts: the headline (a count, else the size) and, under a count, the size. */
export function namedFacts(a: LabArtifact): string[] {
  const headline = headlineFact(a);
  if (!headline) return [];
  return a.sizeLabel && a.sizeLabel !== headline ? [headline, a.sizeLabel] : [headline];
}

/** The paper at the left of the well, its foot clipped by the well's edge; the first lines, centred, beside it. */
export function PanelPaper({ artifact }: { artifact: LabArtifact }) {
  return (
    <div data-lead="paper-well" className={WELL}>
      <PaperSheet artifact={artifact} size="panel" className={cn(COLUMN, "mt-2 self-start")} />
      <div className="my-auto min-w-0 flex-1 py-2">
        {artifact.kind === "document" ? (
          <ProseExcerpt artifact={artifact} maxChars={240} className="line-clamp-4 text-xs leading-4.5" />
        ) : artifact.kind === "sheet" ? (
          <SheetTable artifact={artifact} rows={3} className={MONO} />
        ) : (
          <CodeLines artifact={artifact} lines={5} className={MONO} />
        )}
      </div>
    </div>
  );
}

/** The glyph (the one curl left) centred in the paper's column, and the file's facts beside it; `children` lie over the well (a play button). */
export function PanelNamed({ artifact, children }: { artifact: LabArtifact; children?: ReactNode }) {
  const [headline, size] = namedFacts(artifact);
  return (
    <div data-lead="well" className={cn(WELL, "items-center")}>
      <span className={cn(COLUMN, "flex justify-center")}>
        <KindGlyph kind={artifact.kind} label={glyphLabel(artifact)} size="md" />
      </span>
      {headline ? (
        // A count and a size are machine values: the mono voice, the count at headline size. The content type is the tooltip.
        <div className="min-w-0 flex-1 py-2" title={artifact.contentType}>
          <p data-headline className="truncate font-mono text-sm font-medium leading-5 tracking-tight text-foreground">
            {headline}
          </p>
          {size ? (
            <p data-size className={cn("mt-0.5 truncate font-mono text-(--hy-ink-2)", MONO)}>
              {size}
            </p>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** The picture's own shape, held between 4:3 and 16:9; anything outside that is shown whole on the well. */
function pictureBox(aspect: number | undefined): string {
  if (aspect == null || aspect >= 1.7) return "aspect-video";
  return aspect >= 1.45 ? "aspect-3/2" : "aspect-4/3";
}

export function PanelPicture({ artifact, onError }: { artifact: LabArtifact; onError: () => void }) {
  return <Picture artifact={artifact} label="lg" fit="contain" play={false} className={cn("w-full", pictureBox(artifact.aspect))} onError={onError} />;
}

const PLAY_RING = "focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-(--hy-on-kind)";
const DURATION = "absolute bottom-2 right-2 rounded-(--rad-4) bg-(--hy-scrim) px-1.5 py-1 font-mono text-(length:--text-micro) leading-none text-(--hy-on-kind)";

/** The play button over a lead, above the card's stretched action. The disc is its visible state: it darkens under the pointer and grows while pressed. */
function PlayButton({ artifact, duration, onPlay, className }: { artifact: LabArtifact; duration: boolean; onPlay: () => void; className: string }) {
  return (
    <button type="button" aria-label={`Play video: ${artifact.title}`} onClick={onPlay} className={cn("group/play absolute z-10 cursor-pointer", PLAY_RING, className)}>
      <PlayMark size="lg" className={cn("group-hover/play:bg-(--hy-scrim-strong) group-active/play:scale-95", MOTION)} />
      {duration && artifact.durationLabel ? <span className={DURATION}>{artifact.durationLabel}</span> : null}
    </button>
  );
}

/** A video plays in place: over its poster, or over the glyph's column of the named well when the poster is missing or failed (the well's headline already says the duration). */
export function PanelVideo({ artifact, failed, onError }: { artifact: LabArtifact; failed: boolean; onError: () => void }) {
  const [playing, setPlaying] = useState(false);
  const poster = artifact.thumbnailUrl && !failed ? artifact.thumbnailUrl : undefined;
  const box = cn("w-full", pictureBox(artifact.aspect));
  if (playing && artifact.videoUrl) {
    // Above the card's stretched action, so the player's own controls work.
    return <video data-lead="player" src={artifact.videoUrl} poster={poster} controls autoPlay playsInline className={cn("relative z-10 rounded-(--hy-radius-glyph) bg-(--hy-well-mono) object-contain", box)} />;
  }
  const play = () => setPlaying(true);
  if (!poster) {
    return (
      <PanelNamed artifact={artifact}>
        <PlayButton artifact={artifact} duration={false} onPlay={play} className={COLUMN_HIT} />
      </PanelNamed>
    );
  }
  return (
    <Picture artifact={artifact} label="lg" fit="contain" play={false} className={box} onError={onError}>
      <PlayButton artifact={artifact} duration onPlay={play} className="inset-0" />
    </Picture>
  );
}
