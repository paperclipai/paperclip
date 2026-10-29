const quote = (value) => JSON.stringify(value);

export default (ctx) => `import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { installApiStub } from "@/${ctx.slug}-directions/api-stub";
import "@/${ctx.slug}-directions/api-routes";
import { DIRECTION_IDS, KIT_META, SURFACE_IDS, loadKit, surfaceOf, type DirectionId, type DirectionKit, type SurfaceId } from "@/${ctx.slug}-directions/kit";
import { SurfaceView } from "@/${ctx.slug}-directions/frames/SurfaceView";

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
  id: ${quote(ctx.storyId)},
  title: ${quote(`Design proposals/${ctx.group}/${ctx.title} directions/Compare`)},
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
  args: { direction: "today", surface: ${quote(ctx.surfaces[0].id)}, animation: true },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          ${quote(`Pick a direction and a surface. 0.Today mounts the shipped ${ctx.title} components on the lab's fixtures; 1–${ctx.directions.length} are the explored directions. Page: ${ctx.publicUrl}.`)},
      },
    },
    paperclip: {
      capabilities: [${ctx.capabilities.map(quote).join(", ")}],
      status: "proposed",
      home: "design-proposals",
      implementation: "prototype",
      boundary: "fixtures",
      exception: ${quote(ctx.exception)},
      notes: ${quote(ctx.notes)},
    },
  },
} satisfies Meta<typeof DirectionView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Compare: Story = { name: "Any direction, any surface" };
export const Today: Story = { name: ${quote(ctx.today.name)}, args: { direction: "today" } };
${ctx.directions.map((direction) => `export const D${direction.digit}: Story = { name: ${quote(direction.name)}, args: { direction: ${quote(direction.id)} } };`).join("\n")}
export const TodayProductionPalette: Story = {
  name: "0.Today · production palette",
  args: { direction: "today" },
  parameters: { designProposalTheme: false },
};
`;
