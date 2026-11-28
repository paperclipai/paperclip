import type { ReactNode } from "react";
import type { LabKind } from "../../kit";

/**
 * The ten white pictograms that sit on a kind glyph, drawn on a 24-unit grid
 * as solid shapes (the reference's weight), not hairline icons — they have to
 * read at 10px in the attachments strip. `currentColor` is the ink; anything
 * knocked out of a solid shape is filled with the unit's `--kind`.
 */

const ROUND = { stroke: "currentColor", strokeLinejoin: "round", strokeLinecap: "round" } as const;
const CUT = "fill-(--kind)";
const CUT_STROKE = "fill-none stroke-(--kind)";

const SHAPES: Record<LabKind, ReactNode> = {
  // Running text: two full lines and a short last one.
  document: (
    <>
      <rect x="2" y="3.5" width="20" height="3.6" rx="1.8" />
      <rect x="2" y="10.2" width="20" height="3.6" rx="1.8" />
      <rect x="2" y="16.9" width="12" height="3.6" rx="1.8" />
    </>
  ),
  // The reference's PDF mark: a short heading over a long line.
  pdf: (
    <>
      <rect x="2" y="5.5" width="11" height="4" rx="2" />
      <rect x="2" y="14" width="20" height="4" rx="2" />
    </>
  ),
  // A slide on its stand.
  slides: (
    <>
      <rect x="1.5" y="3" width="21" height="13.5" rx="2.6" />
      <rect x="10.4" y="16" width="3.2" height="4" />
      <rect x="6.5" y="19.2" width="11" height="2.8" rx="1.4" />
    </>
  ),
  // Four cells.
  sheet: (
    <>
      <rect x="2" y="2" width="9" height="9" rx="1.8" />
      <rect x="13" y="2" width="9" height="9" rx="1.8" />
      <rect x="2" y="13" width="9" height="9" rx="1.8" />
      <rect x="13" y="13" width="9" height="9" rx="1.8" />
    </>
  ),
  // Sun over two peaks.
  image: (
    <>
      <circle cx="6.2" cy="5.6" r="2.9" />
      <path d="M2 20.5 9.4 9.6l4 5.9 2.3-3.2 6.3 8.2Z" strokeWidth="1.6" {...ROUND} />
    </>
  ),
  // Play.
  video: <path d="M7 4.6 19.4 12 7 19.4Z" strokeWidth="3.4" {...ROUND} />,
  // A box with its lid and a pull slot.
  archive: (
    <>
      <rect x="1.5" y="3" width="21" height="5.6" rx="1.8" />
      <path d="M3.4 10.2h17.2v8.4a2.4 2.4 0 0 1-2.4 2.4H5.8a2.4 2.4 0 0 1-2.4-2.4Z" />
      <rect x="8.8" y="12.8" width="6.4" height="2.8" rx="1.4" className={CUT} />
    </>
  ),
  // Angle brackets.
  code: (
    <g fill="none" strokeWidth="3.2" {...ROUND}>
      <path d="M8.6 5.6 2.6 12l6 6.4" />
      <path d="M15.4 5.6l6 6.4-6 6.4" />
    </g>
  ),
  // The generic file: the product's paperclip.
  file: (
    <path
      d="m20.6 11.3-8.4 8.4a5.5 5.5 0 0 1-7.8-7.8l8.2-8.2a3.7 3.7 0 0 1 5.2 5.2l-8.2 8.2a1.85 1.85 0 0 1-2.6-2.6l7.6-7.6"
      fill="none"
      strokeWidth="2.6"
      {...ROUND}
    />
  ),
  // A globe: a solid disc with its meridian and equator knocked out.
  link: (
    <>
      <circle cx="12" cy="12" r="10.4" />
      <ellipse cx="12" cy="12" rx="4.4" ry="10.4" strokeWidth="1.9" className={CUT_STROKE} />
      <path d="M1.6 12h20.8" strokeWidth="1.9" className={CUT_STROKE} />
    </>
  ),
};

/** A pictogram placed inside a parent `<svg>`: `size` and the offset are in that SVG's units. */
export function Pictogram({ kind, x, y, size }: { kind: LabKind; x: number; y: number; size: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${size / 24})`} fill="currentColor">
      {SHAPES[kind]}
    </g>
  );
}
