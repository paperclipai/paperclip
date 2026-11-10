import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { ActivityListPreview, type ActivityListPreviewProps } from "../../support/design-proposals/ActivityListPreview";

const meta = {
  id: "design-activity-list",
  title: "Design proposals/Components/Activity list",
  component: ActivityListPreview,
  args: { density: "comfortable", containerWidth: "standard", withReferences: false },
  argTypes: {
    density: { control: "inline-radio", options: ["comfortable", "compact"] },
    containerWidth: { control: "inline-radio", options: ["standard", "narrow", "smallest"] },
    withReferences: { control: "boolean" },
    onDensityChange: { control: false, table: { disable: true } },
    onWidthChange: { control: false, table: { disable: true } },
  },
  render: function Preview(args) {
    const [, updateArgs] = useArgs<ActivityListPreviewProps>();
    return <ActivityListPreview {...args} onDensityChange={density => updateArgs({ density })} onWidthChange={containerWidth => updateArgs({ containerWidth })} />;
  },
  parameters: {
    layout: "fullscreen", initialEntries: ["/PAP/dashboard"],
    paperclip: {
      capabilities: ["activity/overview", "activity/activity", "tasks/organize"],
      status: "proposed", home: "design-proposals", implementation: "production", boundary: "fixtures",
      exception: "Reusable activity composition staged for dashboard integration in the local design sandbox.",
      notes: "Mounts ActivityList and the refreshed ActivityRow. Playground controls density and container width; mixed fixtures cover task, agent, project, approval, run and unlinked system events. Reuses task-row tokens, responsive metadata and CellMarquee hit testing. Task entries retain IssueLinkQuicklook, non-task events keep their entity destinations and never show a fabricated task ID. Fallback avatars use one initial through the proposal provider. Reference Changes retains added/removed issue references below the fixed-height row. Task preview data is seeded; fixture navigation does not establish production access checks or live backend acceptance. Sandbox toggle restores original dashboard rows and avatar policy.",
    },
  },
} satisfies Meta<typeof ActivityListPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const Narrow: Story = { args: { containerWidth: "narrow" } };
export const Smallest: Story = { args: { containerWidth: "smallest" } };
export const Compact: Story = { args: { density: "compact" } };
export const ReferenceChanges: Story = { args: { withReferences: true } };
