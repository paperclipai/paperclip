import type { DirectionKit } from "../../kit";
import { GalleryStack } from "./GalleryStack";
import { GalleryStacks } from "./GalleryStacks";
import { PanelBody } from "./PanelBody";
import { ThreadAttachments } from "./ThreadAttachments";
import { ThreadWorkProduct } from "./ThreadWorkProduct";
import "./tokens.css";

/**
 * 2 · TINT — filled cards with colour used sparingly.
 *
 * A sibling of Solid: filled neutral slabs, no outlines, no shadows, no
 * gradients, crisp edges. The difference is that every artifact KIND owns one
 * hue, and one rule decides where that hue may live.
 *
 * THE ONE RULE (Lead.tsx) — the lead of every unit, on every surface, is
 *   SHOWN  the artifact's own content wearing the kind's two marks: the top-
 *          right corner folded back as a solid kind-hue flap, and the real
 *          extension as a hue tab on its edge. Either a picture
 *          (`FoldedPreview` — image, video poster, link screenshot) or its
 *          text on a neutral sheet (`FoldedSheet` — a document's opening, a
 *          sheet's rows, a file's code).
 *   NAMED  when there is nothing to show, or no room to show it: the kind
 *          glyph centred on a well filled with the kind's quiet hue (`KindWell`).
 * Colour is the fold and tab on real content, or the glyph and its well —
 * never both, and nowhere else on a unit at rest: no coloured border, stripe,
 * title, action or chip. A failed or missing picture falls back to NAMED.
 *
 * SIGNATURE ELEMENTS — what carries across thread, panel and gallery
 *  1. The kind glyph (KindGlyph.tsx): a rounded tile with a folded top-right
 *     corner (a flat lighter facet, never a shadow), a pictogram top-left
 *     (Pictogram.tsx, ten of them) and the REAL extension in bold — PDF, PPTX,
 *     XLSX, MD, PNG, WEBM, ZIP, HTML, OTF; URL for a link. A task document has
 *     no extension, so its glyph is the pictogram alone, larger: it can no
 *     longer be mistaken for a .doc, or for the .md file next to it.
 *     Sizes: mini 16×18 (pictogram only — index chips, kind tallies), xs 34×38
 *     (thread), md 56×64 (panel), lg 96×110 (gallery), tuck (standing in a folder).
 *  2. The fold and tab on real content (Lead.tsx), folds sm / md / lg — the
 *     same frame for a picture and for a sheet of text. Video adds a white
 *     play mark on a neutral scrim.
 *  3. The mono meta line (MetaLine.tsx): kind · size · rev (· fact) — one
 *     grammar everywhere, monospace, never coloured. Wording is the product's
 *     (kinds.ts). It wraps between parts where the product wraps.
 *  4. The state mark (StateMark.tsx): a pill punched back to the page fill
 *     with an 8px marker in the app's status hue — an open RING for Review, a
 *     solid DOT for Changes requested; "N to review" (`ReviewTally`) where a
 *     heading holds several artifacts. No kind uses violet, so the Review
 *     ring is the only violet on any surface.
 *  5. The filled slab: `--tint-slab`, `rounded-lg`, no border, no shadow.
 *
 * KIND → HUE (tokens.css, OKLCH, tuned per theme) — nine hues for ten kinds
 *  document blue · pdf red · slides orange · sheet green · image + video one
 *  media magenta (told apart by pictogram, extension and play mark) · archive
 *  a true amber, the one hue that carries dark ink · code teal · link sky ·
 *  file a near-neutral grey. A unit sets `data-kind` ONCE on its root;
 *  descendants read `--kind`, `--kind-ink`, `--kind-facet`, `--kind-well`
 *  (the quiet fill: its own token per hue and theme, so red stays red and
 *  amber stays amber), `--kind-well-lg` (tile-sized: less chroma in light)
 *  and `--kind-wash` / `--kind-wash-pressed` (a hovered / pressed thread slab).
 *
 * MATERIALS
 *  `--tint-slab` (7.5% / 9% foreground over the page, 1.2:1): every card.
 *  `--tint-slab-raised`: the neutral hover of a unit. `--tint-button`: a
 *  filled neutral button, and the pressed step of a slab. `--tint-well` (= the
 *  page fill): holes in a slab — state pills, and the sheet text is set on.
 *  `--tint-ink-2`: secondary text, ≥ 4.5:1 on every fill and every kind well.
 *  `--tint-folder-back`: the one fill a folder adds. Previews use
 *  `--tint-radius-glyph`.
 *
 * WHO SPEAKS IN WHICH VOICE
 *  Human words (title, summary, a document's own text) are sans; machine
 *  values (meta line, filename, address, MIME type, timestamps, counts, sheet
 *  and code previews) are the mono token in secondary ink. Text on a slab or
 *  a kind well is ABOUT the artifact; text on a neutral sheet IS the artifact
 *  (Content.tsx: at most one heading on its own line, then body lines; list
 *  items each on a line; the document's own metadata line and a heading that
 *  repeats the summary are left out).
 *
 * STATES (UnitAction.tsx)
 *  rest — neutral slab, the lead carries the colour, action neutral;
 *  hover — thread: the slab takes the kind wash (the row's one extra use of
 *    its hue) and the action takes the foreground; panel: slab steps to
 *    raised and the primary button inverts to the foreground; gallery: slab
 *    steps to raised and the title — which is the link — underlines; a
 *    folder's contents rise 12px out of it while its pocket keeps its fill;
 *  pressed — one step past hover on every unit and every target;
 *  focus-visible — 2px foreground outline, 2px offset, around the whole slab
 *    (the primary action is stretched over it; every other target has its
 *    own ring, and icon targets show their label in the app's tooltip);
 *  review — the state mark at the right end of the meta line (in a wide
 *    thread row: in its own column, so marks line up down the thread);
 *  long text — titles truncate in a thread row and on a tile, clamp at two
 *    lines in the panel and on a folder (three in a narrow pane), and break
 *    anywhere so an unbroken filename still ends in an ellipsis; filenames
 *    keep their extension; a link's address truncates on its own;
 *  one artifact versus a pile — a stack of one is a tile, never a folder.
 *  Nothing is tooltip-only: MIME type, filename and times are printed, and a
 *  date outside the current year says its year. Filenames, addresses and MIME
 *  types sit above the stretched link, so they can be selected and copied.
 *  Motion: colour, plus the rise of a hovered folder's contents;
 *  `--motion-duration-fast`, none under reduced motion.
 *
 * THREAD
 *  ThreadWorkProduct — a 62px single-row slab for every kind: one 72×46 lead
 *  box (a folded picture, or the xs glyph on its kind well — no room to show
 *  text here), so every title starts on one edge · title over the meta line
 *  (summary rides it after a hairline) · state mark · the one action in a
 *  fixed slot. Below a 32rem row it becomes three lines: the state mark joins
 *  the meta line and the summary gets up to two lines of its own.
 *  ThreadAttachments — "Attachments · N" with its image and file counts, over
 *  one even grid: a picture is a cell two rows tall with a 144×96 folded
 *  preview, a file is a 50px slab with the xs glyph; pictures lead; past
 *  twelve the block ends in "Show all N". 1 / 2 / 3 columns by container.
 *
 * PANEL — PanelBody.tsx
 *  index (PanelIndex.tsx) — one row of filter BUTTONS: All · Review (the
 *    ring) · the kinds with two or more (mini glyph + count) · "+N". Pressed
 *    is the foreground inversion and spells the kind out.
 *  sections (PanelSection.tsx, panel-model.ts) — producing runs and the
 *    task's documents in the product's order, newest first; a section says
 *    how many of its items are waiting, nothing is re-sorted.
 *  card (PanelCard.tsx, PanelLead.tsx) — one skeleton, the lead by the rule:
 *      picture  full width, the whole picture at its own shape (4:3 to 16:9),
 *               fold lg; a video's poster is a play button that swaps in the
 *               real player
 *      sheet    full width: five lines of a document, header + three rows of
 *               a sheet (only the columns that fit, the rest counted), five
 *               lines of code; fold md
 *      named    the md glyph on a 112px kind well beside the words
 *    then title · meta line with facts + state mark · summary · filename or
 *    address · MIME type (file cards) · footer: author over edit time (time
 *    only inside a run section), icon actions, the filled primary button.
 *
 * GALLERY — GalleryStacks.tsx, GalleryStack.tsx
 *  stacks — a stack of two or more is a FLAT FOLDER (StackFolder.tsx): the
 *    task identifier on the tab, a back panel, a mouth of contents, and the
 *    pocket in front with the title, "N artifacts · Updated <date>", the
 *    kinds counted as a caption (KindTally.tsx) and the review tally. What
 *    stands in the mouth (StackFace.tsx, gallery-model.ts) is one artifact
 *    per kind before any kind repeats, each by the rule: a picture, a sheet
 *    of its first lines (tab on its top edge), or — only for a kind with
 *    nothing to show — the full-colour glyph, standing a little lower. A
 *    folder has no hue of its own. A stack of ONE is not a folder
 *    (StackSingle.tsx): it is that artifact's preview on a slab.
 *  opened stack — a caption (the pocket laid flat, as type on the page), then
 *    the artifacts by day of last edit; days too quiet to fill a row share
 *    one heading ("September 25 – 26") and their tiles carry the date.
 *  tile (GalleryTile.tsx) — a 16:9 preview by the rule (GalleryPreview.tsx:
 *    folded picture · sheet of text clamped to whole lines · kind well with
 *    the lg glyph, the countable fact as a headline, the summary and the
 *    filename), then title (the link) · meta line + state mark · author ·
 *    time with "Open file in new tab" and "Download file" visible at rest.
 *
 * `specimen.html` in this directory shows every primitive at every size for
 * all ten kinds (dev server: /src/artifact-directions/directions/d2-tint/specimen.html).
 * It is a builder's aid; nothing in the kit imports it.
 */
export const kit: DirectionKit = {
  id: "d2-tint",
  name: "2.Tint",
  tagline: "Filled cards with colour used sparingly",
  ThreadWorkProduct,
  ThreadAttachments,
  PanelBody,
  GalleryStacks,
  GalleryStack,
};
