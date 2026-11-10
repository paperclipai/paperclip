import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { documentExcerpt, sheetPreview } from "./excerpt";

/**
 * What is INSIDE a text-like artifact, as bare content in the UI face — the
 * plain-text excerpt that sits BESIDE a paper sheet on a well (the panel
 * card, screen 10). What is printed ON the paper is PaperSheet.tsx's.
 *
 *   ProseExcerpt   a document's opening in two tiers: at most one heading on
 *                  its own line (foreground, medium), body lines in secondary
 *                  ink, list items each on a line behind a dash. One clamped
 *                  block, so it always ends on a whole line with an ellipsis.
 *   SheetTable     header + first rows, monospace; the first column truncates,
 *                  value columns keep their width; columns that do not fit the
 *                  measured width are counted, never clipped
 *   CodeLines      the first lines, monospace, each cut with an ellipsis
 */

export function ProseExcerpt({ artifact, maxChars, className }: { artifact: LabArtifact; maxChars?: number; className?: string }) {
  const lines = documentExcerpt(artifact, maxChars);
  if (lines.length === 0) return null;
  return (
    // Inline content with explicit breaks, so the line clamp counts every line of every tier.
    <p data-excerpt className={cn("wrap-anywhere text-(--hy-ink-2)", className)}>
      {lines.map((line, index) => (
        <Fragment key={index}>
          {index > 0 ? <br /> : null}
          {line.heading ? <span className="font-medium text-foreground">{line.text}</span> : line.item ? <>– {line.text}</> : line.text}
        </Fragment>
      ))}
    </p>
  );
}

/** How many monospace cells fit across an element, re-measured when it resizes. */
function useCells<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [fit, setFit] = useState<{ cells: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const probe = document.createElement("span");
      probe.textContent = "0000000000";
      probe.className = "invisible absolute whitespace-pre";
      el.append(probe);
      const cell = probe.getBoundingClientRect().width / 10;
      probe.remove();
      if (cell > 0) setFit({ cells: Math.floor(el.clientWidth / cell), width: el.clientWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, fit] as const;
}

const FIRST_CELL = "w-full max-w-0 truncate pr-2";
const VALUE_CELL = "whitespace-nowrap pl-3 text-right";

export function SheetTable({
  artifact,
  rows,
  className,
}: {
  artifact: LabArtifact;
  /** Rows to show: a number, or a function of the measured width in px (a fixed-height sheet shows fewer when it is narrow). */
  rows: number | ((width: number) => number);
  /** Type size and leading of the table. */
  className?: string;
}) {
  const [ref, fit] = useCells<HTMLDivElement>();
  const maxRows = typeof rows === "number" ? rows : rows(fit?.width ?? 0);
  // Before the first measurement only the name column is laid out, so nothing can spill for a frame.
  const preview = sheetPreview(artifact, maxRows, fit?.cells ?? 0);
  if (!preview) return null;
  const more = [
    preview.more > 0 ? `+${preview.more} more row${preview.more === 1 ? "" : "s"}` : null,
    preview.moreColumns > 0 ? `+${preview.moreColumns} more column${preview.moreColumns === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return (
    <div ref={ref} data-excerpt className={cn("relative min-w-0 overflow-hidden font-mono", className)}>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="text-(--hy-ink-2)">
            {preview.header.map((cell, index) => (
              <th key={index} scope="col" className={cn("font-normal", index === 0 ? FIRST_CELL : VALUE_CELL)}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-foreground">
          {preview.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, index) => (
                <td key={index} className={index === 0 ? FIRST_CELL : VALUE_CELL}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {more.length > 0 ? <p className="truncate text-(--hy-ink-2)">{more.join(" · ")}</p> : null}
    </div>
  );
}

export function CodeLines({
  artifact,
  lines,
  step,
  className,
}: {
  artifact: LabArtifact;
  lines: number;
  /** Per-line classes, by index — a fixed-height sheet hides its last lines in a narrow unit instead of slicing one. */
  step?: readonly string[];
  className?: string;
}) {
  if (!artifact.excerpt) return null;
  return (
    <pre data-excerpt className={cn("overflow-hidden font-mono text-(--hy-ink-2)", className)}>
      {artifact.excerpt
        .split("\n")
        .slice(0, lines)
        .map((line, index) => (
          <span key={index} className={cn("block overflow-hidden text-ellipsis whitespace-pre", step?.[index])}>
            {line || " "}
          </span>
        ))}
    </pre>
  );
}
