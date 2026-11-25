import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { SidebarPreview } from "../../support/design-proposals/SidebarPreview";

const meta = {
  id: "design-sidebar",
  title: "Design proposals/Components/Sidebar",
  component: SidebarPreview,
  args: { scenario: "default" },
  argTypes: { scenario: { control: false } },
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/issues"],
    docs: { description: { component: "Shared proposed DesignSidebar, also mounted by Pages/Tasks. Uses the production organization/account menus, navigation primitives, resize shell, task composer and command palette. Review resizing, selected/hover/focus states, truncated label motion, scrolling recents and menus here; check the Tasks page for the full composition. Story widths persist separately from the page. Fixture navigation and owner access do not establish production routes or permissions." } },
    paperclip: {
      capabilities: ["tasks/organize", "inbox-search/search"],
      status: "proposed",
      home: "design-proposals",
      exception: "Shared navigation component staged for refinement with the proposed task-list page.",
      implementation: "production",
      boundary: "fixtures",
      notes: "Renders the same DesignSidebar as Pages/Tasks inside DesignPageShell and SidebarShell. Default supports hover, focus, resizing and dialogs; Narrow uses the real resize handle's Home key. Long Labels, Many Recent Tasks and Empty Recent Tasks vary supplied fixtures without replacing navigation markup. Organization Menu and Account Menu open existing production menus with shared owner-access fixtures and proposed Popover appearance. Recents remain company scoped and scroll independently beneath their fixed heading; the shared scrollbar is visible only during scrolling and its short token-defined idle interval. Story-specific width storage isolates review from the page. Company data, recent tasks, router destinations and owner identity are simulated; production backend, permission enforcement and mobile composition are outside this review.",
    },
  },
} satisfies Meta<typeof SidebarPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Narrow: Story = {
  args: { scenario: "narrow" },
  play: async ({ canvasElement }) => {
    const handle = await within(canvasElement).findByRole("separator", { name: "Resize sidebar" });
    handle.focus();
    await userEvent.keyboard("{Home}");
  },
};
export const LongLabels: Story = { args: { scenario: "long-labels" } };
export const ManyRecentTasks: Story = { args: { scenario: "many-recents" } };
export const EmptyRecentTasks: Story = { args: { scenario: "empty-recents" } };
export const OrganizationMenu: Story = {
  args: { scenario: "organization-menu" },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: /organization switcher/ }));
  },
};
export const AccountMenu: Story = {
  args: { scenario: "account-menu" },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Open account menu" }));
  },
};
