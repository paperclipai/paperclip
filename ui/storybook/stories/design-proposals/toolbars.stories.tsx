import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { ToolbarsPreview, type ToolbarsPreviewProps } from "../../support/design-proposals/ToolbarsPreview";

const meta = {
  id: "design-toolbars",
  title: "Design proposals/Components/Toolbars",
  component: ToolbarsPreview,
  args: { family: "all", width: "full" },
  argTypes: {
    family: { control: "select", options: ["all", "tasks", "decisions", "skills", "artifacts", "projects", "routines"] },
    width: { control: "inline-radio", options: ["full", "medium", "narrow"] },
    onWidthChange: { control: false },
  },
  parameters: {
    layout: "fullscreen", initialEntries: ["/PAP/issues"],
    docs: { description: { component: "Canonical Design Proposals toolbar references. TaskListToolbar is the shared proposal and sandbox Tasks control surface; DecisionsToolbar is the shipped WhatNeedsMe and DecisionQueuePage search/filter/group/sort control set. SkillsToolbar, ArtifactsToolbar ProjectsToolbar and RoutinesToolbar are shared with the shipped pages. Interactive local fixtures preserve real component/menu behavior. Width controls expose wrapping. Backend actions and production adoption are not acceptance claims." } },
    paperclip: {
      capabilities: ["tasks/organize", "inbox-search/views", "inbox-search/decisions", "skills/discovery", "documents-artifacts/library", "projects/lifecycle", "routines/management"],
      home: "design-proposals", status: "proposed",
      exception: "Canonical toolbar families staged in Design Proposals for system reuse and styling before production adoption.",
      implementation: "mixed", boundary: "fixtures",
      notes: "Mounts TaskListToolbar with useTaskListCollection and DecisionsToolbar directly. All use the proposal theme and refreshed flyouts. Search, task view/layout/expansion, filters, decision grouping/sorting update local state. Task view preference uses an isolated story storage key. Create callbacks only report intent. Existing page and button stories retain their IDs and reuse the same source components. SkillsToolbar and ArtifactsToolbar also render directly; their pages consume the same extracted presentation with existing controllers unchanged. Scan busy/completed state is manually simulated. Skills mounts the shared Installed/Discover/My Skills route links below its controls, with Installed active; Sources remains in New > Manage sources. Link destinations are fixtures, not page-navigation acceptance. Canonical controls share ToolbarSearch, 44px height, opaque border, radius, padding and gap under the proposal theme. Control rows begin with search and end with the primary action when present. Tasks retains its view/heading dropdown before search with the same four persisted choices. ProjectsToolbar shares search, existing sort fields/directions and the create callback with Projects. Decisions search uses the same client-side matching helper as the desk and queue pages, with synthetic decision data. Artifact type filters retain their existing tab semantics; geometry is normalized inside the toolbar. No backend changes.",
    },
  },
  render: function Render(args) {
    const [, updateArgs] = useArgs<ToolbarsPreviewProps>();
    return <ToolbarsPreview {...args} onWidthChange={width => updateArgs({ width })} />;
  },
} satisfies Meta<typeof ToolbarsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
export const Tasks: Story = { args: { family: "tasks" } };
export const Decisions: Story = { args: { family: "decisions" } };
export const Narrow: Story = { args: { width: "narrow" } };

export const Skills: Story = { args: { family: "skills" } };
export const Artifacts: Story = { args: { family: "artifacts" } };

export const Projects: Story = { args: { family: "projects" } };

export const Routines: Story = { args: { family: "routines" } };
