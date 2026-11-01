import { Download, ExternalLink, Maximize2, PanelRightOpen, type LucideIcon } from "lucide-react";
import type { LabArtifact } from "../../kit";
import { isTaskDocument, isTextLike, slug } from "./kinds";

/**
 * The one thing you do with an artifact from the thread, in production
 * wording. The lab's targets are inert hashes; `gallery` is a button because
 * the product opens a modal from it.
 *
 * One glyph per destination on every surface, so no two controls on a unit
 * look alike: ExternalLink leaves for a new browser tab, PanelRightOpen opens
 * the side panel, Maximize2 opens the gallery, Download downloads, and
 * ArrowRight (the gallery only) goes to the owning task.
 */

export interface SolidAction {
  id: "document" | "gallery" | "preview" | "tab" | "download";
  label: string;
  icon: LucideIcon;
  /** Absent for `gallery`, which is a button. */
  href?: string;
  external?: boolean;
}

export function downloadAction(a: LabArtifact): SolidAction {
  return { id: "download", label: "Download", icon: Download, href: `#download-${a.id}` };
}

export function threadAction(a: LabArtifact): SolidAction {
  if (isTaskDocument(a)) return { id: "document", label: "Open document", icon: PanelRightOpen, href: `#document-${slug(a)}` };
  if (a.kind === "link") return { id: "preview", label: "Open preview", icon: ExternalLink, href: a.url ?? "#", external: true };
  if (a.kind === "image" || a.kind === "video") return { id: "gallery", label: "Open gallery", icon: Maximize2 };
  // Text-like files open in the side panel; Download stays reachable as its own target.
  if (isTextLike(a)) return { id: "tab", label: "Open in tab", icon: PanelRightOpen, href: `#attachment-${a.id}` };
  return downloadAction(a);
}

/** The accessible name of an action on a given artifact: "Download: Interface Craft revision — PDF". */
export const actionName = (action: SolidAction, a: LabArtifact) => `${action.label}: ${a.title}`;

/** Link attributes for an action that leaves for a new browser tab. */
export const externalProps = (action: SolidAction) => (action.external ? ({ target: "_blank", rel: "noreferrer" } as const) : null);
