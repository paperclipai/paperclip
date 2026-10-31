import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import capBlack from "@/artifact-directions/assets/cap-shot-black.svg";
import capForest from "@/artifact-directions/assets/cap-shot-forest.svg";
import contactSheet from "@/artifact-directions/assets/contact-sheet-interface-craft.svg";
import reelPoster from "@/artifact-directions/assets/cap-reel-poster.svg";
import { ArtifactRow, ArtifactRowGroup, ArtifactSingleTile, ArtifactStackTile, ArtifactTileGrid, inlineRowStyle, type ArtifactSubject } from "@/components/artifacts/v1";

/**
 * The Artifacts V1 primitives (Settings > Experimental > Artifacts V1) on
 * fixtures: the page's stack and single tiles, and the row the panel and the
 * thread share. Pictures are the artifact directions lab's drawings.
 */

const NOW = new Date("2026-09-28T18:00:00");

const subject = (overrides: Partial<ArtifactSubject> & Pick<ArtifactSubject, "kind" | "title">): ArtifactSubject => ({
  updatedAt: "2026-09-28T11:07:00",
  taskIdentifier: "ACM-3",
  ...overrides,
});

const deckPdf = subject({ kind: "pdf", title: "Interface Craft revision — PDF", filename: "acmehats-interface-craft.pdf", contentType: "application/pdf", sizeLabel: "57.7 KB" });
const deckPptx = subject({ kind: "slides", title: "Interface Craft revision — editable PowerPoint", filename: "acmehats-interface-craft.pptx", sizeLabel: "90.1 KB" });
const guideMd = subject({ kind: "document", title: "Interface Craft deck guide", filename: "deck-guide.md", contentType: "text/markdown", sizeLabel: "5.9 KB" });
const critique = subject({ kind: "document", title: "Interface Craft critique and implemented changes", hasText: true, isTaskDocument: true });
const sheetPng = subject({ kind: "image", title: "Slide overview", filename: "contact-sheet.png", contentType: "image/png", thumbnailUrl: contactSheet, aspect: 4 / 3, sizeLabel: "422.9 KB" });
const forest = subject({ kind: "image", title: "Forest green — studio hero", filename: "cap-forest-hero.jpg", contentType: "image/jpeg", thumbnailUrl: capForest, aspect: 3 / 2, sizeLabel: "1.2 MB", taskIdentifier: "ACM-5", updatedAt: "2026-09-27T15:12:00" });
const black = subject({ kind: "image", title: "Black and cream — stacked, portrait", filename: "cap-black-portrait.jpg", contentType: "image/jpeg", thumbnailUrl: capBlack, aspect: 4 / 5, sizeLabel: "1.0 MB", taskIdentifier: "ACM-5", updatedAt: "2026-09-27T14:58:00" });
const reel = subject({ kind: "video", title: "Signal orange — 360° turntable", filename: "signal-orange-360.webm", contentType: "video/webm", thumbnailUrl: reelPoster, aspect: 16 / 9, sizeLabel: "3.4 MB", taskIdentifier: "ACM-5", updatedAt: "2026-09-27T14:44:00" });
const sting = subject({ kind: "file", title: "Brand sting — 12 second loop", filename: "acmehats-sting.mp3", contentType: "audio/mpeg", sizeLabel: "403.0 KB", taskIdentifier: "ACM-5" });
const zip = subject({ kind: "archive", title: "Editing source", filename: "editing-source.zip", contentType: "application/zip", sizeLabel: "184.6 KB" });
const storefront = subject({ kind: "link", title: "Storefront preview", taskIdentifier: "ACM-1", updatedAt: "2026-09-27T09:00:00" });

function Stage({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div className="bg-background p-6 text-foreground">
      <div style={{ width }}>{children}</div>
    </div>
  );
}

