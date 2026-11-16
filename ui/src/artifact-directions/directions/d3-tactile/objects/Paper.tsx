import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { TabTone } from "../kind";

/**
 * The paper every sheet-like object is cut from.
 *
 * `Scaled` is the miniature: its children are laid out once at design size
 * (a 15rem-wide page) and scaled by `--tac-k`, which `data-tac-size` sets in
 * tokens.css. The wrapper is the real, scaled footprint and carries the
 * two-layer shadow as a `filter`, so the shadow follows the silhouette — the
 * cut corner, a tab, a second sheet — rather than a box.
 */

/**
 * `xs` stands in a thread row's tray and `sm` on the attachments tray (tokens-sizes.css). `pn` is the panel's size for
 * what lies in a slot, every shape about 9.5rem wide; `pw` is a print lying across the whole desk, as wide as its
 * holder (tokens-panel.css). `fd` is an object standing in a folder and `gl` one stood on an opened stack's ledge
 * (tokens-gallery.css). Every size but `sm` scales each shape separately.
 */
export type ObjectSize = "xs" | "sm" | "fd" | "pn" | "pw" | "gl";

export type ScaledBox = "page" | "slide" | "ledger" | "box" | "card";

const FOOTPRINT: Record<ScaledBox, string> = {
  page: "w-(--tac-page-w) h-(--tac-page-h)",
  slide: "w-(--tac-slide-w) h-(--tac-slide-h)",
  ledger: "w-(--tac-ledger-w) h-(--tac-ledger-h)",
  box: "w-(--tac-box-w) h-(--tac-box-h)",
  card: "w-(--tac-card-w) h-(--tac-card-h)",
};

/** The same boxes at design size (k = 1). */
const DESIGN: Record<ScaledBox, string> = {
  page: "w-60 h-77.5",
  slide: "w-80 h-45",
  ledger: "w-70 h-56",
  box: "w-75 h-62",
  card: "w-80 h-44",
};

/** Shadow at rest, a wider one while the object's `group/object` ancestor is hovered or focused, back to rest while it is pressed. */
export const OBJECT_SHADOW =
  "filter-(--tac-filter-rest) transition-(--tac-tp-lift) duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) group-hover/object:filter-(--tac-filter-lift) group-focus-within/object:filter-(--tac-filter-lift) group-active/object:filter-(--tac-filter-rest)";

export function Scaled({ size, box, className, children }: { size: ObjectSize; box: ScaledBox; className?: string; children: ReactNode }) {
  return (
    // `data-tac-box` lets a size give each shape its own scale (the panel fits them all to one width).
    <span data-tac-size={size} data-tac-box={box} className={cn("relative block shrink-0 select-none", FOOTPRINT[box], OBJECT_SHADOW, className)}>
      <span className={cn("absolute left-0 top-0 block origin-top-left scale-(--tac-ks)", DESIGN[box])}>{children}</span>
    </span>
  );
}

type PaperTone = "paper" | "carbon";

const SURFACE: Record<PaperTone, string> = {
  paper: "bg-(--tac-paper) bg-(image:--tac-grain) shadow-(--tac-paper-edge)",
  carbon: "bg-(--tac-carbon) bg-(image:--tac-grain-light) shadow-(--tac-carbon-edge)",
};
const FOLD: Record<PaperTone, string> = { paper: "bg-(image:--tac-fold)", carbon: "bg-(image:--tac-carbon-fold)" };

/**
 * One sheet filling its design box. `ear` cuts the top-right corner and lays
 * the fold over it; `back` slips a second sheet underneath (more than one page).
 */
