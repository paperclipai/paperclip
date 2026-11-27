import type { Meta, StoryObj } from "@storybook/react-vite";
import { AppShellPreview } from "../../support/design-proposals/AppShellPreview";

const meta = {
  id: "design-app-shell",
  title: "Design proposals/Layouts/App shell",
  component: AppShellPreview,
  args: { rightSidebar: false, overflowingContent: false },
  argTypes: {
    rightSidebar: { control: "boolean", description: "Include the optional right pane." },
    overflowingContent: { control: "boolean", description: "Add enough placeholder content to review independent pane scrolling." },
  },
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/issues"],
    docs: { description: { component: "Shared proposed desktop layout, also used by Pages/Tasks. Import DesignPageShell from @/components/DesignPageShell and supply sidebar, title and children. Add rightSidebar and rightSidebarTitle for three panes; rightSidebarHeader and rightSidebarControls accept the production tab strip and window controls. rightSidebarMaximized expands the panel across the workspace; headerActions can supply a reopen button. These stories use the task-detail page's SidePanelTabs, SidePanelLauncher, SidePanelWindowControls and useSidePanelTabs for adding, selecting, closing and reordering tabs. Closing the last tab reveals the launcher. Sidebar width uses the existing resize shell; pass sidebarStorageKey to isolate preferences. The right pane defaults to 320px, capped at 30% on narrower desktops. Drag its highlighted divider or use the arrow keys to resize; double-click animates back to default using the shared 200ms reset motion (instant with reduced motion). Widths persist separately from the left sidebar and survive maximize/restore. Resizing preserves space for the main pane. Main and right content scroll independently beneath fixed headers; scrollbars hide after scrolling stops using the shared idle-delay token. Colors come from the proposed dark foundation. Tab bodies and placeholder blocks are fixture content. Mobile navigation and panel overlay behavior are not defined by these desktop specimens." } },
    paperclip: {
      capabilities: ["navigation-preferences/navigation"],
      home: "design-proposals",
      status: "proposed",
      exception: "Shared desktop app-shell layouts staged with the design refresh before adoption in production routes.",
      implementation: "production",
      boundary: "fixtures",
      notes: "Mounts the shared DesignPageShell, SidebarShell and DesignSidebar with neutral content slots. Two Panes is the same shell composition as Pages/Tasks. Three Panes adds production task-detail SidePanelTabs, SidePanelLauncher, SidePanelWindowControls and useSidePanelTabs through the shell's optional slots: add/select/close/reorder tabs, maximize/restore, close/reopen the pane, and recover from closing all tabs. Tab content is placeholder data, without task-detail API behavior. Independent Scrolling supplies overflowing content to both panes and uses the shared scrollbar-while-scrolling behavior. Both sidebars resize by dragging or keyboard, highlight their divider on hover/focus/drag, persist widths separately, and animate back to default on double-click. Reset timing matches the task-detail right pane; reduced motion resets instantly while dragging and keyboard resizing stay immediate. The right pane defaults to 320px capped at 30% on narrower desktops; custom widths retain space for the main pane and survive maximize/restore. Main and right surfaces use background, left uses muted, and dividers use border. Organization/account access, recent tasks and navigation destinations are fixtures. These dark desktop examples do not establish production routing, backend behavior, mobile layout or approved light-mode styling.",
    },
  },
} satisfies Meta<typeof AppShellPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TwoPanes: Story = {};
export const ThreePanes: Story = { args: { rightSidebar: true } };
export const IndependentScrolling: Story = { args: { rightSidebar: true, overflowingContent: true } };
