/**
 * An exactly-centered plus for the map/roadmap create buttons — the "+" text
 * glyph sits above optical center in the box, an SVG doesn't.
 */
export function PlusGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" style={{ display: "block" }}>
      <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
