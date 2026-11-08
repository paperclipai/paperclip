import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { REVIEW_LABEL, REVIEW_VAR } from "./kind";

/**
 * State is a physical marker: a sticky flag in the status colour, stuck to an
 * edge and standing a little proud of it. The same flag on every surface —
 * `StateFlag` carries the word, `StateNub` is the same flag seen end-on, for
 * objects too small to carry type. Both have a 1px film edge (`--tac-flag-key`)
 * cut to the same shape, so the mark holds its outline on a dark tray and on
 * kraft, where the status colour alone is under 3:1.
 */

export type Review = "needs_review" | "changes_requested";

const flag = (review: Review, clip: string) => ({ "--tac-flag": REVIEW_VAR[review], clipPath: clip }) as CSSProperties;
const SHADOW = { filter: "var(--tac-flag-shadow)" } as const;
const KEY_FLAG = { clipPath: "var(--tac-clip-flag)" } as const;
const KEY_NUB = { clipPath: "var(--tac-clip-nub)" } as const;

export function StateFlag({ review, count, className }: { review: Review; /** On a divider: how many things under it carry this flag. */ count?: number; className?: string }) {
  return (
    <span className={cn("inline-block rotate-(--tac-tilt-flag)", className)} style={SHADOW} data-tac-flag={review}>
      <span className="block bg-(--tac-flag-key) p-px" style={KEY_FLAG}>
        <span
          className="relative flex h-(--tac-flag-h) items-center whitespace-nowrap bg-(--tac-flag) pl-3 pr-3.5 text-(length:--text-nano) font-semibold leading-none text-(--tac-flag-ink)"
          style={flag(review, "var(--tac-clip-flag)")}
        >
          {/* The gummed end. */}
          <span aria-hidden className="absolute inset-y-0 left-0 block w-1.5 bg-(--tac-flag-glue)" />
          {REVIEW_LABEL[review]}
          {count != null ? (
            <>
              <span aria-hidden className="px-1 opacity-70">
                ·
              </span>
              <span className="font-mono">{count}</span>
            </>
          ) : null}
        </span>
      </span>
    </span>
  );
}

/** The unlabelled flag: stands up from the top edge of a small object. Decorative; say the state in text nearby. */
export function StateNub({ review, className }: { review: Review; className?: string }) {
  return (
    <span aria-hidden className={cn("absolute -top-(--tac-nub-rise) block", className ?? "left-1/5")} style={SHADOW} data-tac-flag={review}>
      <span className="block bg-(--tac-flag-key) p-px" style={KEY_NUB}>
        <span className="block h-(--tac-nub-h) w-(--tac-nub-w) bg-(--tac-flag)" style={flag(review, "var(--tac-clip-nub)")} />
      </span>
    </span>
  );
}
