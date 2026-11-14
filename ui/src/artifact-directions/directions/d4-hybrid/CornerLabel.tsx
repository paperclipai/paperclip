import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { glyphLabel } from "./kinds";

/**
 * THE CORNER LABEL — the kind's one mark on real content.
 *
 * A small solid block in the kind hue, INSET in the top-left corner of a
 * preview (a picture, a paper sheet), carrying the real extension in bold:
 * PNG, HTML, CSV, MD, PDF — URL for a link. Its outer corner follows the
 * preview's own radius; its inner corner is the app's smallest. It replaces
 * both of Tint's marks on content — the folded flap and the bottom-left tab —
 * so real content has one mark, in one place, and no page curl.
 *
 * A task document has no extension and so no label (Tint's rule: it is the
 * product's own document, not a file). The ink is `--kind-ink`: white on
 * every hue but amber, where it is near-black — 4.5:1 or better, per theme.
 *
 *   sm  10px type   the thread row's 72×46 lead
 *   md  11px type   an attachment picture, every paper sheet but the thread's, a folder's picture
 *   lg  12px type   a gallery tile's picture, the panel's picture
 */

export type LabelSize = "sm" | "md" | "lg";

// The line-height sits AFTER the size: tailwind-merge drops a leading that precedes a font size.
const SIZE: Record<LabelSize, string> = {
  sm: "px-1 py-0.5 text-(length:--text-nano) leading-none",
  md: "px-1.5 py-1 text-(length:--text-micro) leading-none",
  lg: "px-2 py-1 text-xs leading-none",
};

export function CornerLabel({ artifact, size, className }: { artifact: LabArtifact; size: LabelSize; className?: string }) {
  const label = glyphLabel(artifact);
  if (!label) return null;
  return (
    <span
      data-corner-label
      className={cn("pointer-events-none absolute left-0 top-0 z-10 rounded-tl-(--hy-radius-glyph) rounded-br-(--rad-4) bg-(--kind) font-sans font-bold text-(--kind-ink)", SIZE[size], className)}
    >
      {label}
    </span>
  );
}
