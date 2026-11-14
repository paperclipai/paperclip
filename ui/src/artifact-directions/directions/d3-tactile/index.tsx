import type { DirectionKit } from "../../kit";
import { GalleryStack } from "./GalleryStack";
import { GalleryStacks } from "./GalleryStacks";
import { PanelBody } from "./PanelBody";
import { ThreadAttachments } from "./ThreadAttachments";
import { ThreadWorkProduct } from "./ThreadWorkProduct";
import "./tokens.css";
import "./tokens-sizes.css";
import "./tokens-panel.css";
import "./tokens-folder.css";
import "./tokens-gallery.css";

/**
 * 3 · TACTILE — paper, prints and folders.
 *
 * Artifacts are objects, not cards: a document is a sheet of paper with its
 * real opening set on it, an image is a photo print, a group is a folder with
 * its own sheets and prints tucked in. What stops them getting lost is that
 * they are the lightest thing on a filled ground — the same warm ground on
 * every surface — and that they stand in things: a tray, a slot, a ledge, a
 * folder.
 *
 * SIGNATURE — the same on every surface
 *   1. The object (`objects/ArtifactObject`): one drawing per kind, authored
 *      once at design size and scaled, so the sheet in the thread IS the sheet
 *      in the panel and in the folder. Sheets are dog-eared (top right) and
 *      carry the artifact's real opening in serif, fading out toward the foot;
 *      images are white-bordered prints.
 *   2. The mark that says what it is. A file carries its extension on a
 *      printed tab stuck to its left edge (`ExtTab`; above the top edge on a
 *      slide) — PDF red, PPTX orange, XLSX/CSV green, HTML/JSON pale blue,
 *      MD/OTF graphite, ZIP on the box's own label. A task document is not a
 *      file: it carries its revision as a rubber stamp on the paper (`Stamp`,
 *      "REV 3"), and its captions drop the `.md`.
 *   3. The sticky flag: review state as a flag in the status colour, tilted
 *      2°, gummed end lighter, swallow-tailed, with a 1px film edge, always
 *      standing proud of a top edge. `StateFlag` carries the word, and a count
 *      on anything that groups (the attachments tray, a run's divider, a
 *      folder's pocket); `StateNub` is the same flag end-on for objects too
 *      small for type. Review = --status-task-in_review · Changes requested =
 *      --status-task-blocked. Nothing else changes colour for state.
 *   4. Repose and light: every object lies 1–2.5° off square (stable per id;
 *      under 1° when it lies across a whole pane) under one top-left light —
 *      hairline + contact + ambient shadow as a `filter`, so it follows the
 *      silhouette.
 *   5. The ground (`--tac-ground`): one warm filled tone, with a faint grain,
 *      under the paper everywhere — the thread's trays, the panel's desk, the
 *      mats under an opened stack's rows and under a stack of one. In light it
 *      is deep enough that white paper holds its edge on it (about 1.2:1
 *      before the shadow).
 *   6. The lip (`ledge.ts`): one physical edge — a strip of the ground's
 *      material, lit along the top, throwing a crisp shadow on what stands
 *      behind it. An object's foot is always a few px behind it. It is the
 *      front of a thread row's tray, the rail a sheet slides under in the
 *      panel, and the front of the ledge a row of objects stands on (thread
 *      attachments, opened stack).
 *   7. Folder board (`--tac-folder*`, graphite in dark, manila in light,
 *      visibly grained) with a labelled tab and a curved shoulder, for
 *      whatever groups artifacts: the panel's run dividers, the gallery's
 *      stacks, the opened stack's own folder.
 *
 * KINDS (all in objects/, all through `ArtifactObject`)
 *   document  typeset sheet; REV stamp if a task document   image    photo print
 *   pdf       sheet, red spine, second page under           video    print + sprocket strip, play disc, duration tab
 *   slides    16:9 title slide: accent rule, the real       archive  kraft box: lid, hand-hole, paper label, fibre
 *             title large, "1 / N" footer (or the cover)    code     blueprint-blue sheet, numbered gutter, mono
 *   sheet     punched ledger, green rules, real rows        link     pale blue address card: the host in a white
 *   file      blank sheet, name / type / size typed on               bar, then its preview picture or its path
 *
 * SURFACES
 *   thread   `ThreadWorkProduct`: a 72px pocket — a filled tray with a front
 *            lip. The object (`xs`) stands at its left with its foot behind
 *            the lip; a sheet is taller than the tray and stands 10px proud of
 *            its top edge. Beside it: title, kind and values, summary (two
 *            lines at most), one action; the worded flag over the tray's
 *            top-right edge. The tray keeps a 40rem measure in a wide column
 *            and runs the full width of a column under 48rem (the thread
 *            beside an open pane).
 *            `ThreadAttachments`: one tray; `sm` objects stand on a ledge
 *            across it with captions under the ledge (filename whole, in mono;
 *            kind and size). Nubs on the objects, one "Review · N" flag on the
 *            tray's top edge.
 *   panel    `PanelBody`: the pane's body is the desk; there are no cards. A
 *            two-way switch (All / To review), then sections newest first, as
 *            in the product, each behind a `PanelDivider` (folder-board tab
 *            naming the agent and the count, a "Review · N" flag standing on
 *            the far end of the board, the run's start time under it).
 *            `PanelItem`, two ways of lying there. Paper and things stand in a
 *            slot at the left (`pn`): a sheet is set to be read — headline
 *            about 13px, first lines about 10px — and its foot slides under
 *            the rail that ends the row. Pictures lie across the whole desk
 *            (`pw`): an image, a video that plays in place, a link with its
 *            preview. Plain caption with ordinary buttons: title, kind and
 *            values, summary or the document's own first lines, filename and
 *            content type, who and when.
 *   gallery  `GalleryStacks`: the shelf. A stack is a `Folder` — back board,
 *            the stack's own artifacts standing in it as `fd` objects (one of
 *            each telling kind first; kept inside the folder's sides; flags as
 *            nubs), separate sheet tops behind them when it holds more than it
 *            shows (one, two, or four and a deeper mouth for a full one), and
 *            a pocket whose tab is the task identifier and whose face carries
 *            the title, a tally by kind, the count and the date, with a
 *            "Review · N" flag on its top edge. Hover lifts the contents out
 *            and fans them. A stack of one is the object itself (`gl`) on a
 *            mat with a lip, its lines beside it — a large thread row.
 *            `GalleryStack`: the folder opened. The same folder, open and
 *            empty, with the task's title as the heading beside it, the count,
 *            the date and the tally. Then the artifacts by day — heading with
 *            the year and a count, a tick ruler down the margin — on mats, in
 *            rows on ledges: `gl` objects (a sheet 178px wide; everything
 *            wider than tall sized to the grid cell, 244px) with the caption
 *            under the ledge (title, Open / Download at its end; time and
 *            author, whole). No tiles.
 *
 * MATERIALS (all --tac-*; light first, `.dark` overrides)
 *   tokens.css          paper, ink, prints, kind colours, flag, ground, lip, focus ring, folder board, grain, light, repose
 *   tokens-sizes.css    the size table (`xs`, `sm`) and what every size derives from --tac-k
 *   tokens-panel.css    desk, slot, divider, the `pn` and `pw` sizes, narrow-pane steps
 *   tokens-folder.css   the folder: face, pile, sizes, the slots its contents stand in
 *   tokens-gallery.css  shelf and mat grids, the `fd` and `gl` sizes, narrow-page steps
 *   Grain is three strengths: barely there on paper and prints, visible on
 *   folder board, kraft (with a fibre) and the lip, between the two on the
 *   ground, where UI type is set. Serif (--tac-font-serif) on paper only;
 *   machine values are mono.
 *
 * SIZES — `size` on an object sets `data-tac-size`, which sets --tac-k and
 * retunes the type so a small page shows fewer, larger words
 *   xs  0.258  62×80 sheet · 80px print     thread row
 *   sm  0.27   65×84 sheet · 108px print    thread attachments
 *   fd  0.5    120×155 sheet · 152px print  standing in a folder
 *   pn  0.61   146×189 sheet                panel, in a slot (every shape ≈146px wide)
 *   pw  —      as wide as the desk          panel, across: prints, the playable video, a link's card
 *   gl  0.74   178×229 sheet · 244px print  opened stack, stack of one
 *   Every size but `sm` scales each shape separately. --tac-fit shrinks a
 *   whole size inside a container query, never elsewhere.
 *
 * STATES
 *   hover / focus          object lifts 2px, ambient shadow doubles (an ancestor
 *                          carries `group/object`); the tray or mat steps one
 *                          tone; a folder's contents rise 12px and fan.
 *   pressed                the object goes back down, the tray a tone darker.
 *   focus-visible          a 2px ring at 72% of the foreground with a 2px gap in
 *                          the colour of what the control lies on: round the
 *                          tray (behind a sheet standing proud of it), on each
 *                          panel button, round the folder, round an opened
 *                          stack's object and caption (not the space above it).
 *   review                 the flag; nothing else changes colour.
 *   no / failed thumbnail  a print is left undeveloped (grey emulsion, struck
 *                          picture mark); a link's card drops the picture.
 *   long titles            wrap anywhere and clamp with an ellipsis in the UI
 *                          (thread 1 line, 2 in a narrow tray; panel 3; pocket
 *                          and gallery caption 2); on paper they wrap and fade.
 *   one vs many            a folder with contents and a pile, or the lone object.
 *   narrow                 thread: full-width trays, the action's label drops
 *                          under 24rem. panel: slot beside caption down to a
 *                          290px pane, then stacked. gallery: opened stack 4 /
 *                          3 / 2 columns at 1440 / 1024 / 768; the shelf keeps
 *                          two compact folders across at 768.
 *   reduced motion         nothing translates or rotates; shadow and tone still answer.
 */
export const kit: DirectionKit = {
  id: "d3-tactile",
  name: "3.Tactile",
  tagline: "Paper, prints and folders",
  ThreadWorkProduct,
  ThreadAttachments,
  PanelBody,
  GalleryStacks,
  GalleryStack,
};
