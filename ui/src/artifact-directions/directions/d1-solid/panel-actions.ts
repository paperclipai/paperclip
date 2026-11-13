import { ChevronDown, Download, ExternalLink, Maximize2, PanelRightOpen, Table2 } from "lucide-react";
import type { LabArtifact } from "../../kit";
import type { SolidAction } from "./actions";
import { isTaskDocument, isTextLike, slug } from "./kinds";

/**
 * What a panel card offers, in the panel's production wording. The primary is
 * the same deed the thread row offers for that artifact, under the name the
 * panel gives it:
 *
 *   thread            panel
 *   Open document     Read document     task documents (a side-panel tab) and Markdown files (expands in place)
 *   Open gallery      View image / Open video
 *   Open preview      Open link
 *   Open in tab       Open in tab       other text-like files
 *   Download          Download file     everything else
 *
 * Everything else the product puts on the card is listed, by name, in the
 * card's one "More actions" menu: Open in tab, Open raw, Open file, Download,
 * Preview data. The comments count of a Markdown file is the card's own chip,
 * not listed here.
 */

export interface PanelActions {
  primary: SolidAction;
  more: SolidAction[];
}

export function panelActions(a: LabArtifact): PanelActions {
  const download = (label: string): SolidAction => ({ id: "download", label, icon: Download, href: `#download-${a.id}` });
  const openFile: SolidAction = { id: "preview", label: "Open file", icon: ExternalLink, href: `#file-${a.id}`, external: true };
  const openTab: SolidAction = { id: "tab", label: "Open in tab", icon: PanelRightOpen, href: `#attachment-${a.id}` };

  if (isTaskDocument(a)) {
    return { primary: { id: "document", label: "Read document", icon: PanelRightOpen, href: `#document-${slug(a)}` }, more: [] };
  }
  if (a.kind === "link") {
    return { primary: { id: "preview", label: "Open link", icon: ExternalLink, href: a.url ?? "#", external: true }, more: [] };
  }
  if (a.kind === "image") return { primary: { id: "gallery", label: "View image", icon: Maximize2 }, more: [] };
  if (a.kind === "video") return { primary: { id: "gallery", label: "Open video", icon: Maximize2 }, more: [] };
  if (a.kind === "document") {
    // A Markdown file an agent attached: reads in place, with the product's three ways out.
    return {
      primary: { id: "document", label: "Read document", icon: ChevronDown },
      more: [openTab, { id: "preview", label: "Open raw", icon: ExternalLink, href: `#raw-${a.id}`, external: true }, download("Download")],
    };
  }
  if (isTextLike(a)) {
    const data: SolidAction[] = /\.csv$/i.test(a.filename ?? "") ? [{ id: "tab", label: "Preview data", icon: Table2 }] : [];
    return { primary: openTab, more: [...data, openFile, download("Download file")] };
  }
  return { primary: download("Download file"), more: [openFile] };
}
