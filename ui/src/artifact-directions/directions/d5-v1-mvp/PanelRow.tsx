import type { CSSProperties } from "react";
import type { LabArtifact } from "../../kit";
import { glyphOf, isAudio, labelOf, treatmentOf } from "./kinds";
import panelDoc from "./panel-doc.svg";
import panelDocCorner from "./panel-doc-corner.svg";
import panelGlyphAudio from "./panel-glyph-audio.svg";
import panelGlyphSlides from "./panel-glyph-slides.svg";
import panelPlay from "./panel-play.svg";
import { panelDateLabel } from "./when";

/**
 * One row of the side panel's Artifacts tab, measured from the mock
 * (node 2096:87691): 8px padding, a 40px icon, 8px, then the file name
 * (14/20 medium, truncating before its extension) over "size · date"
 * (12/16 muted), 6px apart (the mock's 2 plus 4, on request — which makes the
 * row 58px rather than the mock's 56). The thread (node 2096:86523) uses the same row, so the
 * button itself is exported as ArtifactRow for the thread to group inline.
 *
 * The icon is the mock's grey document shape with its folded corner, a 14px
 * white glyph at (5, 5) and the type in 11px bold at (5, 22); PDF and DOC use
 * the mock's three bars, PPTX and MP3 the mock's own glyphs, other types their
 * lucide icon. Pictures and video show a 40px thumbnail instead, video with a
 * 32px play disc.
 */

const ICON_LABEL: CSSProperties = { left: 5, top: 22, fontSize: 11, lineHeight: "15px", color: "var(--v1-row-ink)" };

function Bars() {
  return (
    <span aria-hidden className="absolute flex flex-col gap-[3px]" style={{ left: 5, top: 5, width: 14, height: 14 }}>
      {[7, 14, 14].map((width, i) => (
        <span key={i} className="block h-[2px] rounded-full" style={{ width, background: "var(--v1-row-ink)" }} />
      ))}
    </span>
  );
}

function IconGlyph({ artifact }: { artifact: LabArtifact }) {
  if (isAudio(artifact)) return <img src={panelGlyphAudio} alt="" width={14} height={14} className="absolute" style={{ left: 5, top: 5 }} />;
  if (artifact.kind === "slides") return <img src={panelGlyphSlides} alt="" width={14} height={12.667} className="absolute" style={{ left: 5, top: 5.67 }} />;
  const glyph = glyphOf(artifact);
  if (glyph === "bars" || artifact.kind === "document") return <Bars />;
  const Icon = glyph;
  return <Icon aria-hidden className="absolute" style={{ left: 5, top: 5, width: 14, height: 14, color: "var(--v1-row-ink)" }} strokeWidth={2} />;
}

/** The mock labels Markdown documents DOC; every other type is its extension. */
const iconLabel = (artifact: LabArtifact) => (artifact.kind === "document" ? "DOC" : labelOf(artifact));

function DocIcon({ artifact }: { artifact: LabArtifact }) {
  return (
    <span className="relative block shrink-0" style={{ width: 40.002, height: 40 }}>
      <img src={panelDoc} alt="" width={40.002} height={40} className="absolute left-0 top-0 block max-w-none" />
      <img src={panelDocCorner} alt="" width={9.195} height={9.195} className="absolute block max-w-none" style={{ left: 30.41, top: 0.41 }} />
      <IconGlyph artifact={artifact} />
      <span className="absolute whitespace-nowrap font-bold" style={ICON_LABEL}>
        {iconLabel(artifact)}
      </span>
    </span>
  );
}

function Thumbnail({ artifact }: { artifact: LabArtifact }) {
  return (
    <span className="relative block size-10 shrink-0 overflow-hidden rounded-[4px]">
      <img src={artifact.thumbnailUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      {artifact.kind === "video" ? (
        <span aria-hidden className="absolute flex size-8 items-center justify-center rounded-full" style={{ left: 4, top: 4, background: "var(--v1-play-scrim)" }}>
          <img src={panelPlay} alt="" width={16} height={16} className="block" style={{ marginLeft: 1 }} />
        </span>
      ) : null}
    </span>
  );
}

/** Splits "name.ext" so the name can truncate while the extension stays. */
function splitName(name: string): [string, string] {
  const match = name.match(/^(.*?)(\.[a-z0-9]+)$/i);
  return match ? [match[1], match[2]] : [name, ""];
}

/** The row on its own: a button the caller places in a list item or an inline group. */
export function ArtifactRow({ artifact, className, style }: { artifact: LabArtifact; className?: string; style?: CSSProperties }) {
  const name = artifact.filename ?? artifact.title;
  const [stem, ext] = splitName(name);
  const facts = [artifact.sizeLabel, panelDateLabel(artifact.updatedAt)].filter((fact): fact is string => Boolean(fact));
  return (
    <button
      type="button"
      aria-label={`Open ${name}`}
      className={`flex w-full items-center gap-2 rounded-(--v1-row-radius) bg-(--v1-row) py-2 pl-2 pr-3 text-left outline-none transition-colors hover:bg-(--v1-row-hover) focus-visible:ring-2 focus-visible:ring-ring${className ? ` ${className}` : ""}`}
      style={style}
    >
      {treatmentOf(artifact) === "media" ? <Thumbnail artifact={artifact} /> : <DocIcon artifact={artifact} />}
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
    </button>
  );
}

export function PanelRow({ artifact }: { artifact: LabArtifact }) {
  return (
    <li>
      <ArtifactRow artifact={artifact} />
    </li>
  );
}