export function Paper({
  tone = "paper",
  ear = true,
  back = false,
  mask,
  className,
  children,
}: {
  tone?: PaperTone;
  ear?: boolean;
  back?: boolean;
  /** A `var(--tac-mask-…)` reference: holes punched through the sheet. */
  mask?: string;
  className?: string;
  children?: ReactNode;
}) {
  const cut: CSSProperties = {
    ...(ear ? { clipPath: "var(--tac-clip-ear)" } : null),
    ...(mask ? { maskImage: mask, maskComposite: "intersect" } : null),
  };
  return (
    <>
      {back ? (
        <span className="absolute inset-0 block translate-x-(--tac-back-dx) translate-y-(--tac-back-dy) rotate-(--tac-tilt-back) rounded-(--tac-page-r) bg-(--tac-paper-back) shadow-(--tac-paper-edge)" />
      ) : null}
      <span className={cn("absolute inset-0 block overflow-hidden rounded-(--tac-page-r)", SURFACE[tone], className)} style={cut}>
        {children}
      </span>
      {ear ? (
        <span className="absolute right-0 top-0 block size-(--tac-ear)" style={{ filter: "var(--tac-fold-shadow)" }}>
          <span className={cn("block size-full", FOLD[tone])} style={{ clipPath: "var(--tac-clip-fold)" }} />
        </span>
      ) : null}
    </>
  );
}

const TAB: Record<TabTone, string> = {
  pdf: "bg-(--tac-tab-pdf) text-(--tac-tab-ink)",
  slides: "bg-(--tac-tab-slides) text-(--tac-tab-ink-dark)",
  sheet: "bg-(--tac-tab-sheet) text-(--tac-tab-ink)",
  code: "bg-(--tac-tab-code) text-(--tac-tab-ink-code)",
  note: "bg-(--tac-tab-note) text-(--tac-tab-ink)",
};

const TAB_PLACE = {
  /** Wrapping the lower-left edge. */
  spine: "bottom-(--tac-tab-rise) -left-(--tac-tab-out)",
  /** An index tab standing above the top edge — for objects too short to give up a corner. */
  top: "-top-(--tac-tab-up) left-(--tac-tab-rise)",
} as const;

/**
 * The extension, printed on a label stuck to the object's edge. Its type is
 * retuned per size (`--tac-type-tab`) so it stays about 9px tall on screen
 * from the thread row to the gallery.
 */
export function ExtTab({
  label,
  tone,
  place = "spine",
  className,
}: {
  label: string;
  tone: TabTone;
  place?: keyof typeof TAB_PLACE;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "absolute block rounded-(--tac-tab-r) px-(--tac-tab-px) py-(--tac-tab-py) font-sans text-(length:--tac-type-tab) font-bold leading-none tracking-wide shadow-(--tac-tab-shadow)",
        TAB_PLACE[place],
        TAB[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}

/**
 * A rubber stamp on the paper itself — a task document's revision, the one thing a file does not have. Inked, a few
 * degrees off, low on the right of the sheet; a file-backed artifact carries an extension tab on its left edge instead.
 */
export function Stamp({ children }: { children: ReactNode }) {
  return (
    <span className="absolute bottom-(--tac-stamp-rise) right-(--tac-page-pad) block rotate-(--tac-stamp-tilt) rounded-(--tac-tab-r) border-(length:--tac-stamp-edge) border-(--tac-stamp) px-(--tac-tab-px) py-(--tac-tab-py) font-mono text-(length:--tac-type-tab) font-bold uppercase leading-none tracking-wide text-(--tac-stamp)">
      {children}
    </span>
  );
}

/** A coloured binding strip down the left edge of a sheet. */
export function Spine({ tone }: { tone: TabTone }) {
  return <span className={cn("absolute inset-y-0 left-0 block w-(--tac-spine-w) text-(length:--tac-type-tab)", TAB[tone])} />;
}

/** Greeked text: lines standing in for content the artifact does not expose. */
export function Greek({ lines, className }: { lines: readonly string[]; className?: string }) {
  return (
    <span className={cn("flex flex-col gap-(--tac-bar-gap)", className)}>
      {lines.map((width, index) => (
        <span key={index} className={cn("block h-(--tac-bar-h) rounded-full bg-(--tac-ink-faint)", width)} />
      ))}
    </span>
  );
}
