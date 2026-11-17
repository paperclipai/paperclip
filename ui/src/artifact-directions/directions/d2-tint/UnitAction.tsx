import type { ReactNode } from "react";
import { ArrowUpRight, Download, ExternalLink, FileCode2, FolderOpen, Maximize2, MessageSquare, PanelRight, Play, Table2, type LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ActionIntent, UnitAction } from "./actions";

/**
 * Actions are real anchors with accessible names. A unit has ONE primary
 * action whose hit area is stretched over the whole slab by an `::after`
 * overlay (so nothing interactive is nested), and any secondary actions sit
 * above that overlay as their own targets.
 *
 *   PrimaryAction   quiet text + icon — the thread, where the row must stay calm
 *   ButtonAction    a filled neutral button — the panel, where actions are visible
 *   TitleAction     the unit's own title as the link — the gallery, where a tile
 *                   is browsed by its preview and a label would only be more text
 *   SecondaryAction an icon target (with a count, for comments); its label is
 *                   the app's tooltip, so it also appears on keyboard focus
 *
 * At rest an action is neutral; it never takes the kind hue. Every action has
 * a pressed step (`active:`), one notch past its hover.
 */

const ICON: Record<ActionIntent, LucideIcon> = {
  document: ArrowUpRight,
  gallery: Maximize2,
  preview: ExternalLink,
  tab: PanelRight,
  download: Download,
  comments: MessageSquare,
  raw: FileCode2,
  data: Table2,
  play: Play,
  task: ArrowUpRight,
  stack: FolderOpen,
};

/**
 * Keyboard focus: a 2px foreground ring, offset so it reads on a slab and on the page, in both themes.
 * No `outline-none` here — in Tailwind v4 it pins the outline style to none and the ring never appears.
 */
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";
const FOCUS_RING_STRETCHED =
  "outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-foreground";
export const MOTION = "transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-standard) motion-reduce:transition-none";

/** A neutral slab that is one unit: steps up on hover, and again while pressed. */
export const SLAB = cn("rounded-lg bg-(--tint-slab) hover:bg-(--tint-slab-raised) active:bg-(--tint-button)", MOTION);

/**
 * The primary action as quiet text + icon. `stretch` names the radius class of
 * the slab it should cover (e.g. "after:rounded-lg"). The label hides below a
 * 24rem unit (the unit must be an `@container`), as the shipped rows do.
 * `title` is the unit's full text, for a row whose lines truncate.
 */
export function PrimaryAction({ action, stretch, title, className }: { action: UnitAction; stretch: string; title?: string; className?: string }) {
  const Icon = ICON[action.intent];
  return (
    <a
      href={action.href}
      aria-label={action.name}
      title={title}
      data-action={action.intent}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-(--tint-ink-2) after:absolute after:inset-0 group-hover/unit:text-foreground focus-visible:text-foreground",
        MOTION,
        stretch,
        FOCUS_RING_STRETCHED,
        className,
      )}
    >
      <span className="hidden @sm:inline">{action.label}</span>
      <Icon aria-hidden className="size-3.5" />
    </a>
  );
}

/**
 * The primary action as a filled button (panel cards). Still stretched over
 * its unit, so pointing anywhere on the card that is not another target
 * hovers this anchor and inverts the button to the foreground — the card
 * shows what a click will do. The label hides below an 18rem unit; the icon
 * and the accessible name stay.
 */
export function ButtonAction({ action, stretch, className }: { action: UnitAction; stretch: string; className?: string }) {
  const Icon = ICON[action.intent];
  return (
    <a
      href={action.href}
      aria-label={action.name}
      data-action={action.intent}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-(--tint-button) px-2 text-xs font-medium text-foreground after:absolute after:inset-0 hover:bg-foreground hover:text-background focus-visible:bg-foreground focus-visible:text-background active:bg-foreground/85",
        MOTION,
        stretch,
        FOCUS_RING_STRETCHED,
        className,
      )}
    >
      <span className="hidden @2xs:inline">{action.label}</span>
      <Icon aria-hidden className="size-3.5" />
    </a>
  );
}

/**
 * The primary action as the unit's title (gallery tiles, folders). The title
 * text is the anchor and its hit area is the whole unit; the accessible name
 * says where the click goes ("Open in ACM-3: …", "Open stack ACM-3: …").
 * It adds no colour and no type of its own — the heading around it sets those.
 */
export function TitleAction({ action, stretch, title, children }: { action: UnitAction; stretch: string; title?: string; children: ReactNode }) {
  return (
    <a
      href={action.href}
      aria-label={action.name}
      title={title}
      data-action={action.intent}
      // Pointing anywhere on the unit that is not another target hovers this anchor: the title underlines, so the unit shows what a click opens.
      className={cn("underline-offset-4 after:absolute after:inset-0 hover:underline focus-visible:underline", stretch, FOCUS_RING_STRETCHED)}
    >
      {children}
    </a>
  );
}

/** A secondary action: an icon target above the stretched primary. `count` turns it into a chip (comments). */
export function SecondaryAction({ action, count, className }: { action: UnitAction; count?: number; className?: string }) {
  const Icon = ICON[action.intent];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={action.href}
          aria-label={action.name}
          data-action={action.intent}
          className={cn(
            "relative z-10 inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md text-(--tint-ink-2) hover:bg-(--tint-well) hover:text-foreground active:bg-(--tint-button)",
            count == null ? "w-7" : "px-1.5",
            MOTION,
            FOCUS_RING,
            className,
          )}
        >
          <Icon aria-hidden className="size-3.5" />
          {count == null ? null : <span className="font-mono text-(length:--text-micro) leading-none">{count}</span>}
        </a>
      </TooltipTrigger>
      <TooltipContent>{action.label}</TooltipContent>
    </Tooltip>
  );
}
