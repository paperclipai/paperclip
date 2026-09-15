import type { Meta, StoryObj } from "@storybook/react-vite";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { OriginatingTasksReview, SeedData } from "../prototypes/originating-tasks/OriginatingTasks";

const meta = {
  title: "UX Labs/Tasks Created From a Task",
  component: OriginatingTasksReview,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "UX prototype based on the existing PAP-1953 phase-topology fixture, with illustrative cross-project follow-ups. Renders the actual Layout and IssueDetail route, with the production TaskSidePanel. No replica page shell or CSS overrides. Full Task Page uses the production query wiring with fixture API responses. Both legacy and native run origins are included. Subtasks includes all subtasks; created work is grouped independently by project, so a created subtask appears in both sections. An unrelated task by the same agent is deliberately excluded. Subtasks reuse TaskDetailSubtasksPanel and its progress bar. All created work uses the same task rows, grouped by project or No project, without progress bars. Unfinished work precedes finished work. No counts on the Tasks tab, extra header, search, controls, or relationship tabs. Task navigation, local chat and side-panel tabs remain interactive. The story uses the production Tasks panel with fixture data." } },
  },
  args: { scenario: "mixed", fullPage: true, narrow: false },
  decorators: [(Story, context) => <SeedData key={context.id}><PluginLauncherProvider><Story /></PluginLauncherProvider></SeedData>],
} satisfies Meta<typeof OriginatingTasksReview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FullTaskPage: Story = {};
export const ImplementedTaskPage: Story = { args: { baseline: true } };
export const FirstTaskAppears: Story = { args: { scenario: "arrival" } };
export const MixedTasksPanel: Story = { args: { fullPage: false } };
export const SubtasksOnly: Story = { args: { fullPage: false, scenario: "subtasks" } };
export const OtherProjectsOnly: Story = { args: { fullPage: false, scenario: "other" } };
export const AllFinished: Story = { args: { fullPage: false, scenario: "completed" } };
export const Empty: Story = { args: { fullPage: false, scenario: "empty" } };
export const NarrowPanel: Story = { args: { fullPage: false, narrow: true }, globals: { viewport: { value: "mobile" } } };
export const FullTaskPageLight: Story = { globals: { theme: "light" } };
