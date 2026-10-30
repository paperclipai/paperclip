import { Fragment } from "react";
import type { LabArtifact } from "../../kit";
import { tallyOf } from "./gallery-model";

/**
 * GALLERY — what a stack holds, by kind: "Document 7 · Slides 3 · Image 3 …",
 * largest group first, counts in mono. On a folder's pocket (one line) and
 * under an opened stack's title (wrapping). Colour, size and wrapping come
 * from the caller.
 */
export function KindTally({ artifacts, className }: { artifacts: readonly LabArtifact[]; className?: string }) {
  const tally = tallyOf(artifacts);
  return (
    <span className={className} title={tally.map((entry) => `${entry.label} ${entry.count}`).join(" · ")}>
      {tally.map((entry, index) => (
        <Fragment key={entry.label}>
          {index > 0 ? (
            <span aria-hidden className="px-1.5 opacity-70">
              ·
            </span>
          ) : null}
          <span className="whitespace-nowrap">
            {entry.label} <span className="font-mono text-(length:--tac-mono-scale)">{entry.count}</span>
          </span>
        </Fragment>
      ))}
    </span>
  );
}
