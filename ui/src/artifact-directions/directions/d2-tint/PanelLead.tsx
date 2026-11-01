import { useState } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { CodeLines, ProseExcerpt, SheetTable } from "./Content";
import { FoldedPreview, FoldedSheet, KindWell, PlayMark } from "./Lead";
import { MOTION } from "./UnitAction";
import { hasTextPreview } from "./kinds";

/**
 * PANEL — the lead of a card, by the one rule (Lead.tsx):
 *
 *   picture  image, video poster, link screenshot — the full width of the
 *            card, the whole picture (never cropped: this is where it is
 *            judged), fold lg and tab. A video plays in place: the poster is
 *            a real button, and pressing it swaps in the player with controls.
 *   sheet    document, Markdown, sheet, code — the artifact's own text at full
 *            width on a neutral sheet, fold md and tab: five lines of a
 *            document, header + three rows of a sheet, five lines of code.
 *   named    PDF, slides, archive, generic file, a picture that failed — the md
 *            glyph on its kind well, 112px wide, as tall as the words beside it.
 */

type PanelLeadKind = "picture" | "sheet" | "named";

export function panelLeadKind(a: LabArtifact, failed: boolean): PanelLeadKind {
  if (a.thumbnailUrl && !failed) return "picture";
  return hasTextPreview(a) ? "sheet" : "named";
}

/** The picture's own shape, held between 4:3 and 16:9; anything outside that is shown whole on the neutral well. */
function pictureBox(aspect: number | undefined): string {
  if (aspect == null || aspect >= 1.7) return "aspect-video";
  return aspect >= 1.45 ? "aspect-3/2" : "aspect-4/3";
}

const PLAY_RING = "focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-(--tint-on-kind)";
const DURATION = "absolute bottom-2 right-2 rounded-(--rad-4) bg-(--tint-scrim) px-1.5 py-1 font-mono text-(length:--text-micro) leading-none text-(--tint-on-kind)";

export function PanelPicture({ artifact, onError }: { artifact: LabArtifact; onError: () => void }) {
  const [playing, setPlaying] = useState(false);
  const box = cn("w-full", pictureBox(artifact.aspect));
  const video = artifact.kind === "video";
  if (video && playing && artifact.videoUrl) {
    // Above the card's stretched action, so the player's own controls work.
    return <video data-lead="player" src={artifact.videoUrl} poster={artifact.thumbnailUrl} controls autoPlay playsInline className={cn("relative z-10 rounded-(--tint-radius-glyph) bg-(--tint-well) object-contain", box)} />;
  }
  return (
    <FoldedPreview artifact={artifact} fold="lg" fit="contain" play={false} className={cn(box, video ? "z-10" : null)} onError={onError}>
      {video ? (
        <button type="button" aria-label={`Play video: ${artifact.title}`} onClick={() => setPlaying(true)} className={cn("group/play absolute inset-0 cursor-pointer", PLAY_RING)}>
          {/* The disc is the button's visible state: it darkens under the pointer and grows while pressed. */}
          <PlayMark fold="lg" className={cn("group-hover/play:bg-(--tint-scrim-strong) group-active/play:scale-95", MOTION)} />
          {artifact.durationLabel ? <span className={DURATION}>{artifact.durationLabel}</span> : null}
        </button>
      ) : null}
    </FoldedPreview>
  );
}

const MONO = "text-(length:--text-micro) leading-4.5";

export function PanelSheet({ artifact }: { artifact: LabArtifact }) {
  return (
    <FoldedSheet artifact={artifact} fold="md">
      {artifact.kind === "document" ? (
        <ProseExcerpt artifact={artifact} maxChars={260} className="line-clamp-5 text-xs leading-4.5" />
      ) : artifact.kind === "sheet" ? (
        <SheetTable artifact={artifact} rows={3} className={MONO} />
      ) : (
        <CodeLines artifact={artifact} lines={5} className={MONO} />
      )}
    </FoldedSheet>
  );
}

/** 112px wide (80 in a pane dragged under about 23rem), and as tall as the card's words, so no card is taller than what it says. */
export function PanelNamed({ artifact }: { artifact: LabArtifact }) {
  return <KindWell artifact={artifact} size="md" className="min-h-21 w-28 shrink-0 self-stretch @max-xs:min-h-15 @max-xs:w-20" glyphClassName="@max-xs:h-11.5 @max-xs:w-10" />;
}
