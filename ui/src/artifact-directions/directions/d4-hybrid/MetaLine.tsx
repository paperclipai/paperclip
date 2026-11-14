import { Fragment } from "react";
import { cn } from "@/lib/utils";

/**
 * SIGNATURE ELEMENT 2 — the mono meta line.
 *
 * One grammar on every surface — kind · size · rev — set in the monospace
 * token because every part of it is a machine value. Never coloured: the hue
 * belongs to the lead.
 *
 * One line with an ellipsis by default. `wrap` lets it break between parts
 * instead, where the product's rule is that facts wrap rather than disappear
 * (a narrow pane, a narrow folder).
 */
export function MetaLine({ parts, wrap = false, className }: { parts: string[]; wrap?: boolean; className?: string }) {
  return (
    <span data-meta className={cn("block font-mono text-(length:--text-micro) leading-4 text-(--hy-ink-2)", wrap ? "min-w-0" : "truncate", className)}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {/* A full monospace " · " is three cells wide; the dot gets half-cell margins instead. */}
          {index > 0 ? <span className="mx-(--hy-meta-gap)">·</span> : null}
          {/* When wrapping, a part never breaks inside itself; the line breaks after a dot. */}
          {index > 0 && wrap ? <wbr /> : null}
          <span className={wrap ? "whitespace-nowrap" : undefined}>{part}</span>
        </Fragment>
      ))}
    </span>
  );
}
