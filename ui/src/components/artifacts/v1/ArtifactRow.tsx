import type { CSSProperties, ReactNode } from "react";
import type { To } from "react-router-dom";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import panelDoc from "./assets/panel-doc.svg";
import panelDocCorner from "./assets/panel-doc-corner.svg";
import panelGlyphAudio from "./assets/panel-glyph-audio.svg";
import panelGlyphSlides from "./assets/panel-glyph-slides.svg";
import panelPlay from "./assets/panel-play.svg";
import { usePreviewFailure } from "./ArtifactPrint";
import { ROW_ICON, ROW_PLAY } from "./geometry";
import { glyphOf, isAudio, labelOf, previewSourceOf, treatmentOf, type ArtifactSubject } from "./kinds";
import { panelDateLabel } from "./when";

/**
 * One row, from the panel mock (node 2096:87691) and reused in the thread:
 * 8px padding, a 40px icon, 8px, then the file name (14/20 medium,
 * truncating before its extension) over "size · date" (12/16 muted), 6px
 * apart. The icon is the mock's grey document shape with its folded corner,
 * a 14px white glyph at (5, 5) and the type in 11px bold at (5, 22); PDF and
 * DOC use the mock's three bars, PPTX and audio the mock's own glyphs, other
 * types their lucide icon. Pictures and video show a 40px thumbnail instead,
 * video with a 32px play disc; a thumbnail that cannot be loaded gives way
 * to the document icon.
 */

const ICON_LABEL: CSSProperties = {
  left: ROW_ICON.label.left,
  top: ROW_ICON.label.top,
  fontSize: "var(--artifact-row-icon-label-size)",
  lineHeight: "var(--artifact-row-icon-label-leading)",
  color: "var(--artifact-row-ink)",
};

function Bars() {
  return (
    <span aria-hidden className="absolute flex flex-col gap-(--sz-3px)" style={{ left: ROW_ICON.glyph.left, top: ROW_ICON.glyph.top, width: ROW_ICON.glyph.size, height: ROW_ICON.glyph.size }}>
      {ROW_ICON.bars.widths.map((width, i) => (
        <span key={i} className="block h-(--sz-2px) rounded-full" style={{ width, background: "var(--artifact-row-ink)" }} />
      ))}
    </span>
  );
}

function IconGlyph({ subject }: { subject: ArtifactSubject }) {
  const { left, top, size } = ROW_ICON.glyph;
  if (isAudio(subject)) return <img src={panelGlyphAudio} alt="" width={size} height={size} className="absolute" style={{ left, top }} />;
  if (subject.kind === "slides") return <img src={panelGlyphSlides} alt="" width={size} height={12.667} className="absolute" style={{ left, top: top + 0.67 }} />;
  const glyph = glyphOf(subject);
  if (glyph === "bars" || subject.kind === "document") return <Bars />;
  const Icon = glyph;
  return <Icon aria-hidden className="absolute" style={{ left, top, width: size, height: size, color: "var(--artifact-row-ink)" }} strokeWidth={2} />;
}

/** The mock labels Markdown documents DOC; every other type is its extension. */
const iconLabel = (subject: ArtifactSubject) => (subject.kind === "document" ? "DOC" : labelOf(subject));

export function ArtifactRowIcon({ subject }: { subject: ArtifactSubject }) {
  return (
    <span className="relative block shrink-0" style={{ width: ROW_ICON.size, height: ROW_ICON.size }}>
      <img src={panelDoc} alt="" width={ROW_ICON.size} height={ROW_ICON.size} className="absolute left-0 top-0 block max-w-none" />
      <img src={panelDocCorner} alt="" width={ROW_ICON.corner.size} height={ROW_ICON.corner.size} className="absolute block max-w-none" style={{ left: ROW_ICON.corner.left, top: ROW_ICON.corner.top }} />
      <IconGlyph subject={subject} />
      <span className="absolute whitespace-nowrap font-bold" style={ICON_LABEL}>
        {iconLabel(subject)}
      </span>
    </span>
  );
}

function Thumbnail({ subject }: { subject: ArtifactSubject }) {
  const [failed, onError] = usePreviewFailure(previewSourceOf(subject));
  if (failed) return <ArtifactRowIcon subject={subject} />;
  return (
    <span className="relative block size-10 shrink-0 overflow-hidden rounded-(--sz-4px)">
      {subject.kind === "video" && !subject.thumbnailUrl ? (
        <video src={subject.videoUrl ?? undefined} className="absolute inset-0 h-full w-full object-cover" muted playsInline preload="metadata" onError={onError} />
      ) : (
        <img src={subject.thumbnailUrl ?? undefined} alt="" className="absolute inset-0 h-full w-full object-cover" onError={onError} />
      )}
      {subject.kind === "video" ? (
        <span aria-hidden className="absolute flex items-center justify-center rounded-full" style={{ left: ROW_PLAY.inset, top: ROW_PLAY.inset, width: ROW_PLAY.size, height: ROW_PLAY.size, background: "var(--artifact-play-scrim)" }}>
          <img src={panelPlay} alt="" width={ROW_PLAY.icon} height={ROW_PLAY.icon} className="block" style={{ marginLeft: 1 }} />
        </span>
      ) : null}
    </span>
  );
}

