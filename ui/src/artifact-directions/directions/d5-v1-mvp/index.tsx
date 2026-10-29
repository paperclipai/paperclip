import type { DirectionKit, LabGroup } from "../../kit";
import { FileTiles, GalleryView, TaskTiles } from "./GalleryView";
import { PanelBody } from "./PanelBody";
import { ThreadAttachments, ThreadWorkProduct } from "./Thread";
import "./tokens.css";

/**
 * V1 MVP — built from the PCLP-Core Figma mocks ("Art.Tab - mvp v1",
 * node 2129:133457), one section at a time. Sections drawn so far:
 *
 * ARTIFACTS PAGE
 *  - A task with several artifacts is a stack: its newest artifact as the
 *    first page on one of two backings — sheets for text and documents, sheets
 *    for media — with the task title, its identifier in a pill, the count and
 *    "Updated …" underneath (Stack.tsx, Tile.tsx).
 *  - An artifact on its own is one of four treatments: a text file whose title
 *    is known shows the white sheet with the title set on it; any other file
 *    or document the white sheet with a centred faint glyph and the type in
 *    caps centred under it (node 2205:138266, 2026-10-21); landscape
 *    and portrait media a bordered print; media without a preview the grey
 *    sheet with a play button (Sheet.tsx, MediaPrint.tsx, kinds.ts).
 *  - Filters: Tasks (default, one tile per task) · All files (every artifact,
 *    flat) · Images · Videos · Documents · Text · Files (GalleryView.tsx).
 *  - Hover: the cell fills in with a 12px radius (Tile.tsx); the earlier
 *    random-twist experiment was removed on request.
 *
 * SIDE PANEL — Artifacts tab (node 2096:87691)
 *  - A flat list, newest first, of 56px rows: a 40px document icon (the
 *    mock's grey doc shape, a white glyph and the type in caps) or a 40px
 *    thumbnail (a play disc over it for video), the file name truncating
 *    before its extension, and "size · date" (PanelRow.tsx, PanelBody.tsx).
 *
 * TASK THREAD (node 2096:86523)
 *  - The panel's rows again. A work product between turns is one full-width
 *    row; the artifacts a message produced hang under its footer, 12px below,
 *    inline at equal widths 8px apart, wrapping past three (Thread.tsx).
 */
export const kit: DirectionKit = {
  id: "d5-v1-mvp",
  name: "5.MVP V1",
  tagline: "From the PCLP-Core mocks, one section at a time",
  ThreadWorkProduct,
  ThreadAttachments,
  threadAttachmentsAfterFooter: true,
  PanelBody,
  GalleryView,
  GalleryStacks: ({ groups }: { groups: LabGroup[] }) => <TaskTiles groups={groups} />,
  GalleryStack: ({ group }: { group: LabGroup }) => <FileTiles artifacts={group.artifacts} />,
};
