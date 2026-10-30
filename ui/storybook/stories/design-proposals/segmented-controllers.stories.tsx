import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { SegmentedControllersPreview, type SegmentedControllersPreviewProps } from "../../support/design-proposals/SegmentedControllersPreview";

const meta = {
  id: "design-segmented-controllers",
  title: "Design proposals/Components/Segmented controllers",
  component: SegmentedControllersPreview,
  args: { width: "full", disableAgentActions: false },
  argTypes: {
    width: { control: "inline-radio", options: ["full", "narrow"] },
    disableAgentActions: { control: "boolean" },
    onWidthChange: { control: false },
  },
  parameters: {
    layout: "fullscreen",
    paperclip: {
      capabilities: [], home: "design-proposals", status: "proposed",
      exception: "Cross-cutting comparison of segmented controller patterns from proposal and production surfaces.",
      implementation: "mixed", boundary: "fixtures",
      notes: "Mounts FilePreviewModeToggle directly and isolates existing TabsList/Button/native-button compositions from AuditFeed, TaskListToolbar, IssuesList, Agents, AgentDetail, Secrets, GoalDetail and IssueProperties. Local selection, disabled audit choice and narrow width are inspectable. No queries or mutations. Inline compositions are not page mounts; model lane retains existing incomplete radio keyboard behavior. Existing application controls are unchanged.",
    },
  },
  render: function Render(args) {
    const [, updateArgs] = useArgs<SegmentedControllersPreviewProps>();
    return <SegmentedControllersPreview {...args} onWidthChange={width => updateArgs({ width })} />;
  },
} satisfies Meta<typeof SegmentedControllersPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const Disabled: Story = { args: { disableAgentActions: true } };
export const Narrow: Story = { args: { width: "narrow" } };
