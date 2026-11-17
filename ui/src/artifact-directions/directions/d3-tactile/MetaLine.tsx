import { Fragment } from "react";
import { cn } from "@/lib/utils";
import type { MetaPart } from "./kind";

/**
 * "PDF · 57.7 KB · 12 pages": the kind in the UI face, machine values (sizes,
 * revisions, counts, hosts) in mono, separated by a middle dot. Colour and
 * size come from the caller.
 */
export function MetaLine({ parts, className }: { parts: MetaPart[]; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-baseline whitespace-nowrap", className)}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span aria-hidden className="px-1 opacity-70">
              ·
            </span>
          ) : null}
          {/* Mono runs a size smaller (0.92em) so it sits level with the UI face beside it. */}
          <span className={cn(index === parts.length - 1 && "truncate")}>
            {part.lead ? `${part.lead} ` : null}
            <span className={cn(part.mono && "font-mono text-(length:--tac-mono-scale)")}>{part.text}</span>
            {part.unit ? ` ${part.unit}` : null}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
