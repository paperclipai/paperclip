import { Download, ExternalLink, Maximize2, MessageSquare, PanelRight, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { RING, RING_ON, panelActions, panelIconActions, type ActionIcon, type ArtifactAction } from "./kind";

/**
 * PANEL — what one does with an artifact, as ordinary buttons under its
 * caption: the product's wording (Read document, View image, Open file,
 * Download file …), the first one outlined and the rest quiet. A Markdown
 * file keeps its comment count and its three small targets (Open in tab,
 * Open raw, Download) as icon buttons at the end of the row.
 *
 * The first action also answers a click on an object in a slot: its hit area
 * is stretched over the slot beside the caption.
 *
 * Focus: the repo Button's ring is half-transparent, under 2:1 on the desk.
 * Here every button takes the kit's ring instead — solid, with a gap in the
 * desk's colour.
 */

const ICON: Record<ActionIcon, LucideIcon> = { open: PanelRight, gallery: Maximize2, download: Download, external: ExternalLink };

/** Covers the slot (the row is the positioned ancestor), so the object is the first action's target too. */
const OVER_SLOT = "@3xs/desk:after:absolute @3xs/desk:after:inset-y-0 @3xs/desk:after:left-0 @3xs/desk:after:w-(--tac-stage-w) @3xs/desk:after:cursor-pointer";

/** The kit's focus ring on a repo Button, in place of its own. */
export const BUTTON_RING = cn("focus-visible:border-transparent", RING, RING_ON.desk);

function TextAction({ action, title, primary, overSlot }: { action: ArtifactAction; title: string; primary: boolean; overSlot: boolean }) {
  const label = `${action.label}: ${title}`;
  const className = cn("h-7 px-2.5", BUTTON_RING, primary ? overSlot && OVER_SLOT : "relative text-(--tac-meta) hover:text-foreground");
  const content = (
    <>
      {action.label}
      {action.icon === "external" ? <ExternalLink aria-hidden /> : null}
    </>
  );
  return (
    <Button asChild={Boolean(action.href)} type={action.href ? undefined : "button"} variant={primary ? "outline" : "ghost"} size="xs" className={className} aria-label={label}>
      {action.href ? <a href={action.href}>{content}</a> : content}
    </Button>
  );
}

function IconAction({ action, title }: { action: ArtifactAction; title: string }) {
  const Icon = ICON[action.icon];
  return (
    <Button asChild variant="ghost" size="icon-xs" className={cn("relative text-(--tac-meta) hover:text-foreground", BUTTON_RING)}>
      <a href={action.href} aria-label={`${action.label}: ${title}`} title={action.label}>
        <Icon aria-hidden />
      </a>
    </Button>
  );
}

export function PanelActions({ artifact, overSlot }: { artifact: LabArtifact; /** The object lies in a slot beside the caption (not across the desk). */ overSlot: boolean }) {
  const [primary, ...rest] = panelActions(artifact);
  const icons = panelIconActions(artifact);
  const comments = artifact.commentCount;
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 pt-1.5">
      <TextAction action={primary} title={artifact.title} primary overSlot={overSlot} />
      {rest.map((action) => (
        <TextAction key={action.label} action={action} title={artifact.title} primary={false} overSlot={false} />
      ))}
      {comments != null || icons.length > 0 ? (
        <span className="ml-auto flex items-center">
          {comments != null ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={cn("relative px-1.5 text-(--tac-meta) hover:text-foreground", BUTTON_RING)}
              aria-label={`${comments} ${comments === 1 ? "comment" : "comments"}: ${artifact.title}`}
            >
              <MessageSquare aria-hidden />
              <span className="font-mono">{comments}</span>
            </Button>
          ) : null}
          {icons.map((action) => (
            <IconAction key={action.label} action={action} title={artifact.title} />
          ))}
        </span>
      ) : null}
    </div>
  );
}
