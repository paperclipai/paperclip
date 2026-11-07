import { useState, type ReactNode } from "react";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { blockLabel, hasThumbnail, kindGlyph } from "./kinds";
import { SLAB_RING } from "./slab";

/**
 * SIGNATURE 1 — the kind block: the one inverted (INK) fill in the direction.
 *
 * One landscape plate (18:11) with the kind's mono-caps label in its
 * bottom-left corner and the kind's glyph in the opposite, top-right corner,
 * so both corners of the plate are used and kinds differ by shape as well as
 * by letters. It comes in three forms:
 *
 *   KindBlock  free-standing, the anchor of a row or a card:
 *                xs 56×36  attachments (label only)     sm 72×44  thread row, panel card
 *                lg 128×96 a picture in the attachments block (4:3: a picture's plate, beside a narrow column of text)
 *              Where the artifact has a picture, the picture fills the plate
 *              and nothing is laid over it (a video keeps a play mark); a
 *              picture that fails to load falls back to the ink plate, so a
 *              broken thumbnail is never an empty box.
 *   KindTag    the label alone, on an ink tab flush in the bottom-left corner
 *              of a preview that has content of its own (a picture, a sheet).
 *   KindDock   the block docked in that same corner for a preview that has
 *              none — the tab grown to a block: 72×44 in a mosaic cell, 131×80
 *              on a tile's plate (72×44 while the tile is under 18rem).
 *
 * Tabs and docks size themselves against the gallery unit they sit in (an
 * `@container/unit`: a tile, or a stack's face), never against the viewport.
 */

export type KindBlockSize = "xs" | "sm" | "lg";
type FaceSize = KindBlockSize | "plate";

const BOX: Record<FaceSize, string> = {
  xs: "h-9 w-14",
  sm: "h-11 w-18",
  lg: "h-24 w-32",
  plate: "h-11 w-18 @2xs/unit:h-20 @2xs/unit:w-auto @2xs/unit:aspect-(--solid-plate-ratio)",
};
const PAD: Record<FaceSize, string> = { xs: "p-1.5", sm: "px-2 py-1.5", lg: "p-3", plate: "px-2 py-1.5 @2xs/unit:p-3" };
/** The glyph sits in the top-right corner, at the plate's own inset. xs has no room for one. */
const GLYPH: Record<FaceSize, string | null> = {
  xs: null,
  sm: "top-1.5 right-2 size-5",
  lg: "top-3 right-3 size-7",
  plate: "top-1.5 right-2 size-5 @2xs/unit:top-3 @2xs/unit:right-3 @2xs/unit:size-7",
};
const LABEL: Record<FaceSize, string> = { xs: "text-xs", sm: "text-xs", lg: "text-lg", plate: "text-xs @2xs/unit:text-2xl" };

/** Mono caps. Always followed by a size and then `leading-none`: tailwind-merge drops a leading that precedes a font size. */
const MONO_CAPS = "font-mono font-semibold uppercase tracking-(--tracking-label)";

const INK = "bg-(--solid-ink) text-(--solid-ink-foreground)";
/** Ink laid over a preview is ringed with the slab fill (it follows the slab's steps), so it reads on a picture of any value. */
const RING = SLAB_RING;

function InkFace({ artifact, size }: { artifact: LabArtifact; size: FaceSize }) {
  const Glyph = kindGlyph(artifact);
  return (
    <>
      {GLYPH[size] ? <Glyph className={cn("absolute", GLYPH[size])} /> : null}
      <span className={cn(MONO_CAPS, LABEL[size], "leading-none")}>{blockLabel(artifact)}</span>
    </>
  );
}

/** A picture filling its (relative, overflow-hidden) parent. A page starts at its top-left; a photograph is about its centre. */
export function PlatePicture({ artifact, onError }: { artifact: LabArtifact; onError: () => void }) {
  return (
    <img
      src={artifact.thumbnailUrl}
      alt=""
      loading="lazy"
      onError={onError}
      className={cn("absolute inset-0 size-full object-cover", artifact.kind === "link" ? "object-left-top" : null)}
    />
  );
}

