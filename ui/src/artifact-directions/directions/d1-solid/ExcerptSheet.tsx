import { Fragment } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { KindTag } from "./KindBlock";

/**
 * The preview for kinds whose preview is TEXT — task documents, Markdown, code
 * and sheets — at panel and gallery scale: the artifact's own words set as
 * real text on a SHEET, the lightest fill short of ink in both themes (paper
 * on a mat), so content is the filled thing and never a recess.
 *
 *   prose   sans; the opening line and every heading in foreground medium,
 *           body in the sheet's text tone
 *   code    the mono token, whitespace kept, a long line ends in an ellipsis
 *   sheet   a table in the mono token, header row in foreground; whole columns
 *           only, as many as the sheet is wide enough for, the rest counted
 *           ("+2 cols")
 *
 * Three shapes:
 *   plate   (default) a gallery preview: the kind tab in the bottom-left
 *           corner, prose at 13px, as many WHOLE lines as the plate's height
 *           has room for above the tab (--solid-sheet-fit) — at any column
 *           width, never a fixed count.
 *   cell    a small cell of a stack mosaic: the same at 11px, 8px inset.
 *   drawer  a panel card's preview: no tab (the card's kind block is right
 *           above it), height set by `lines`, 12px inset like the slab.
 *
 * The thread never uses this: at 72×44 a text kind is an ink plate.
 * No fade at the bottom edge (no gradients in this direction).
 */

const CLAMP = { 3: "line-clamp-3", 6: "line-clamp-6" } as const;

/** Whether an artifact's preview is its text (a picture always wins). */
export const hasExcerpt = (a: LabArtifact) => Boolean(a.excerpt) && !a.thumbnailUrl;

const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const paragraphs = (a: LabArtifact) => (a.body ?? a.excerpt ?? "").trim().split(/\n{2,}/);
const HEADING = /^#{1,6}\s+/;

/** Markdown to the text a sheet sets: bullets kept as bullets, link and emphasis syntax dropped. */
const inline = (markdown: string) =>
  markdown
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "");

/** Whether the text opens with the artifact's own title, which the surface already prints beside the sheet. */
const opensWithTitle = (a: LabArtifact) => words(paragraphs(a)[0].replace(HEADING, "")) === words(a.title);

interface Run {
  text: string;
  strong: boolean;
  /** What separates it from the run before: a new line, or a space within the same paragraph. */
  lead: "\n" | " ";
}

/**
 * The prose as runs. The repeated title is left out; headings are strong; and
 * the sheet always opens on a strong line — a short opening paragraph whole,
 * a long one by its first sentence.
 */
function runs(a: LabArtifact): Run[] {
  const all = paragraphs(a);
  const blocks = (opensWithTitle(a) && all.length > 1 ? all.slice(1) : all).slice(0, 10);
  const out: Run[] = blocks.map((block) => ({ text: inline(block.replace(HEADING, "")), strong: HEADING.test(block), lead: "\n" }));
  const first = out[0];
  if (!first || first.strong) return out;
  const sentence = first.text.length > 90 ? /^(.+?[.!?])\s+([\s\S]+)$/.exec(first.text) : null;
  if (!sentence) return [{ ...first, strong: true }, ...out.slice(1)];
  return [{ text: sentence[1], strong: true, lead: "\n" }, { text: sentence[2], strong: false, lead: " " }, ...out.slice(1)];
}

const SHEET_TEXT = "text-(--solid-sheet-text)";
/**
 * Code and tables: 11px on 16px in a drawer or a mosaic cell; a size up on a
 * tile's plate, which is read from further away (as prose is) — from 16rem of
 * sheet, so the large cell of a mosaic keeps the smaller size and its columns.
 */
const MONO = "font-mono text-(length:--text-micro) leading-4";
const MONO_PLATE = "font-mono text-(length:--text-micro) leading-4 @3xs:text-xs @3xs:leading-5";

/**
 * Columns are shown whole or not at all. How many is decided by the width of
 * the sheet itself (its own container, inside its inset), so a table never
 * runs out of its sheet: two, a third from 18rem, a fourth from 24rem, a fifth
 * from 32rem. A mosaic cell shows the first column only. What is left out is
 * counted in the header row.
 */
