import { Fragment } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { metaParts } from "./kinds";

/**
 * SIGNATURE 2 — the mono meta line: kind · size · rev · extent, in the
 * monospace token, in that order on every surface.
 */

/** The mono recipe for every machine value in the set: meta lines, filenames, stamps, counts, identifiers. */
export const META_TEXT = "font-mono text-(length:--text-micro) leading-4";

/** A set-width separator: a mono " · " is three cells wide and leaves the line gappy. */
export function MetaDot() {
  return <span className="px-1">·</span>;
}

/** A host and path may break after a slash; nothing else in a part may break. */
function breakable(part: string) {
  if (!part.includes("/")) return part;
  const pieces = part.split("/");
  return pieces.map((piece, index) => (
    <Fragment key={index}>
      {index > 0 ? <wbr /> : null}
      {index < pieces.length - 1 ? `${piece}/` : piece}
    </Fragment>
  ));
}

export function MetaLine({
  artifact,
  max,
  wrap = false,
  className,
}: {
  artifact: LabArtifact;
  /** Keep only the first `max` parts when the surface is short of room. */
  max?: number;
  /**
   * Let the line wrap (a panel card, a picture slab). It then breaks only
   * between parts — never inside "90.1 KB" — and after a slash in a path.
   * Off, the surface truncates it.
   */
  wrap?: boolean;
  className?: string;
}) {
  const parts = max ? metaParts(artifact).slice(0, max) : metaParts(artifact);
  return (
    <span className={cn(META_TEXT, "text-(--solid-meta)", className)}>
      {parts.map((part, index) =>
        wrap ? (
          // The separator travels with the part before it, so a wrapped line never starts with a dot.
          <Fragment key={part}>
            <span className={part.includes("/") ? "wrap-anywhere" : "whitespace-nowrap"}>
              {breakable(part)}
              {index < parts.length - 1 ? <MetaDot /> : null}
            </span>
            {index < parts.length - 1 ? <wbr /> : null}
          </Fragment>
        ) : (
          <Fragment key={part}>
            {index > 0 ? <MetaDot /> : null}
            {part}
          </Fragment>
        ),
      )}
    </span>
  );
}
