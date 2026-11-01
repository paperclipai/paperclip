import { Play } from "lucide-react";
import type { CSSProperties } from "react";
import type { LabArtifact } from "../../kit";
import { glyphOf, labelOf } from "./kinds";
import sheet from "./sheet-preview.svg";

/**
 * The 180×216 front sheets, measured from the mock. Both stand on the same
 * white sheet (the mock's two sheet vectors are the same path and fill).
 *
 * PreviewSheet — "Text Preview": the title in 15.25px semibold at (20, 28),
 * three lines at most, then four rows of placeholder text bars at (20, 98).
 * IconSheet — "Icon", redrawn to node 2205:138266: a 64px glyph centred at
 * (58, 58) in the faint ink, and the type centred across the sheet in 24px
 * bold at (0, 138). The PDF glyph is the mock's three bars; other types take
 * a lucide icon in the same faint ink. The inner stroke, the shadow and the
 * hover rise are the sheet wrapper's and did not change.
 */

const TITLE: CSSProperties = {
  left: 20,
  top: 28,
  width: 140.69,
  height: 54,
  fontSize: 15.248,
  lineHeight: "18px",
  letterSpacing: "-0.6172px",
  color: "var(--v1-paper-ink)",
};

// Each row is 7px tall on a 15px pitch; [x, width] within the 132px block.
const BAR_ROWS: Array<Array<[number, number]>> = [
  [
    [0, 31],
    [36, 54],
    [95, 10],
  ],
  [
    [0, 52],
    [57, 18],
    [80, 36],
  ],
  [
    [0, 43],
    [49, 52],
    [106, 26],
  ],
  [
    [0, 63],
    [68, 24],
    [97, 28],
  ],
];

function Bars() {
  return (
    <div aria-hidden className="absolute" style={{ left: 20, top: 98, width: 132, height: 52 }}>
      {BAR_ROWS.map((row, r) =>
        row.map(([x, width], i) => (
          <span
            key={`${r}-${i}`}
            className="absolute rounded-full"
            style={{ left: x, top: r * 15, width, height: 7, background: "var(--v1-ink-faint)" }}
          />
        )),
      )}
    </div>
  );
}

export function PreviewSheet({ artifact, title = artifact.title }: { artifact: LabArtifact; title?: string }) {
  return (
    <div className="v1-sheet relative shrink-0 overflow-clip">
      <img src={sheet} alt="" width={180} height={216} draggable={false} className="absolute inset-0 block" />
      <p className="absolute line-clamp-3 break-words font-semibold" style={TITLE} title={title}>
        {title}
      </p>
      <Bars />
    </div>
  );
}

/** The glyph box: 64px square, centred across the sheet at (58, 58). */
const GLYPH_BOX: CSSProperties = { left: 58, top: 58, width: 64, height: 64 };

/** The mock's PDF glyph: three bars, 12px tall on a 26px pitch, in the faint ink. */
function BarsGlyph() {
  return (
    <div aria-hidden className="absolute" style={GLYPH_BOX}>
      {[35, 64, 64].map((width, i) => (
        <span key={i} className="absolute left-0 rounded-full" style={{ top: i * 26, width, height: 12, background: "var(--v1-ink-faint)" }} />
      ))}
    </div>
  );
}

function Glyph({ artifact }: { artifact: LabArtifact }) {
  const glyph = glyphOf(artifact);
  if (glyph === "bars") return <BarsGlyph />;
  const Icon = glyph;
  return <Icon aria-hidden className="absolute" style={{ ...GLYPH_BOX, color: "var(--v1-ink-faint)" }} strokeWidth={2.5} />;
}

/** The type, centred across the sheet: 24px bold on a 54px line at y 138. */
const LABEL: CSSProperties = { left: 0, top: 138, width: 180, height: 54, fontSize: 24, lineHeight: "54px", textAlign: "center", color: "var(--v1-ink)" };

export function IconSheet({ artifact, play = false }: { artifact: LabArtifact; play?: boolean }) {
  return (
    <div className="v1-sheet relative shrink-0 overflow-clip">
      <img src={sheet} alt="" width={180} height={216} draggable={false} className="absolute inset-0 block" />
      <Glyph artifact={artifact} />
      <span className="absolute whitespace-nowrap font-bold" style={LABEL}>
        {labelOf(artifact)}
      </span>
      {play ? (
        // Media with nothing to preview keeps the play affordance the print would have had,
        // in the top-right corner, clear of the centred glyph (the disc's edge stays outside the glyph box).
        <span
          aria-hidden
          className="absolute flex items-center justify-center rounded-full"
          style={{ right: 20, top: 20, width: 44, height: 44, background: "var(--v1-ink)", color: "var(--v1-paper)" }}
        >
          <Play className="ml-0.5" style={{ width: 20, height: 20 }} fill="currentColor" strokeWidth={0} />
        </span>
      ) : null}
    </div>
  );
}