const meta = {
  id: "components-artifact-v1-primitives",
  title: "Tasks and conversations/Documents, attachments, and work products/Components/Artifact V1 primitives",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The Artifacts V1 primitives behind Settings > Experimental > Artifacts V1: stack and single tiles for the Artifacts page, and the row the panel's Artifacts tab and the task thread share. Fixtures only.",
      },
    },
    paperclip: {
      capabilities: ["documents-artifacts/library", "documents-artifacts/work-products", "documents-artifacts/attachments"],
      status: "proposed",
      implementation: "production",
      boundary: "fixtures",
      notes: "Mounts the production ArtifactStackTile, ArtifactSingleTile, ArtifactRow and ArtifactRowGroup from ui/src/components/artifacts/v1 on fixture subjects with the lab's drawings as pictures. Hover a tile to see the page fan and the artwork rise (not under reduced motion). No API requests; links go nowhere.",
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Stacks: Story = {
  name: "Stack tiles",
  render: () => (
    <Stage width={1152}>
      <ArtifactTileGrid>
        <ArtifactStackTile identifier="ACM-3" title="Create visual directions and first acmehats brand deck" count={21} updatedAt="2026-09-28T11:07:00" front={critique} now={NOW} />
        <ArtifactStackTile identifier="ACM-5" title="Shoot cap product photos for the storefront" count={6} updatedAt="2026-09-27T15:12:00" front={forest} now={NOW} />
        <ArtifactStackTile identifier="ACM-5" title="Shoot cap product photos for the storefront" count={6} updatedAt="2026-09-27T14:58:00" front={black} now={NOW} />
        <ArtifactStackTile identifier="ACM-6" title="Build the wholesale pricing model" count={3} updatedAt="2026-09-24T15:36:00" front={subject({ kind: "sheet", title: "Wholesale pricing model", filename: "wholesale-pricing-model.xlsx", taskIdentifier: "ACM-6" })} now={NOW} />
        <ArtifactStackTile identifier="ACM-5" title="Shoot cap product photos for the storefront" count={6} updatedAt="2026-09-27T14:44:00" front={reel} now={NOW} />
        <ArtifactStackTile identifier="ACM-5" title="Shoot cap product photos for the storefront" count={6} updatedAt="2026-09-27T14:40:00" front={sting} now={NOW} />
      </ArtifactTileGrid>
    </Stage>
  ),
};

export const Singles: Story = {
  name: "Single tiles",
  render: () => (
    <Stage width={1152}>
      <ArtifactTileGrid>
        <ArtifactSingleTile subject={critique} now={NOW} />
        <ArtifactSingleTile subject={deckPdf} now={NOW} />
        <ArtifactSingleTile subject={sheetPng} now={NOW} />
        <ArtifactSingleTile subject={black} now={NOW} />
        <ArtifactSingleTile subject={reel} now={NOW} />
        <ArtifactSingleTile subject={sting} now={NOW} />
        <ArtifactSingleTile subject={zip} now={NOW} />
        <ArtifactSingleTile subject={storefront} now={NOW} />
      </ArtifactTileGrid>
    </Stage>
  ),
};

export const Rows: Story = {
  name: "Rows (panel)",
  render: () => (
    <Stage width={402}>
      <ul className="flex flex-col gap-(--artifact-row-gap)">
        {[zip, deckPptx, guideMd, critique, sheetPng, deckPdf, reel, sting, storefront].map((item) => (
          <li key={item.title}>
            <ArtifactRow subject={item} now={NOW} />
          </li>
        ))}
      </ul>
    </Stage>
  ),
};

export const GroupedRows: Story = {
  name: "Rows grouped inline (thread)",
  render: () => (
    <Stage width={960}>
      <ArtifactRowGroup>
        {[sheetPng, deckPptx, deckPdf, guideMd, zip].map((item) => (
          <ArtifactRow key={item.title} subject={item} style={inlineRowStyle} now={NOW} />
        ))}
      </ArtifactRowGroup>
    </Stage>
  ),
};
