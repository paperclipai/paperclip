import { useState } from "react";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { ExcerptSheet } from "./ExcerptSheet";
import { previewKind } from "./gallery-model";
import { extent, fileName, metaLabel } from "./kinds";
import { CornerTag, KindDock, KindTag, PlatePicture } from "./KindBlock";
import { META_TEXT } from "./MetaLine";
import { StateMarker } from "./StateMarker";

/**
 * GALLERY — the preview of one artifact. Every kind gets a preview that says
 * something, and what fills it is the artifact's CONTENT, never its extension:
 *
 *   picture   the picture, full-bleed                       ink kind tab bottom-left
 *   text      its own words on a sheet (ExcerptSheet)       ink kind tab bottom-left
 *   facts     a sheet that says what is known of a file     the kind block docked bottom-left:
 *             with nothing to show: how much of it there    the tab grown to a block, because
 *             is, at display size, and its filename         here the kind is most of the story
 *
 * So ink is always the mark in the bottom-left corner and never the whole
 * plate; a row of previews keeps one baseline of ink, and three decks in a row
 * read as three decks. The other corner is the state: a bite the slab takes
 * out of the bottom-right (StateMarker). A picture that fails to load becomes
 * the facts sheet and says "No preview".
 *
 * `plate` is a tile's preview (18:11 at the width of its container) and the
 * large cell of a stack mosaic; `cell` is a mosaic's small cell.
 */

function Facts({ artifact, cell, note }: { artifact: LabArtifact; cell: boolean; note?: string }) {
  const fact = note ?? extent(artifact) ?? artifact.sizeLabel ?? metaLabel(artifact);
  if (cell) {
    return (
      <div aria-hidden className="relative size-full overflow-hidden rounded-md bg-(--solid-sheet) p-2">
        <p className={cn(META_TEXT, "truncate font-medium text-foreground")}>{fact}</p>
        <KindDock artifact={artifact} size="sm" compact />
      </div>
    );
  }
  return (
    <div aria-hidden className="relative size-full overflow-hidden rounded-md bg-(--solid-sheet) p-3 @2xs/unit:p-4">
      <p className="truncate text-xl font-medium tracking-tight text-foreground @2xs/unit:text-3xl">{fact}</p>
      {/* One line where the dock leaves room for one; two from 20rem of tile. */}
      <p className="mt-0.5 truncate text-sm font-medium text-(--solid-sheet-text) @xs/unit:line-clamp-2 @xs/unit:wrap-anywhere @xs/unit:whitespace-normal">
        {fileName(artifact)}
      </p>
      <KindDock artifact={artifact} size="plate" />
    </div>
  );
}

export function GalleryPreview({
  artifact,
  scale = "plate",
  state = true,
  className,
}: {
  artifact: LabArtifact;
  scale?: "plate" | "cell";
  /** Show the state bite. Off inside a stack mosaic, where the stack's count line carries state. */
  state?: boolean;
  /** Sizing; the plate's 18:11 at the width of its container by default. */
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const kind = failed ? "facts" : previewKind(artifact);
  const cell = scale === "cell";
  return (
    <div
      data-solid="gallery-preview"
      data-preview={kind}
      className={cn("relative overflow-hidden rounded-md", className ?? "aspect-(--solid-plate-ratio) w-full")}
    >
      {kind === "text" ? (
        <ExcerptSheet artifact={artifact} shape={cell ? "cell" : "plate"} className="size-full" />
      ) : kind === "picture" ? (
        <span aria-hidden className="absolute inset-0 bg-(--solid-sheet)">
          <PlatePicture artifact={artifact} onError={() => setFailed(true)} />
          {/* In a mosaic the tab is on the large cell only: three tabs on three photographs spend the signature where it says least. */}
          {cell ? (
            artifact.kind === "video" ? (
              <CornerTag size="sm">
                <Play className="size-2.5" fill="currentColor" />
              </CornerTag>
            ) : null
          ) : (
            <KindTag artifact={artifact} />
          )}
        </span>
      ) : (
        <Facts artifact={artifact} cell={cell} note={failed ? "No preview" : undefined} />
      )}
      {state ? <StateMarker review={artifact.review} on="corner" /> : null}
    </div>
  );
}
