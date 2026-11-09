import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { TaskHoverCardPreview } from "../../support/design-proposals/TaskHoverCardPreview";

const meta = {
  id: "design-task-hover-card",
  title: "Design proposals/Components/Task hover card",
  component: TaskHoverCardPreview,
  args: { enabled: true, showDescription: true },
  argTypes: {
    enabled: { control: "boolean", description: "Enable the text link's existing optional hover preview. Activity keeps its preview; task summaries keep it off." },
    showDescription: { control: "boolean" },
    onEnabledChange: { control: false, table: { disable: true } },
  },
  render: function Preview(args) {
    const [, updateArgs] = useArgs();
    return <TaskHoverCardPreview {...args} onEnabledChange={enabled => updateArgs({ enabled })} />;
  },
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/issues"],
    paperclip: {
      capabilities: ["tasks/organize", "activity/overview"],
      status: "proposed", home: "design-proposals", implementation: "production", boundary: "fixtures",
      exception: "Proposed task preview appearance staged alongside the task list and shared popover tokens.",
      notes: "Mounts the shared IssueQuicklookCard, real task Link/IssueLinkQuicklook, ActivityRow and TaskSummaryList. The static specimen exposes styling; interactive examples retain production hover-intent, focus, dismissal and link behavior. The text-link control maps to disableIssueQuicklook; recent-task summaries remain opted out. The refreshed card follows the Paper reference: 280px width, 16px padding, status/ID/time metadata, 14px semibold two-line title and 12px three-line description; it omits project metadata and shares --shadow-flyout. Task details are seeded into the query cache; fixtures do not prove server access checks, navigation acceptance or live fetching.",
    },
  },
} satisfies Meta<typeof TaskHoverCardPreview>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const NoDescription: Story = { args: { showDescription: false } };
export const PreviewOff: Story = { args: { enabled: false } };
