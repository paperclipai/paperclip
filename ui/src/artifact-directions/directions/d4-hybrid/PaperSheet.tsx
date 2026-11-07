import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { CornerLabel, type LabelSize } from "./CornerLabel";
import { glyphLabel } from "./kinds";
import { paperCode, paperPage, paperRows } from "./paper-text";

/**
 * THE PAPER SHEET — Tactile's sheet, straightened and brought into Tint's
 * containers. A text-like artifact (document, Markdown, sheet, code) as a
 * sheet of off-white paper with its own words typeset on it: a document in
 * serif, its heading heavier, its body lighter, fading toward the bottom
 * edge; a sheet's header and rows, a file's code, in mono. The top-right
 * corner is dog-eared (a small paper fold — part of the paper, never a
 * coloured flap); the extension is the corner label, inset top-left.
 *
 * Zero rotation, no floating label or flag of any kind, no drop shadow: the
 * sheet is lit by its hairline edge and its fold alone. The sheet is
 * decorative to assistive technology (`aria-hidden`): the unit's title, meta
 * line and the excerpt beside the sheet carry the words; where the sheet is
 * the only copy (a single stack), the caller adds an sr-only excerpt.
 *
 * The page is Tactile's 240 × 310 sheet, kept at that proportion and SIZED BY
 * ITS WIDTH: the sheet is a container, and everything printed on it is set
 * in cqw (tokens.css, group 5), so the same page lays out identically at
 * 100px and at 150px — small sheets get fewer, larger words, as Tactile's do.
 * The caller gives the width (`className`), and may clip the foot (a well's
 * bottom edge, a folder's pocket). A thread row has no room for a sheet: its
 * lead stays the glyph (Lead.tsx).
 *
 *   panel   104px   standing at the left of the panel card's well, foot clipped (screen 10)
 *   tuck    column  standing in a folder's mouth, foot behind the pocket (`h-full aspect-auto`)
 *   tile    44%     standing at the left of a gallery tile's well, running to its bottom
 *                   edge (`aspect-auto`) — or whole, at its own proportion, at the left of
 *                   a single-artifact stack's slab (screen 5); `--hy-paper-tile-w`
 */

type PaperSize = "panel" | "tuck" | "tile";

const WIDTH: Record<PaperSize, string> = { panel: "w-26", tuck: "w-full", tile: "w-(--hy-paper-tile-w)" };
const LABEL: Record<PaperSize, LabelSize> = { panel: "md", tuck: "md", tile: "md" };

const FADE = { maskImage: "var(--hy-pg-fade)" } as const;
const INK_2 = "text-(--hy-paper-ink-2)";

/** The dog-ear's clearance: the first line of print wraps round the fold. */
const EarClear = () => <span aria-hidden className="float-right block size-(--hy-pg-ear-clear)" />;

function Prose({ artifact }: { artifact: LabArtifact }) {
  const { title, lines } = paperPage(artifact);
  return (
    <span className="block text-(length:--hy-pg-body) leading-(--hy-pg-lead-body)">
      <span className="block text-(length:--hy-pg-title) font-semibold leading-(--hy-pg-lead-title) tracking-tight text-(--hy-paper-ink)">{title}</span>
      <span className={cn("mt-(--hy-pg-gap) block", INK_2)}>
        {lines.length > 0 ? (
          lines.map((line, index) =>
            line.kind === "heading" ? (
              <span key={index} className="mt-(--hy-pg-gap) block font-semibold text-(--hy-paper-ink)">
                {line.text}
              </span>
            ) : line.kind === "item" ? (
              <span key={index} className="mt-(--hy-pg-gap-para) flex gap-(--hy-pg-gap-para)">
                <span>•</span>
                <span className="min-w-0">{line.text}</span>
              </span>
            ) : (
              <span key={index} className="mt-(--hy-pg-gap-para) block first:mt-0">
                {line.text}
              </span>
            ),
          )
        ) : artifact.summary ? (
          <span className="block italic">{artifact.summary}</span>
        ) : null}
      </span>
    </span>
  );
}

