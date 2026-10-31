/**
 * The V1 artwork's measurements, from the PCLP-Core mocks (node
 * 2129:133457, 2205:138266) as verified in the artifact directions lab.
 * Positions are in CSS pixels inside the pieces they belong to; colours,
 * radii, shadows and type are tokens (index.css, --artifact-*).
 */

/** A front sheet: 180 × 216. */
export const SHEET = { width: 180, height: 216 } as const;

/** "Text Preview": the title block and the placeholder text bars. */
export const PREVIEW_TITLE = { left: 20, top: 28, width: 140.69, height: 54 } as const;
export const PREVIEW_BARS = { left: 20, top: 98, width: 132, height: 52, pitch: 15, barHeight: 7 } as const;
/** Each row of bars: [x, width] within the block. */
export const PREVIEW_BAR_ROWS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[0, 31], [36, 54], [95, 10]],
  [[0, 52], [57, 18], [80, 36]],
  [[0, 43], [49, 52], [106, 26]],
  [[0, 63], [68, 24], [97, 28]],
];

/** "Icon": a 64px glyph box centred at (58, 58), the type centred across the sheet at y 138. */
export const ICON_GLYPH = { left: 58, top: 58, size: 64 } as const;
/** The mock's PDF glyph: three bars, 12px tall on a 26px pitch, widths 35/64/64. */
export const ICON_BARS = { widths: [35, 64, 64] as const, height: 12, pitch: 26 } as const;
export const ICON_LABEL = { top: 138, height: 54 } as const;
/** Audio's play disc, top-right, clear of the centred glyph. */
export const ICON_PLAY = { inset: 20, size: 44, icon: 20 } as const;

/** A print fits a box while keeping its picture's ratio, border included. */
export interface FitBox { maxWidth: number; maxHeight: number; border: number }
/** On its own in the 254px frame (mock: 240×180 and 180×240). */
export const SINGLE_BOX: FitBox = { maxWidth: 240, maxHeight: 240, border: 4 };
/** As the first page of a stack (mock: 245×183 and 167×220). */
export const STACK_BOX: FitBox = { maxWidth: 245, maxHeight: 220, border: 3.3 };
export const DEFAULT_ASPECT = 4 / 3;
export const PRINT_PLAY = { size: 44, icon: 20 } as const;

/** A backing page: the SVG file, where the sheet sits inside it, the centre of its rotated box, its angle, and its side when fanned. */
export interface BackingPlacement {
  file: "short" | "tallA" | "tallB";
  width: number;
  height: number;
  sheet: { left: number; top: number; width: number; height: number };
  centre: { x: number; y: number };
  rotate: number;
  spread: "left" | "right";
}

// Sheet backing (text and documents): composition 254.25 × 241.04.
export const SHEET_COMPOSITION = { width: 254.253, height: 241.044 } as const;
export const SHEET_BACKING: BackingPlacement[] = [
  { file: "short", width: 240.409, height: 247.814, sheet: { left: 30, top: 26.6, width: 180.409, height: 187.814 }, centre: { x: 7.13 + 220.486 / 2, y: 225.88 / 2 }, rotate: -14, spread: "left" },
];
/** Its second layer is a plain landscape sheet, 239.5 × 179.6, turned −5°. */
export const LANDSCAPE_SHEET = { width: 239.509, height: 179.632, centre: { x: 254.253 / 2, y: 33.5 + 199.823 / 2 }, rotate: -5, spread: "right" as const };
export const SHEET_FRONT = { left: 37.13, top: 25.04 } as const;

// Media backing (pictures, video, audio): two tall sheets, painted right first then left.
export const MEDIA_BACKING: BackingPlacement[] = [
  { file: "tallA", width: 240.409, height: 276.151, sheet: { left: 30, top: 26.6, width: 180.409, height: 216.151 }, centre: { x: 55.73 + 195.048 / 2, y: 12.13 + 228.209 / 2 + 2 }, rotate: 4, spread: "right" },
  { file: "tallB", width: 240.409, height: 276.151, sheet: { left: 30, top: 26.6, width: 180.409, height: 216.151 }, centre: { x: 207.544 / 2, y: 238.217 / 2 }, rotate: -7.64, spread: "left" },
];
export const MEDIA_COMPOSITION = { width: 55.73 + 195.048, height: 240.337 } as const;
/** Where the first page is centred: landscape prints on one point, portrait prints and sheets on another. */
export const MEDIA_ANCHOR = { landscape: { x: 16.76 + 245.003 / 2, y: 35.32 + 183.002 / 2 }, portrait: { x: 44.39 + 167 / 2, y: 11.34 + 220 / 2 } } as const;

/** The row's 40px document icon: the folded corner and the glyph and label positions. */
export const ROW_ICON = { size: 40, corner: { left: 30.41, top: 0.41, size: 9.195 }, glyph: { left: 5, top: 5, size: 14 }, label: { left: 5, top: 22 }, bars: { widths: [7, 14, 14] as const, height: 2 } } as const;
export const ROW_PLAY = { inset: 4, size: 32, icon: 16 } as const;
