import type { DirectionKit } from "../../kit";
import { GalleryStack, GalleryStacks } from "./Gallery";
import { PanelBody } from "./PanelBody";
import { ThreadAttachments } from "./ThreadAttachments";
import { ThreadWorkProduct } from "./ThreadWorkProduct";
import "./tokens.css";

/**
 * DIRECTION 1 — SOLID. Flat, filled, mostly monochrome.
 *
 * The fix is fill, not line. Today an artifact is a 1px outline around the
 * canvas colour; here it is a SLAB — a filled block a clear value step off the
 * canvas, with no stroke, no shadow and no gradient — and what fills an
 * artifact's preview is its CONTENT, never its file extension.
 *
 * FILLS (tokens.css; OKLCH lightness, light / dark; contrast against what it sits on)
 *   canvas      1.000 / 0.205   --background, untouched
 *   slab        0.900 / 0.325   the artifact (1.35 / 1.44 on the canvas; today's outline colour is 1.26 / 1.32)
 *   slab-hover  0.865 / 0.365   a slab that is a target, hovered or focused; slab-press 0.830 / 0.400 while pressed
 *   button      0.800 / 0.400   a resting button on a slab (1.39 / 1.35 on the slab)
 *   sheet       1.000 / 0.430   the artifact's own content — an excerpt, a file's facts: the lightest fill short of ink
 *                               in both themes (paper on a mat); body text in --solid-sheet-text, lead lines in --foreground
 *   ink         0.205 / 0.800   the one inverted fill: the kind block and tab, and a primary action that is hovered or due
 *   pile-1/-2   0.920 / 0.290 and 0.945 / 0.265   the slabs behind a gallery stack: each one step NEARER the canvas, both themes
 *   Text on a slab: --foreground, and --solid-meta (0.44 / 0.78) for secondary; every pair ≥ 4.5:1 at rest and on hover.
 *
 * SIGNATURES — the same idea on thread, panel and gallery
 *   1. KIND BLOCK (KindBlock.tsx, kinds.ts) — an INK plate: mono-caps label
 *      bottom-left, the kind's glyph top-right (20px in a thread row, so kinds
 *      differ by shape as well as letters). A file is labelled by its extension
 *      (PDF, PPTX, MD, PNG, ZIP, XLSX, WEBM, HTML, OTF; URL for a link); a task
 *      document, which has none, by its revision (REV 3) under a notebook glyph.
 *        KindBlock  free-standing: xs 56×36 attachments (label only) · sm 72×44
 *                   thread row and panel card · lg 128×96 a picture attachment.
 *                   An artifact with a picture shows the picture in the plate,
 *                   with nothing over it (a video keeps a play mark).
 *        KindTag    the label on an ink tab in the bottom-left corner of a
 *                   preview that has content of its own (a picture, a sheet).
 *        KindDock   the block docked in that corner of a preview that has none
 *                   (131×80 on a tile, 72×44 in a mosaic cell): the tab grown
 *                   to a block. Ink is always the mark in the bottom-left
 *                   corner — never the whole plate.
 *   2. MONO META LINE (MetaLine.tsx, kinds.ts) — kind · size · rev · extent in
 *      font-mono 11px, never reordered: "PDF · 57.7 KB · 12 pages",
 *      "Document · rev 3", "Video · 3.4 MB · 0:06". Production wording; a
 *      surface may take a prefix (`max`), never reorder. Every other machine
 *      value (filenames, stamps, counts, content types) is the same META_TEXT.
 *   3. ONE RADIUS, ONE RHYTHM (slab.ts) — rounded-md on every slab, plate,
 *      sheet, button, tab and bite; 8px inset around the kind block in the
 *      thread, 12px in the panel and the gallery; 12px from block to text; 8px
 *      between slabs, 24px gutters in the gallery.
 *   4. MONO COUNT LABEL (Counts.tsx) — heads the thread's attachments, the
 *      panel's shelf and sections, and the gallery's grids, days and stacks:
 *      "21 artifacts  ● 9 to review". Items are unbreakable; the label wraps
 *      between them.
 *
 * STATE (StateMarker.tsx) — the only chroma, and only a 6px dot of it: the
 * product's status hue + the production label ("Review", "Changes requested")
 * in foreground text, straight on the slab with no fill of its own, so it is
 * never taken for a button. What makes "this needs you" unmistakable is the
 * action beside it: the primary of an artifact that waits for review is INK AT
 * REST (thread and panel). On a gallery preview the state is written in a BITE
 * the slab takes out of the bottom-right corner (inverse radii at its joints),
 * the mirror of the ink kind tab bottom-left; a mosaic's "+18" is the same bite.
 *
 * INTERACTION (slab.ts) — in the thread and the gallery the whole slab is its
 * primary action's target (COVER). Hover or keyboard focus steps the slab and
 * turns that action to ink; pressing steps it once more. A secondary control
 * is an icon-only ghost that takes the ink itself and hands the primary back
 * to the button fill while hovered. The panel card is a reading surface and is
 * NOT a target: only its controls act. The primary is first in the tab order
 * everywhere; icon-only controls carry a tooltip naming the action. One glyph
 * per destination: a box-with-arrow leaves for a new tab, a tray downloads, a
 * side-panel glyph opens the pane, the plain arrow goes to the owning task.
 * focus-visible is a 2px ink outline 2px off the slab or the control. Colour
 * transitions only (and the pile's rise); none under reduced motion.
 *
 * THREAD — compact and calm (ThreadWorkProduct, ThreadAttachments)
 *   Row 60px: [block 72×44] title / meta — summary … ● state [action 136px].
 *   Gives way by priority, by its own width: from 48rem a one-line title with
 *   the summary on the meta line; under that a two-line title and the summary
 *   on its own line (76px); under 36rem the state is its dot; under 28rem the
 *   action is its icon; the text column never goes under 8rem.
 *   Attachments: one count label ("5 attachments · 1 image · 4 files  ● 5 to
 *   review") over a wrapping grid: a file is a 52px slab (block, filename, meta,
 *   state); anything with a picture takes two rows, the picture at 128×96.
 *
 * PANEL — a thread row with its drawer open (PanelBody, PanelCard, PanelLead,
 * PanelMenu, panel-model.ts, panel-actions.ts)
 *   Shelf     one count line, then the product's sections in the product's
 *             order: one per producing run (name, count line, run start), task
 *             documents on their own. Nothing is reordered.
 *   Card      slab, 12px inset. A picture or a video LEADS its card at 16:9
 *             with the kind tab on it (a video plays in place); every other
 *             kind opens with [block 72×44] beside the text.
 *     head    title, summary, meta line, filename, and the content type on
 *             file cards — all wrap, nothing is clamped.
 *     sheet   text kinds only: the excerpt on a sheet, opening line and
 *             headings strong; six lines when it waits for review, three otherwise.
 *     foot    one row, the same three places on every card: ● state · who and
 *             when (the time alone under a section dated the same day) · and
 *             at the far end [comments] [⋯ More actions] [primary 136px]. All
 *             secondaries are in the one menu, by name.
 *   Widths    under 20rem of card the foot's two ends stack; a maximized pane
 *             sets the cards in 22rem columns, row by row.
 *
 * GALLERY — browsing: preview first (Gallery, StackTile, GalleryTile,
 * GalleryPreview, ExcerptSheet, gallery-model.ts)
 *   Grid      the product's: 1 / 2 / 3 columns at <768 / 768 / 1280px, 24px
 *             gutters, under one count line. An opened stack is sectioned by
 *             day of last edit: the day name is the page's one large line
 *             (text-lg semibold), its count line beneath. `?days=off` lists it
 *             as the product does today, in one flat grid.
 *   Preview   one 18:11 plate per artifact, filled by what the artifact is:
 *               picture  image, video poster, link   the picture + ink kind tab
 *               text     document, Markdown, code,   its own words on a sheet, as many whole
 *                        sheet                       lines as the plate holds + ink kind tab
 *               facts    PDF, slides, archive, file  a sheet: how much of it there is at display
 *                                                    size ("12 slides"), its filename, and the
 *                                                    kind block docked bottom-left
 *   Tile      slab: preview / title across the full width (2 lines) / meta
 *             line and stamp · author, with [⧉] [↓] [→] at the far end of the
 *             foot. The tile is the [→] action's target (the owning task).
 *   Stack     a PILE of flat fills behind the face: 0 / 1 / 2 slabs for 1 /
 *             2–3 / more artifacts; the nearer one says what is in the pile on
 *             its edge ("DOCS 7 · PDF 3 · PPTX 3"); they rise 6px a slab on
 *             hover. On the face a MOSAIC of the three newest, each as its own
 *             preview, the one with most to show large, "+18" bitten into the
 *             corner. Then ACM-3 + title, and a two-line foot (counts, then
 *             Updated) with [→]. Face and pile are one target. A stack of one
 *             has no pile and one full preview.
 */
export const kit: DirectionKit = {
  id: "d1-solid",
  name: "1.Solid",
  tagline: "Flat, filled, mostly monochrome",
  ThreadWorkProduct,
  ThreadAttachments,
  PanelBody,
  GalleryStacks,
  GalleryStack,
};
