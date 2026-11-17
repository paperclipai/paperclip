import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { kit as hybrid } from "@/artifact-directions/directions/d4-hybrid";
import { LAB_KINDS, type LabArtifact, type LabKind } from "@/artifact-directions/kit";
import {
  GROUPS,
  KIND_SPECIMENS,
  OPEN_GROUP,
  PANEL_ARTIFACTS,
  THREAD_ATTACHMENTS,
  THREAD_WORK_PRODUCTS,
} from "@/artifact-directions/fixtures";
import { KindsSheet } from "@/artifact-directions/frames/KindsSheet";
import { TASK_DETAIL_PANE_WIDTH } from "@/artifact-directions/frames/PanelFrame";
import { Slot } from "@/artifact-directions/frames/Slot";
import { SurfaceView } from "@/artifact-directions/frames/SurfaceView";

/**
 * 4 · Hybrid from the artifact-directions lab (`ui/src/artifact-directions`):
 * Tint's containers, folders, filter bar and colour with Tactile's white
 * typeset paper. The surface stories render the kit inside the lab's static
 * mocks of the real chrome, exactly as the lab page does; the slot stories
 * render one kit slot on its own at the width that slot has in the product.
 * Theme comes from the toolbar. No live API requests.
 */

const meta = {
  id: "design-artifact-directions-hybrid",
  title: "Design proposals/Artifact directions/4.Hybrid",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The Hybrid direction on the three artifact surfaces (thread, side panel, Artifacts page), plus each of its five slots alone. Data is the lab's acmehats fixture world.",
      },
    },
    paperclip: {
      capabilities: ["documents-artifacts/library", "documents-artifacts/work-products", "documents-artifacts/attachments"],
      status: "proposed",
      home: "design-proposals",
      implementation: "prototype",
      boundary: "fixtures",
      exception: "Design exploration staged in the artifact directions lab: the Hybrid direction on static mocks of the task thread, the side panel and the Artifacts page, and each of its slots alone.",
      notes: "Lab components only, fed with the acmehats fixture world; no live API requests. Surface stories render the kit inside the lab's static chrome mocks; slot stories render one kit slot at its product width. Nothing here establishes production behaviour.",
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Surfaces — the kit inside the lab's app-shell mocks.

export const Thread: Story = {
  name: "Surface · Thread",
  render: () => <SurfaceView kit={hybrid} surface="thread" />,
};

export const Panel: Story = {
  name: "Surface · Panel",
  render: () => <SurfaceView kit={hybrid} surface="panel" />,
};

export const Gallery: Story = {
  name: "Surface · Artifacts page",
  render: () => <SurfaceView kit={hybrid} surface="gallery" />,
};

export const Stack: Story = {
  name: "Surface · Opened stack",
  render: () => <SurfaceView kit={hybrid} surface="stack" />,
};

export const Kinds: Story = {
  name: "Vocabulary sheet",
  render: () => <KindsSheet kit={hybrid} />,
};

// ---------------------------------------------------------------------------
// Slots — one kit slot alone, on the page fill, at its product width.

const THREAD_COLUMN_WIDTH = 960;
const GALLERY_WIDTH = 1152;

function Stage({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <Slot kit={hybrid} className="mx-auto" >
        <div style={{ maxWidth: width }}>{children}</div>
      </Slot>
    </div>
  );
}

type ReviewArg = "none" | "needs_review" | "changes_requested";

/** The first specimen of a kind, with the review state the story asks for. */
function specimen(kind: LabKind, review: ReviewArg): LabArtifact {
  const base = [...THREAD_WORK_PRODUCTS, ...KIND_SPECIMENS].find((artifact) => artifact.kind === kind) ?? KIND_SPECIMENS[0];
  return { ...base, review: review === "none" ? null : review };
}

type SlotArgs = { kind: LabKind; review: ReviewArg };

const slotArgTypes = {
  kind: { control: { type: "select" as const }, options: LAB_KINDS, description: "Which fixture artifact to show." },
  review: {
    control: { type: "radio" as const },
    options: ["none", "needs_review", "changes_requested"],
    description: "Review state carried by the artifact.",
  },
};

export const ThreadWorkProduct: StoryObj<SlotArgs> = {
  name: "Slot · Thread work-product row",
  args: { kind: "pdf", review: "needs_review" },
  argTypes: slotArgTypes,
  render: ({ kind, review }) => (
    <Stage width={THREAD_COLUMN_WIDTH}>
      <hybrid.ThreadWorkProduct artifact={specimen(kind, review)} />
    </Stage>
  ),
};

export const ThreadAttachments: Story = {
  name: "Slot · Thread attachments",
  render: () => (
    <Stage width={THREAD_COLUMN_WIDTH}>
      <hybrid.ThreadAttachments artifacts={THREAD_ATTACHMENTS} />
    </Stage>
  ),
};

export const PanelBody: Story = {
  name: "Slot · Panel body",
  render: () => (
    // The pane is 434px with 16px of padding around the body, as PanelFrame lays it out.
    <Stage width={TASK_DETAIL_PANE_WIDTH - 32}>
      <hybrid.PanelBody artifacts={PANEL_ARTIFACTS} />
    </Stage>
  ),
};

export const GalleryStacks: Story = {
  name: "Slot · Stacks grid",
  render: () => (
    <Stage width={GALLERY_WIDTH}>
      <hybrid.GalleryStacks groups={GROUPS} />
    </Stage>
  ),
};

export const GalleryStack: Story = {
  name: "Slot · Opened stack",
  render: () => (
    <Stage width={GALLERY_WIDTH}>
      <hybrid.GalleryStack group={OPEN_GROUP} />
    </Stage>
  ),
};