/** Splits "name.ext" so the name can truncate while the extension stays. */
export function splitName(name: string): [string, string] {
  const match = name.match(/^(.*?)(\.[a-z0-9]+)$/i);
  return match ? [match[1], match[2]] : [name, ""];
}

/** The row's fill, radius and padding; the inner control and the trailing controls sit inside it. */
export const ARTIFACT_ROW_CLASS = "flex w-full items-center gap-2 rounded-(--artifact-row-radius) bg-(--artifact-row) py-2 pl-2 pr-3 transition-colors hover:bg-(--artifact-row-hover)";
const CONTROL_CLASS = "flex min-w-0 flex-1 items-center gap-2 rounded-(--artifact-row-radius) text-left outline-none focus-visible:ring-2 focus-visible:ring-ring";

export interface ArtifactRowProps {
  subject: ArtifactSubject;
  to?: To;
  href?: string;
  /** With `href`: open in a new tab (a file) rather than in place (an in-app location). */
  external?: boolean;
  /**
   * Without `href`: the control is a button. With `href`: an ordinary click
   * runs this instead of following the link, while modifier clicks, the
   * context menu and copying the address keep working.
   */
  onClick?: () => void;
  /** Whether the row is expanded in place (the control reports it). */
  expanded?: boolean;
  /** Controls beside the name: a status, open, download, a menu. They sit outside the row's own control. */
  trailing?: ReactNode;
  className?: string;
  style?: CSSProperties;
  now?: Date;
  testId?: string;
}

/**
 * The row: the icon and the name over its facts are one control (a link, an
 * anchor or a button, as the caller needs); trailing controls stand beside
 * it, so nothing interactive nests.
 */
export function ArtifactRow({ subject, to, href, external = false, onClick, expanded, trailing, className, style, now, testId = "artifact-v1-row" }: ArtifactRowProps) {
  const name = subject.filename ?? subject.title;
  const [stem, ext] = splitName(name);
  const facts = [subject.sizeLabel, subject.updatedAt ? panelDateLabel(subject.updatedAt, now) : null].filter((fact): fact is string => Boolean(fact));
  const content = (
    <>
      {treatmentOf(subject) === "media" ? <Thumbnail subject={subject} /> : <ArtifactRowIcon subject={subject} />}
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex h-5 w-full text-sm font-medium leading-5 text-foreground" title={name}>
          <span className="min-w-0 truncate">{stem}</span>
          <span className="shrink-0">{ext}</span>
        </span>
        <span className="flex items-center gap-1 text-xs leading-4 text-muted-foreground">
          {facts.map((fact, i) => (
            <span key={fact} className="whitespace-nowrap">
              {i > 0 ? <span className="mr-1">·</span> : null}
              {fact}
            </span>
          ))}
        </span>
      </span>
    </>
  );
  const label = `Open ${name}`;
  const control = to ? (
    <Link to={to} aria-label={label} data-testid={`${testId}-open`} className={CONTROL_CLASS}>
      {content}
    </Link>
  ) : href ? (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      aria-label={label}
      data-testid={`${testId}-open`}
      className={CONTROL_CLASS}
      onClick={
        onClick
          ? (event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
              event.preventDefault();
              onClick();
            }
          : undefined
      }
    >
      {content}
    </a>
  ) : (
    <button type="button" aria-label={label} aria-expanded={expanded} onClick={onClick} data-testid={`${testId}-open`} className={CONTROL_CLASS}>
      {content}
    </button>
  );
  return (
    <div data-testid={testId} data-artifact-row className={cn(ARTIFACT_ROW_CLASS, className)} style={style}>
      {control}
      {trailing ? <span className="flex shrink-0 items-center gap-0.5">{trailing}</span> : null}
    </div>
  );
}

/** Several rows from one message, inline at equal widths 8px apart; a row needs 280px, so they wrap past three in a 960px column. */
export const ARTIFACT_ROW_MIN_WIDTH = 280;

export function ArtifactRowGroup({ children, testId = "artifact-v1-row-group" }: { children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="flex w-full flex-wrap gap-2">
      {children}
    </div>
  );
}

export const inlineRowStyle: CSSProperties = { flex: `1 0 ${ARTIFACT_ROW_MIN_WIDTH}px`, minWidth: 1 };
