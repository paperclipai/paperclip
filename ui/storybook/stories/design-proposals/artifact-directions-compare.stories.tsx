import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { installApiStub } from "@/artifact-directions/api-stub";
import { DIRECTION_IDS, KIT_META, loadKit, type DirectionId, type DirectionKit } from "@/artifact-directions/kit";
import { KindsSheet } from "@/artifact-directions/frames/KindsSheet";
import { SURFACE_IDS, SurfaceView, type SurfaceId } from "@/artifact-directions/frames/SurfaceView";

/**
 * Every direction in the artifact-directions lab, switchable from Controls, so
 * two directions can be compared on the same surface without leaving
 * Storybook. Kits load on demand, the way the lab page loads them, behind the
 * lab's `/api/` stub: Today's shipped components fetch the fixtures through it
 * (the stub is in place before the kit renders, and restored when the story
 * unmounts or the direction changes).
 */

type View = SurfaceId | "kinds";

type Args = { direction: DirectionId; view: View };

function DirectionView({ direction, view }: Args) {
  const [kit, setKit] = useState<DirectionKit | null>(null);
  useEffect(() => {
    const restoreFetch = installApiStub();
    let live = true;
    loadKit(direction).then((loaded) => {
      if (live) setKit(loaded);
    });
    return () => {
      live = false;
      restoreFetch();
    };
  }, [direction]);
  if (!kit) return null;
  return view === "kinds" ? <KindsSheet kit={kit} /> : <SurfaceView kit={kit} surface={view} />;
}

const meta = {
  id: "design-artifact-directions-compare",
  title: "Design proposals/Artifact directions/Compare",
  component: DirectionView,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Pick a direction and a surface. Today is the shipped components fed with the lab's fixtures; 1–5 are the explored directions.",
      },
    },
    paperclip: {
      capabilities: ["documents-artifacts/library", "documents-artifacts/work-products", "documents-artifacts/attachments"],
      status: "proposed",
      home: "design-proposals",
      implementation: "prototype",
      boundary: "fixtures",
      exception: "Design exploration staged in the artifact directions lab: the shipped baseline and five proposed directions compared on static mocks of the task thread, the side panel and the Artifacts page.",
      notes: "Controls pick a direction kit and a surface. Today mounts the shipped artifact components behind the lab's fetch stub with the acmehats fixture world; the other kits are lab components. Frames are static mocks of the product chrome; nothing here establishes production behaviour or access checks.",
    },
  },
  argTypes: {
    direction: {
      control: { type: "select" },
      options: DIRECTION_IDS,
      labels: Object.fromEntries(DIRECTION_IDS.map((id) => [id, KIT_META[id].name])),
      description: "Which direction's kit renders.",
    },
    view: {
      control: { type: "select" },
      options: [...SURFACE_IDS, "kinds"],
      description: "Which surface, or the vocabulary sheet.",
    },
  },
  args: { direction: "d4-hybrid", view: "gallery" },
} satisfies Meta<typeof DirectionView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AnyDirection: Story = { name: "Any direction, any surface" };
