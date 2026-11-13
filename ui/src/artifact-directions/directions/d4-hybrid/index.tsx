import type { DirectionKit } from "../../kit";
import { GalleryStack } from "./GalleryStack";
import { GalleryStacks } from "./GalleryStacks";
import { PanelBody } from "./PanelBody";
import { ThreadAttachments } from "./ThreadAttachments";
import { ThreadWorkProduct } from "./ThreadWorkProduct";
import "./tokens.css";

/**
 * 4 · HYBRID — Tint's containers and colour, Tactile's paper.
 *
 * A fork of Tint that keeps its containers, its folders, its gallery layout,
 * its filter bar, its kind hues and its discipline of colour in one place per
 * unit — and takes from Tactile the one thing Tint's dark text sheets lacked:
 * real paper, with the document's own words typeset on it. Everything the
 * brief does not mention keeps Tint's answer.
 *
 * KEPT FROM TINT
 *  - the filled neutral slab (`--hy-slab`, rounded-lg, no border, no shadow),
 *    the flat folder with its tab, back panel and front pocket, the opened
 *    stack by day, the panel's filter bar (PanelIndex.tsx, screen 9), the
 *    thread's attachments cluster (screen 7), the mono meta line, the quiet
 *    state chip (ring for Review, dot for Changes requested), the wording;
 *  - nine kind hues for ten kinds (tokens.css), the kind glyph with its
 *    folded corner (KindGlyph.tsx) and its ten pictograms, the mini glyph in
 *    tallies and filter chips.
 *
 * TAKEN FROM TACTILE
 *  - the paper sheet (PaperSheet.tsx): off-white stock in both themes, the
 *    document's first heading heavier, its body lighter, fading toward the
 *    bottom edge; a sheet's rows and a file's code in mono; the small paper
 *    dog-ear top-right — straightened (zero rotation anywhere), with no
 *    floating label or flag, and no drop shadow;
 *  - the single-document lockup (screen 5: hero paper at the left, the
 *    identifier, title, kind line, count and updated at the right) and the
 *    true preview content everywhere a document is shown.
 *
 * THE RULES (the brief, R1–R11)
 *  R1  Base is Tint: containers, slabs, folders, gallery, filter bar, hues.
 *  R2  The page curl survives ONLY on the kind glyph. Every real preview —
 *      picture, screenshot, video poster, link preview, paper — has no curl;
 *      its label is the CORNER LABEL (CornerLabel.tsx): a small solid block in
 *      the kind hue with the extension, inset top-left. Tint's bottom-left
 *      tab and top-right flap are gone.
 *  R3  Text documents are white paper (PaperSheet.tsx), never dark sheets;
 *      straight; the paper's label is the corner label; review state is
 *      Tint's quiet chip. The dog-ear is paper, not a coloured flap.
 *  R4  A glyph stands on the MONOCHROME well (`--hy-well-mono`): a value just
 *      lighter than the card it is on — toward the page in light, toward the
 *      foreground in dark — re-derived on every unit from `--hy-card`, so it
 *      stays a step above the card while the card is hovered. No kind tint
 *      behind glyphs anywhere, in any state: gallery tiles, panel cards,
 *      thread rows — where the slab takes Tint's kind wash under the pointer,
 *      the well on it is derived from the neutral raised slab instead
 *      (tokens.css), so it never goes faintly blue or red with the row.
 *  R5  Gallery tiles get double Tint's inner padding (16px round the
 *      preview, GalleryTile.tsx); panel cards more (12px).
 *  R6  A stack of one is the Tactile lockup (screen 5) in Tint's container
 *      (StackSingle.tsx): the WHOLE sheet at its own proportion in the slab's
 *      20px inset, never cut by the slab's edge.
 *  R7  Folders double the inner padding to the left, right and top of the
 *      tucked artifacts (StackFolder.tsx): the mouth is inset 32px at the
 *      sides (Tint 16) and 20px at the top, where Tint's is 4 — with the 12px
 *      the faces rest down in both, the first face stands 32px under the back
 *      panel's top against Tint's 16. The mouth is 9:4, so the narrower
 *      contents keep the height Tint's 5:2 gave them. The front pocket is
 *      Tint's, unchanged. Contents are paper sheets, pictures with the corner
 *      label, and glyph tiles.
 *  R8  A hovered folder's contents rise with a slight stagger (`--hy-stagger`
 *      per face, StackFace.tsx), on the repo's motion tokens, none under
 *      reduced motion.
 *  R9  Thread: the attachments cluster is screen 7's lockup with R2 and R4
 *      applied (ThreadAttachments.tsx); work-product rows are Tint's with the
 *      mono well (ThreadWorkProduct.tsx, screen 8).
 *  R10 Panel: Tint's filter bar stays (PanelIndex.tsx); sixteen pixels
 *      between cards, twelve inside them; the card is screen 10 (PanelCard.tsx)
 *      — a 100px mono well with the panel paper standing at the left and the
 *      first lines beside it (a picture, or the glyph with its facts — the
 *      count and the size, the content type as their tooltip — for the other
 *      kinds, PanelLead.tsx), the title, the filename and the kind line in
 *      mono, and a footer with the agent CHARACTER (Character.tsx: 32px, the
 *      byline's height, as the mock draws it; initials when there is no
 *      drawing or it fails), the name in bold, the time in mono and a filled
 *      "Open ↗" at the right. In a wide pane the cards keep their own heights.
 *  R11 Everything else is Tint's: day grouping, tallies, meta lines, chips,
 *      wording, dark-and-light token discipline, accessibility.
 *
 * THE LEAD RULE (Lead.tsx) — the lead of every unit is one of three things:
 *  picture  the thumbnail with its corner label      (`Picture`)
 *  paper    the sheet with its words and its label   (`PaperSheet`)
 *  glyph    nothing to show, or no room: the glyph on the mono well (`KindWell`)
 *
 * SIZES OF PAPER (tokens.css group 5, in cqw of the sheet so one layout holds
 * at every width): panel 104px, foot clipped by its well · tuck, a folder
 * column, foot behind the pocket · tile, 44% (`--hy-paper-tile-w`) of a
 * gallery tile's well, running to its bottom edge, or of a single stack's
 * slab, where the sheet is whole. The sheet is decorative to assistive
 * technology; the words are in the unit's title, meta and excerpt. A thread
 * row has no room for a sheet: its lead stays the glyph.
 *
 * GALLERY (GalleryStacks.tsx, GalleryStack.tsx) — Tint's grids. A folder
 * (StackFolder.tsx) keeps Tint's tab, back panel and pocket to the letter;
 * its mouth is inset 32px at the sides and 20px at the top (R7 above), 9:4
 * so the contents keep their height, and holds straight paper sheets,
 * pictures with the corner label and tuck glyphs (StackFace.tsx) that rise
 * one after another on hover. A stack of one (StackSingle.tsx) is screen 5:
 * the whole paper at the left, the identifier, title, kind line, count and
 * date at the right. An opened stack's tiles
 * (GalleryTile.tsx) have a 16px inset (double Tint's) round a 16:9 preview
 * (GalleryPreview.tsx): the picture with its label, the paper with the
 * document's first lines beside it, or the lg glyph on the mono well with
 * its facts.
 */
export const kit: DirectionKit = {
  id: "d4-hybrid",
  name: "4.Hybrid",
  tagline: "Tint's containers and colour, Tactile's paper",
  ThreadWorkProduct,
  ThreadAttachments,
  PanelBody,
  GalleryStacks,
  GalleryStack,
};
