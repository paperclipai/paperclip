import type { Meta, StoryObj } from "@storybook/react-vite";
import { FlyoutPreview } from "../../support/design-proposals/FlyoutPreview";

const meta = {
  id: "design-flyout",
  title: "Design proposals/Components/Popover",
  component: FlyoutPreview,
  args: { mode: "columns", shadow: "" },
  argTypes: {
    mode: { control: "select", options: ["columns", "views", "account-menu"] },
    shadow: { name: "Shadow", control: "text", description: "Local CSS box-shadow override. Clear to inherit --shadow-flyout. Save the approved default in ui/src/index.css to apply it to every refreshed flyout." },
  },
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Reusable Flyout, FlyoutContent, FlyoutHeader and FlyoutOptions composed from the existing Popover and Button primitives. Dropdown menus share the same sections and appearance while preserving menu-specific keyboard behavior. Muted-foreground labels and checkmarks become foreground on muted-highlight during hover or focus. The Shadow control is a local preview; --shadow-flyout in the shared token layer owns the saved default." } },
    paperclip: {
      capabilities: ["tasks/organize"],
      status: "proposed",
      home: "design-proposals",
      exception: "Shared flyout component and shadow tuning reference staged with the task-list design refresh.",
      implementation: "production",
      boundary: "fixtures",
      notes: "Isolates the shared flyout composition used by the proposed page menus. Columns demonstrates toggle buttons and inherited-color checks; Views shares the page choices Inbox, Unread, Needs attention and All tasks, using existing radio-menu semantics with checkmarks; Account Menu mounts the canonical SidebarAccountMenu with the same DesignProposalAccess fixture boundary as Sidebar/Account Menu. Its profile link, Settings, Invite, Documentation, theme action, dismissal and focus behavior come directly from that component. Router and owner-access fixtures do not prove backend behavior or permission enforcement. Shadow controls affect this preview only; approved values belong in the shared --shadow-flyout token.",
    },
  },
} satisfies Meta<typeof FlyoutPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Columns: Story = {};
export const Views: Story = { args: { mode: "views" } };
// Keep the original story ID so existing review links remain valid.
export const Profile: Story = { name: "Account Menu", args: { mode: "account-menu" } };
