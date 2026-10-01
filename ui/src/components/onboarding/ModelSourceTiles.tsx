import { useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

import { cn } from "../../lib/utils";
import {
  SOURCE_EXIT_FADE,
  SOURCE_COLLAPSE_MOVE,
  TAG_SWAP_ENTER,
  TAG_SWAP_EXIT,
  TAG_SWAP_TRAVEL,
} from "./onboarding-motion";

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
  settling,
}: {
  source: ModelSource;
  mode: CredentialMode;
  selected: boolean;
  onSelect: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
  settling: boolean;
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
        // Longer while the row is settling back to its default. Dropping the
        // selection is the last thing that happens on the way out, and at the
        // interaction duration it landed as a colour swap after everything else
        // had stopped — a cut rather than a release. Across the tile's travel
        // it reads as the choice being let go.
        "transition-(--tp-border-color-background-color) ease-(--motion-ease-standard)",
        settling ? "duration-(--motion-duration-slow)" : "duration-(--motion-duration-fast)",
        // Focus is a ring, never a border. The stroke has exactly one job here
        // and lending it to focus as well would mean tabbing across the row
        // looked like picking every tile in turn.
        "outline-none focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)",
        // Selection is a lighter surface *and* a brighter edge. An earlier pass
        // here used the fill alone, reasoning that a bright stroke on one tile
        // made the row read as one outlined object beside a plain one. The
        // design does both, and it is right: at these sizes one step of fill is
        // too quiet to answer "which did I pick?" from across the screen, and
        // the stroke is what carries it.
        //
        // Hover stops short of the selected fill, so pointing at a tile says
        // "this one is live" rather than "this one is chosen".
        selected
          ? "border-foreground/40 bg-accent"
          : "border-border bg-card hover:bg-accent/40",
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
  collapsed = false,
  settling = false,
}: {
  sources: ModelSource[];
  mode: CredentialMode;
  /** `null` before anything has been picked — the step opens this way. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  label: string;
  /**
   * Show only the chosen source, centred.
   *
   * The row is a question, and once a sign-in is running it has been answered —
   * leaving the alternative on screen invites a press that would have to cancel
   * a live server session to honour. Collapsing says the choice is made without
   * disabling anything, which reads better than a greyed-out tile.
   */
  collapsed?: boolean;
  /**
   * The row is returning to its default. Only changes how long the selected
   * styling takes to leave — see the tile's own note.
   */
  settling?: boolean;
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

  const shown = collapsed ? sources.filter((source) => source.id === selectedId) : sources;

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("flex items-start gap-3", collapsed && "justify-center")}
      onKeyDown={(event) => {
        // Collapsed, the row is a statement rather than a choice; arrow keys
        // would move a selection that is no longer being asked for.
        if (collapsed) return;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          moveSelection(1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          moveSelection(-1);
        }
      }}
    >
      {/*
        `popLayout` takes the leaving tile out of flow at once, so the survivor's
        `layout` animation targets its final centred position rather than
        chasing a gap that is still closing.

        The wrapper carries the width, not the tile: held at the width it had
        with two in the row, so the kept tile travels without also growing.
      */}
      <AnimatePresence initial={false} mode="popLayout">
        {shown.map((source) => (
          <motion.div
            key={source.id}
            layout
            transition={SOURCE_COLLAPSE_MOVE}
            exit={{ opacity: 0, transition: SOURCE_EXIT_FADE }}
            className={cn(
              "flex min-w-0",
              collapsed ? "w-(--sz-source-tile-two-up)" : "flex-1",
            )}
          >
            <ModelSourceTile
              source={source}
              mode={mode}
              selected={source.id === selectedId}
              onSelect={() => onSelect(source.id)}
              settling={settling}
              buttonRef={(node) => {
                if (node) tiles.current.set(source.id, node);
                else tiles.current.delete(source.id);
              }}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
