import { cn } from "@/lib/utils";
import type { LabKind } from "../../kit";
import { Pictogram } from "./Pictogram";

/**
 * SIGNATURE ELEMENT 1 — the kind glyph.
 *
 * A rounded tile with a folded top-right corner (a flat, lighter facet of the
 * same hue — never a shadow), a pictogram top-left and the real extension in
 * bold along the bottom. Solid `--kind` fill, flat. It is the one place a
 * unit carries its hue at full strength.
 *
 *   mini 16×18   pictogram only — index chips, kind tallies
 *   xs   34×38   thread: attachment slabs, and row leads on their tinted well
 *   sm   40×46   spare (specimen)
 *   md   56×64   panel leads on their tinted well; narrow gallery tiles
 *   lg   96×110  gallery tiles with nothing to show
 *   tuck 96×190  standing in a folder (StackFolder.tsx): the same top — fold,
 *                pictogram, label — on a tile tall enough that its bottom
 *                edge is always behind the pocket
 *
 * Without a `label` (a task document: it has no extension) the pictogram
 * stands alone, larger and centred — the mini glyph's composition at size.
 *
 * The ancestor that sets `data-kind` supplies `--kind`, `--kind-facet` and
 * `--kind-ink` (tokens.css); pass `kind` here only for the pictogram.
 */

export type GlyphSize = "mini" | "xs" | "sm" | "md" | "lg" | "tuck";

interface Placement {
  x: number;
  y: number;
  size: number;
}

interface Spec {
  w: number;
  h: number;
  /** Corner radius and fold size, in the tile's own px. */
  r: number;
  fold: number;
  picto: Placement;
  /** The pictogram when there is no label to share the tile with. */
  solo: Placement;
  label: { size: number; baseline: number; inset: number } | null;
  box: string;
}

const MINI: Placement = { x: 3.2, y: 5.6, size: 9.6 };
const SPEC: Record<GlyphSize, Spec> = {
  mini: { w: 16, h: 18, r: 3.5, fold: 5, picto: MINI, solo: MINI, label: null, box: "w-4 h-4.5" },
  xs: { w: 34, h: 38, r: 6, fold: 9.5, picto: { x: 4.5, y: 4.5, size: 10 }, solo: { x: 7.5, y: 12, size: 19 }, label: { size: 10, baseline: 32.2, inset: 3 }, box: "w-8.5 h-9.5" },
  sm: { w: 40, h: 46, r: 7, fold: 11.5, picto: { x: 5.5, y: 5.5, size: 14 }, solo: { x: 9, y: 14.5, size: 22 }, label: { size: 10.5, baseline: 39.2, inset: 4 }, box: "w-10 h-11.5" },
  md: { w: 56, h: 64, r: 9.5, fold: 16, picto: { x: 8, y: 8, size: 18 }, solo: { x: 12.5, y: 20, size: 31 }, label: { size: 14, baseline: 54.4, inset: 6 }, box: "w-14 h-16" },
  lg: { w: 96, h: 110, r: 16, fold: 27, picto: { x: 14, y: 14, size: 30 }, solo: { x: 22, y: 35, size: 52 }, label: { size: 23.5, baseline: 93.5, inset: 10 }, box: "w-24 h-27.5" },
  tuck: { w: 96, h: 190, r: 16, fold: 27, picto: { x: 13, y: 13, size: 26 }, solo: { x: 24, y: 30, size: 48 }, label: { size: 22, baseline: 68, inset: 10 }, box: "w-24 h-47.5" },
};

/** The tile with its top-right corner cut on the diagonal. */
function tilePath({ w, h, r, fold }: Spec): string {
  const k = r * 0.45; // softens the two ends of the cut
  return [
    `M${r} 0`,
    `H${w - fold - k}`,
    `Q${w - fold} 0 ${w - fold + k * 0.7} ${k * 0.7}`,
    `L${w - k * 0.7} ${fold - k * 0.7}`,
    `Q${w} ${fold} ${w} ${fold + k}`,
    `V${h - r}`,
    `Q${w} ${h} ${w - r} ${h}`,
    `H${r}`,
    `Q0 ${h} 0 ${h - r}`,
    `V${r}`,
    `Q0 0 ${r} 0Z`,
  ].join("");
}

/** The folded flap: the cut-off triangle laid back onto the tile, inner corner rounded. */
function facetPath({ w, r, fold }: Spec): string {
  const k = r * 0.45;
  const c = Math.min(r * 0.7, fold * 0.4);
  return [
    `M${w - fold} ${k * 0.6}`,
    `Q${w - fold} 0 ${w - fold + k * 0.7} ${k * 0.7}`,
    `L${w - k * 0.7} ${fold - k * 0.7}`,
    `Q${w} ${fold} ${w - k * 0.6} ${fold}`,
    `H${w - fold + c}`,
    `Q${w - fold} ${fold} ${w - fold} ${fold - c}Z`,
  ].join("");
}

// Inter Bold capitals, as a fraction of the font size — only to decide when a label must be squeezed.
const WIDE: Record<string, number> = { W: 0.99, M: 0.9, O: 0.78, Q: 0.78, G: 0.76, C: 0.73, D: 0.74, H: 0.74, N: 0.75, U: 0.73, I: 0.29, J: 0.56, L: 0.59, F: 0.61, E: 0.63, T: 0.64 };
const labelWidth = (label: string, size: number) => [...label].reduce((sum, ch) => sum + (WIDE[ch] ?? 0.68), 0) * size;

export function KindGlyph({ kind, label, size = "sm", className }: { kind: LabKind; label?: string; size?: GlyphSize; className?: string }) {
  const spec = SPEC[size];
  const text = spec.label && label ? label : null;
  const room = spec.label ? spec.w - spec.label.inset * 2 : 0;
  const squeeze = text && spec.label && labelWidth(text, spec.label.size) > room;
  return (
    <svg
      viewBox={`0 0 ${spec.w} ${spec.h}`}
      aria-hidden
      focusable="false"
      data-glyph={size}
      className={cn("block shrink-0 text-(--kind-ink)", spec.box, className)}
    >
      <path d={tilePath(spec)} className="fill-(--kind)" />
      <path d={facetPath(spec)} className="fill-(--kind-facet)" />
      <Pictogram kind={kind} {...(text ? spec.picto : spec.solo)} />
      {text && spec.label ? (
        <text
          x={spec.w / 2}
          y={spec.label.baseline}
          textAnchor="middle"
          fontSize={spec.label.size}
          fill="currentColor"
          className="font-sans font-bold"
          {...(squeeze ? { textLength: room, lengthAdjust: "spacingAndGlyphs" as const } : null)}
        >
          {text}
        </text>
      ) : null}
    </svg>
  );
}
