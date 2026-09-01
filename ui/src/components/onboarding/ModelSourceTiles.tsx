import { useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

import { cn } from "../../lib/utils";
import { TAG_SWAP_ENTER, TAG_SWAP_EXIT, TAG_SWAP_TRAVEL } from "./onboarding-motion";

/**
 * The connect step's row of model sources, and the tag under each one saying
 * which credential the source would be reached with.
 *
 * Presentational only — the caller owns which source is picked and which
 * credential mode is in force, because both outlive this row: the mode is set
 * by a checkbox that sits below it, and the selection drives the step's CTA.
 */

/** How a source gets authenticated. Every tile is in the same mode at once. */
export type CredentialMode = "subscription" | "api";

export type ModelSource = {
  id: string;
  label: string;
  /** The brand mark, rendered into a 30px square. */
  icon: ReactNode;
};

const CREDENTIAL_TAG_LABEL: Record<CredentialMode, string> = {
  subscription: "Subscription",
  api: "API",
};

/**
 * The credential tag, swapping in a fixed-height slot.
 *
 * The slot has to hold its height whatever is in it: the tag is the last line
 * of the tile, and a label that measured itself would resize the tile mid-swap
 * and nudge the two beside it. `overflow-hidden` is doing real work too — it is
 * what makes the outgoing label fall out of frame rather than slide past the
 * tile's padding and over the row below.
 */
export function CredentialTag({ mode }: { mode: CredentialMode }) {
  return (
    <span className="relative flex h-4 w-full items-center justify-center overflow-hidden text-(length:--text-micro) text-muted-foreground">
      <AnimatePresence initial={false} mode="sync">
        <motion.span
          key={mode}
          className="absolute inset-0 flex items-center justify-center whitespace-nowrap"
          initial={{ opacity: 0, y: TAG_SWAP_TRAVEL }}
          animate={{ opacity: 1, y: 0, transition: TAG_SWAP_ENTER }}
          exit={{ opacity: 0, y: TAG_SWAP_TRAVEL, transition: TAG_SWAP_EXIT }}
        >
          {CREDENTIAL_TAG_LABEL[mode]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function ModelSourceTile({
  source,
  mode,
  selected,
  onSelect,
  buttonRef,
}: {
  source: ModelSource;
  mode: CredentialMode;
  selected: boolean;
  onSelect: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 flex-1 cursor-pointer flex-col items-center gap-1.5 self-stretch rounded-md border p-3",
        "transition-(--tp-border-color-background-color) duration-(--motion-duration-fast) ease-(--motion-ease-standard)",
        // Focus is a ring, never a border. The stroke has exactly one job here
        // and lending it to focus as well would mean tabbing across the row
        // looked like picking every tile in turn.
        "outline-none focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)",
        // Hover brings the surface up to the same half-strength ground the
        // selected tile already sits on, and stops there. Pointing at a tile
        // should say "this one is live", not "this one is chosen" — so the
        // bright stroke stays reserved for the choice, and the only thing
        // separating hover from selection is the border.
        selected ? "border-foreground bg-accent/50" : "border-border hover:bg-accent/50",
      )}
    >
      <span className="flex size-(--sz-30px) shrink-0 items-center justify-center">
        {source.icon}
      </span>
      {/*
        One step up the named ladder each — the source name from text-xs (12px)
        to --text-compact (13px), the tag under it from --text-nano (10px) to
        --text-micro (11px), keeping the two a step apart. Both use the
        font-size-only token form, so the line box comes from the tile's own
        rhythm rather than the Tailwind scale's paired line-height.
      */}
      <span className="text-(length:--text-compact) font-medium text-foreground">
        {source.label}
      </span>
      <CredentialTag mode={mode} />
    </button>
  );
}

export function ModelSourceTiles({
  sources,
  mode,
  selectedId,
  onSelect,
  label,
}: {
  sources: ModelSource[];
  mode: CredentialMode;
  /** `null` before anything has been picked — the step opens this way. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  label: string;
}) {
  const tiles = useRef(new Map<string, HTMLButtonElement>());

  /**
   * Arrow keys move the selection and the focus together, which is what a
   * radio group is expected to do — without it the role would be announced and
   * then not behave, which is worse than plain buttons. Selection wraps at both
   * ends; three tiles is short enough that stopping at the edges just reads as
   * the key having failed.
   */
  const moveSelection = (delta: number) => {
    if (sources.length === 0) return;
    const current = sources.findIndex((source) => source.id === selectedId);
    // Nothing picked yet: either arrow enters the row from the near end.
    const from = current === -1 ? (delta > 0 ? -1 : 0) : current;
    const next = (from + delta + sources.length) % sources.length;
    const target = sources[next]!;
    onSelect(target.id);
    tiles.current.get(target.id)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex items-start gap-3"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          moveSelection(1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          moveSelection(-1);
        }
      }}
    >
      {sources.map((source) => (
        <ModelSourceTile
          key={source.id}
          source={source}
          mode={mode}
          selected={source.id === selectedId}
          onSelect={() => onSelect(source.id)}
          buttonRef={(node) => {
            if (node) tiles.current.set(source.id, node);
            else tiles.current.delete(source.id);
          }}
        />
      ))}
    </div>
  );
}