/** A sheet's header and first rows: hairline rules in the paper's own grey, the header heavier. */
function Rows({ artifact }: { artifact: LabArtifact }) {
  const data = paperRows(artifact);
  if (!data) return <Prose artifact={artifact} />;
  const cell = "whitespace-nowrap pr-(--hy-pg-gap) align-top";
  return (
    <table className="w-full border-collapse text-left font-mono text-(length:--hy-pg-mono) leading-(--hy-pg-lead-body) text-(--hy-paper-ink)">
      <thead>
        <tr className="border-b-(length:--hy-pg-rule) border-(--hy-paper-rule)">
          {data.header.map((text, index) => (
            <th key={index} scope="col" className={cn(cell, "font-semibold")}>
              {text}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className={INK_2}>
        {data.rows.map((row, r) => (
          <tr key={r} className="border-b-(length:--hy-pg-rule) border-(--hy-paper-rule)">
            {row.map((text, index) => (
              <td key={index} className={cell}>
                {text}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A code file's first lines, indentation kept; each line clipped by the sheet's edge. */
function Code({ artifact }: { artifact: LabArtifact }) {
  const lines = paperCode(artifact);
  if (lines.length === 0) return <Prose artifact={artifact} />;
  return (
    <span className="block font-mono text-(length:--hy-pg-mono) leading-(--hy-pg-lead-body) text-(--hy-paper-ink)">
      {lines.map((line, index) => (
        <span key={index} className="block overflow-hidden whitespace-pre">
          {line || " "}
        </span>
      ))}
    </span>
  );
}

export function PaperSheet({
  artifact,
  size,
  label = true,
  className,
}: {
  artifact: LabArtifact;
  size: PaperSize;
  /** The corner label (the extension); a task document never has one. */
  label?: boolean;
  /** Width, and `h-full aspect-auto` where the sheet fills a box instead of keeping its proportion. */
  className?: string;
}) {
  const labelled = label && Boolean(glyphLabel(artifact));
  const mono = artifact.kind === "sheet" || artifact.kind === "code";
  return (
    <span data-paper={size} data-lead="paper" aria-hidden className={cn("@container relative block aspect-(--hy-pg-aspect) shrink-0 select-none", WIDTH[size], className)}>
      <span
        className="absolute inset-0 block overflow-hidden rounded-(--hy-pg-r) bg-(--hy-paper) bg-(image:--hy-paper-grain) shadow-(--hy-paper-edge)"
        style={{ clipPath: "var(--hy-pg-clip-ear)" }}
      >
        {/* Print starts under the corner label when there is one, so no word sits behind it. */}
        <span
          className={cn("absolute inset-0 block break-words px-(--hy-pg-pad) pt-(--hy-pg-pad)", mono ? null : "font-(family-name:--hy-font-serif)", labelled ? "pt-(--hy-pg-pad-labelled)" : null)}
          style={FADE}
        >
          <EarClear />
          {artifact.kind === "sheet" ? <Rows artifact={artifact} /> : artifact.kind === "code" ? <Code artifact={artifact} /> : <Prose artifact={artifact} />}
        </span>
      </span>
      {/* The dog-ear: the cut corner laid back onto the sheet, lit from the top-left. */}
      <span aria-hidden className="pointer-events-none absolute right-0 top-0 block size-(--hy-pg-ear)" style={{ filter: "var(--hy-paper-fold-shadow)" }}>
        <span className="block size-full bg-(image:--hy-paper-fold)" style={{ clipPath: "var(--hy-pg-clip-fold)" }} />
      </span>
      {label ? <CornerLabel artifact={artifact} size={LABEL[size]} className="rounded-tl-(--hy-pg-r)" /> : null}
    </span>
  );
}
