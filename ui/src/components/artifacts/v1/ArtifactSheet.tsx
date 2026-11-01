import { Play } from "lucide-react";
import type { CSSProperties } from "react";
import sheet from "./assets/sheet-preview.svg";
import { ICON_BARS, ICON_GLYPH, ICON_LABEL, ICON_PLAY, PREVIEW_BAR_ROWS, PREVIEW_BARS, PREVIEW_TITLE, SHEET } from "./geometry";
import { glyphOf, labelOf, type ArtifactSubject } from "./kinds";

/**
 * The 180×216 front sheets. PreviewSheet sets the title on the paper over
 * four rows of placeholder text; IconSheet centres a faint glyph and the
 * type in caps. Both stand on the same white sheet; the inner stroke and
 * the shadow are the `.artifact-sheet` rules (index.css).
 */

const TITLE: CSSProperties = {
  ...PREVIEW_TITLE,
  fontSize: "var(--artifact-sheet-title-size)",
  lineHeight: "var(--artifact-sheet-title-leading)",
  letterSpacing: "var(--artifact-sheet-title-tracking)",
  color: "var(--artifact-paper-ink)",
};

function TextBars() {
  return (
    <div aria-hidden className="absolute" style={{ left: PREVIEW_BARS.left, top: PREVIEW_BARS.top, width: PREVIEW_BARS.width, height: PREVIEW_BARS.height }}>
      {PREVIEW_BAR_ROWS.map((row, r) =>
        row.map(([x, width], i) => (
          <span
            key={`${r}-${i}`}
            className="absolute rounded-full"
            style={{ left: x, top: r * PREVIEW_BARS.pitch, width, height: PREVIEW_BARS.barHeight, background: "var(--artifact-ink-faint)" }}
          />
        )),
      )}
    </div>
  );
}

function Paper() {
  return <img src={sheet} alt="" width={SHEET.width} height={SHEET.height} draggable={false} className="absolute inset-0 block" />;
}

export function PreviewSheet({ subject, title = subject.title }: { subject: ArtifactSubject; title?: string }) {
  return (
    <div className="artifact-sheet relative shrink-0 overflow-clip" data-artifact-sheet="preview">
      <Paper />
      <p className="absolute line-clamp-3 break-words font-semibold" style={TITLE} title={title}>
        {title}
      </p>
      <TextBars />
    </div>
  );
}

const GLYPH_BOX: CSSProperties = { left: ICON_GLYPH.left, top: ICON_GLYPH.top, width: ICON_GLYPH.size, height: ICON_GLYPH.size };

function BarsGlyph() {
  return (
    <div aria-hidden className="absolute" style={GLYPH_BOX}>
      {ICON_BARS.widths.map((width, i) => (
        <span key={i} className="absolute left-0 rounded-full" style={{ top: i * ICON_BARS.pitch, width, height: ICON_BARS.height, background: "var(--artifact-ink-faint)" }} />
      ))}
    </div>
  );
}

function Glyph({ subject }: { subject: ArtifactSubject }) {
  const glyph = glyphOf(subject);
  if (glyph === "bars") return <BarsGlyph />;
  const Icon = glyph;
  return <Icon aria-hidden className="absolute" style={{ ...GLYPH_BOX, color: "var(--artifact-ink-faint)" }} strokeWidth={2.5} />;
}

const LABEL: CSSProperties = {
  left: 0,
  top: ICON_LABEL.top,
  width: SHEET.width,
  height: ICON_LABEL.height,
  fontSize: "var(--artifact-icon-label-size)",
  lineHeight: "var(--artifact-icon-label-leading)",
  textAlign: "center",
  color: "var(--artifact-ink)",
};

export function IconSheet({ subject, play = false }: { subject: ArtifactSubject; play?: boolean }) {
  return (
    <div className="artifact-sheet relative shrink-0 overflow-clip" data-artifact-sheet="icon">
      <Paper />
      <Glyph subject={subject} />
      <span className="absolute whitespace-nowrap font-bold" style={LABEL}>
        {labelOf(subject)}
      </span>
      {play ? (
        <span
          aria-hidden
          className="absolute flex items-center justify-center rounded-full"
          style={{ right: ICON_PLAY.inset, top: ICON_PLAY.inset, width: ICON_PLAY.size, height: ICON_PLAY.size, background: "var(--artifact-ink)", color: "var(--artifact-paper)" }}
        >
          <Play className="ml-0.5" style={{ width: ICON_PLAY.icon, height: ICON_PLAY.icon }} fill="currentColor" strokeWidth={0} />
        </span>
      ) : null}
    </div>
  );
}