const TAG: Record<"sm" | "md", string> = { sm: "px-1.5 pb-1.5 pt-1", md: "px-2 pb-2 pt-1.5" };
const TAG_TEXT: Record<"sm" | "md", string> = { sm: "text-(length:--text-nano)", md: "text-(length:--text-micro)" };

/** An ink tab in the bottom-left corner of a preview. The parent must be `relative overflow-hidden`. */
export function CornerTag({ size = "md", className, children }: { size?: "sm" | "md"; className?: string; children: ReactNode }) {
  return (
    <span className={cn("absolute bottom-0 left-0 flex items-center gap-1 rounded-tr-md", INK, RING, TAG[size], MONO_CAPS, TAG_TEXT[size], "leading-none", className)}>
      {children}
    </span>
  );
}

/**
 * The kind's label on a corner tab; a video's carries a play mark.
 * `compact`: in a mosaic cell of a stack face narrower than 16rem, where there
 * is no room for letters, the tab shows the kind's glyph instead.
 */
export function KindTag({ artifact, size = "md", compact = false }: { artifact: LabArtifact; size?: "sm" | "md"; compact?: boolean }) {
  const Glyph = kindGlyph(artifact);
  return (
    <CornerTag size={size}>
      {artifact.kind === "video" ? <Play className="size-2" fill="currentColor" /> : null}
      {compact ? <Glyph className="size-3 @3xs/unit:hidden" /> : null}
      <span className={compact ? "hidden @3xs/unit:inline" : undefined}>{blockLabel(artifact)}</span>
    </CornerTag>
  );
}

/**
 * The kind block docked in the bottom-left corner of a sheet that has no
 * content of its own to show. `compact` as for the tab: a glyph-only square
 * where a mosaic cell has no room for the block.
 */
export function KindDock({ artifact, size = "plate", compact = false }: { artifact: LabArtifact; size?: "sm" | "plate"; compact?: boolean }) {
  const Glyph = kindGlyph(artifact);
  const dock = cn("absolute bottom-0 left-0 rounded-tr-md", INK, RING);
  return (
    <>
      {compact ? (
        <span data-kind-block="dock" className={cn(dock, "grid size-7 place-items-center @3xs/unit:hidden")}>
          <Glyph className="size-4" />
        </span>
      ) : null}
      <span data-kind-block="dock" className={cn(dock, "items-end", compact ? "hidden @3xs/unit:flex" : "flex", BOX[size], PAD[size])}>
        <InkFace artifact={artifact} size={size} />
      </span>
    </>
  );
}

export function KindBlock({
  artifact,
  size = "sm",
  ink = false,
  className,
}: {
  artifact: LabArtifact;
  size?: KindBlockSize;
  /** Always the ink plate, even when the artifact has a picture (a head that sits under the picture itself). */
  ink?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const box = cn("relative shrink-0 overflow-hidden rounded-md", BOX[size], className);

  if (hasThumbnail(artifact) && !failed && !ink) {
    return (
      <span aria-hidden className={cn(box, "block bg-(--solid-sheet)")} data-kind-block="picture">
        <PlatePicture artifact={artifact} onError={() => setFailed(true)} />
        {/* No kind tab on a picture this small: the meta line beside it says what it is. A video keeps its play mark. */}
        {artifact.kind === "video" ? (
          <CornerTag size="sm">
            <Play className="size-2.5" fill="currentColor" />
          </CornerTag>
        ) : null}
      </span>
    );
  }

  return (
    <span aria-hidden className={cn(box, "flex items-end", INK, PAD[size])} data-kind-block="ink">
      <InkFace artifact={artifact} size={size} />
    </span>
  );
}
