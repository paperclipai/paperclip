import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { installApiStub } from "@/needs-you-directions/api-stub";
import "@/needs-you-directions/api-routes";
import { DIRECTION_IDS, KIT_META, SURFACE_IDS, loadKit, surfaceOf, type DirectionId, type DirectionKit, type SurfaceId } from "@/needs-you-directions/kit";
import { SurfaceView } from "@/needs-you-directions/frames/SurfaceView";

type Args = { direction: DirectionId; surface: SurfaceId; animation: boolean };

function DirectionView({ direction, surface, animation }: Args) {
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
  useEffect(() => {
    const previous = document.documentElement.dataset.labAnim;
    if (animation) document.documentElement.dataset.labAnim = "1";
    else delete document.documentElement.dataset.labAnim;
    return () => {
      if (previous === undefined) delete document.documentElement.dataset.labAnim;
      else document.documentElement.dataset.labAnim = previous;
    };
  }, [animation]);
  if (!kit) return null;
  return <SurfaceView kit={kit} surface={surface} />;
}

const meta = {
  id: "design-needs-you-directions",
  title: "Design proposals/Patterns/Needs You directions/Compare",
  component: DirectionView,
  argTypes: {
    direction: {
      control: { type: "select" },
      options: DIRECTION_IDS,
      labels: Object.fromEntries(DIRECTION_IDS.map((id) => [id, KIT_META[id].name])),
      description: "Which direction's kit renders.",
    },
    surface: {
      control: { type: "select" },
      options: SURFACE_IDS,
      labels: Object.fromEntries(SURFACE_IDS.map((id) => [id, surfaceOf(id).label])),
      description: "Which product surface.",
    },
    animation: { control: { type: "boolean" }, description: "The lab's hover-motion toggle (html[data-lab-anim])." },
  },
  args: { direction: "today", surface: "landing", animation: true },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Pick a direction and a surface. 0.Today mounts the shipped Needs You components on the lab's fixtures; 1–2 are the explored directions. Page: https://paperclip-needs-you-directions.vercel.app.",
      },
    },
    paperclip: {
      capabilities: ["inbox-search/triage", "inbox-search/decisions"],
      status: "proposed",
      home: "design-proposals",
      implementation: "prototype",
      boundary: "fixtures",
      exception: "Design directory entry for Needs You: the shipped baseline and 2 proposed directions compared on static mocks of Landing, Card and Review-panel.",
      notes: "Controls pick a direction kit and a surface. Today mounts the shipped Needs You components behind the lab's fetch stub with the acmehats fixture world; the other kits are lab components. Frames are static mocks of the product chrome; nothing here establishes production behaviour or access checks.",
    },
  },
} satisfies Meta<typeof DirectionView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Compare: Story = { name: "Any direction, any surface" };
export const Today: Story = { name: "0.Today", args: { direction: "today" } };
export const D1: Story = { name: "1.Focus", args: { direction: "d1-focus" } };
export const D2: Story = { name: "2.Workspace", args: { direction: "d2-workspace" } };
export const TodayProductionPalette: Story = {
  name: "0.Today · production palette",
  args: { direction: "today" },
  parameters: { designProposalTheme: false },
};