const COLUMN = ["", "", "hidden @2xs:table-cell", "hidden @sm:table-cell", "hidden @lg:table-cell"];
const SHOWN = [
  { columns: 2, when: "@2xs:hidden" },
  { columns: 3, when: "hidden @2xs:table-cell @sm:hidden" },
  { columns: 4, when: "hidden @sm:table-cell @lg:hidden" },
  { columns: 5, when: "hidden @lg:table-cell" },
];

function Table({ csv, rows, single, mono, className }: { csv: string; rows: number; single: boolean; mono: string; className?: string }) {
  const [head, ...body] = csv
    .trim()
    .split("\n")
    .slice(0, rows)
    .map((line) => line.split(",").slice(0, single ? 1 : COLUMN.length));
  const total = csv.trim().split("\n")[0].split(",").length;
  const notes = single ? [{ columns: 1, when: "" }] : SHOWN;
  return (
    <div className={cn(mono, SHEET_TEXT, "overflow-hidden", className)}>
      <table className="w-full table-fixed">
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th key={index} scope="col" className={cn("truncate pr-2 text-left font-medium text-foreground", COLUMN[index])}>
                {cell}
              </th>
            ))}
            {notes.map((note) =>
              total > note.columns ? (
                <th key={note.columns} className={cn("w-7 text-right font-normal whitespace-nowrap @2xs:w-14", note.when)}>
                  +{total - note.columns}
                  <span className="hidden @2xs:inline"> {total - note.columns === 1 ? "col" : "cols"}</span>
                </th>
              ) : null,
            )}
          </tr>
        </thead>
        <tbody>
          {body.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (
                <td key={column} className={cn("truncate pr-2", COLUMN[column])}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExcerptSheet({
  artifact,
  shape = "plate",
  lines = 3,
  className,
}: {
  artifact: LabArtifact;
  shape?: "plate" | "cell" | "drawer";
  /** A drawer's depth in whole lines of prose (code and tables get one more row: their lines are shorter). */
  lines?: keyof typeof CLAMP;
  /** Sizing. A plate or a cell fills what it is given; a drawer is as tall as its lines. */
  className?: string;
}) {
  const text = artifact.excerpt ?? "";
  const drawer = shape === "drawer";
  const cell = shape === "cell";
  const fit = drawer ? null : "max-h-(--solid-sheet-fit) overflow-hidden";
  // A drawer shows a set number of rows; a fitted sheet is given more than it can hold and keeps whole ones.
  const rows = drawer ? lines + 1 : 14;
  const mono = shape === "plate" ? MONO_PLATE : MONO;
  return (
    <div
      aria-hidden
      data-solid="excerpt-sheet"
      data-solid-sheet={drawer ? undefined : "fit"}
      // A drawer is a container too (by width only), so its table can count its columns the same way.
      className={cn("relative overflow-hidden rounded-md bg-(--solid-sheet)", drawer ? "@container px-3 py-2.5" : cell ? "p-2" : "p-4", className ?? "w-full")}
    >
      {artifact.kind === "sheet" ? (
        <Table csv={text} rows={rows} single={cell} mono={mono} className={fit ?? undefined} />
      ) : artifact.kind === "code" ? (
        <div className={cn(mono, SHEET_TEXT, fit)}>
          {text
            .split("\n")
            .slice(0, rows)
            .map((line, index) => (
              <span key={index} className="block overflow-hidden text-ellipsis whitespace-pre">
                {line || " "}
              </span>
            ))}
        </div>
      ) : (
        // The size comes first: tailwind-merge drops a `leading-*` that precedes a font size.
        <div
          className={cn(
            drawer ? "text-xs leading-5" : cell ? "text-(length:--text-micro) leading-4" : "text-(length:--text-compact) leading-5",
            "wrap-break-word whitespace-pre-line",
            SHEET_TEXT,
            drawer ? CLAMP[lines] : fit,
          )}
        >
          {runs(artifact).map((run, index) => (
            <Fragment key={index}>
              {index > 0 ? run.lead : null}
              {run.strong ? <span className="font-medium text-foreground">{run.text}</span> : run.text}
            </Fragment>
          ))}
        </div>
      )}
      {drawer ? null : <KindTag artifact={artifact} size={cell ? "sm" : "md"} compact={cell} />}
    </div>
  );
}
