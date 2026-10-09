import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ConnectorCatalogNavigation } from "../prototypes/ConnectorCatalogNavigation";

const meta = {
  title: "Apps/Catalog source selection",
  component: ConnectorCatalogNavigation,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Focused chip navigation: Paperclip, Composio, Arcade, Installed, and All. Connected accounts remain above the paginated catalog. Uses shipped connection cards, public catalogs with native duplicates omitted, and sample saved accounts. No account authorization or mutations." } },
  },
  argTypes: {
    initialSource: { control: "select", options: ["paperclip", "composio", "arcade", "installed", "all"] },
    pageSize: { control: "select", options: [50] },
  },
} satisfies Meta<typeof ConnectorCatalogNavigation>;
export default meta;
type Story = StoryObj<typeof meta>;

// Keep the existing review URL while replacing the tab presentation with chips.
export const SourceTabs: Story = { name: "Chips" };
export const Composio: Story = { args: { initialSource: "composio" } };
export const Arcade: Story = { args: { initialSource: "arcade" } };
export const MultipleManagedAccounts: Story = { args: { initialQuery: "notion" } };
export const Installed: Story = { args: { initialSource: "installed" } };
export const All: Story = { args: { initialSource: "all" } };
export const GlobalSearch: Story = { args: { initialQuery: "calendar" } };
export const InstalledSearch: Story = { args: { initialSource: "installed", initialQuery: "Meeting notes" } };
export const EmptyInstalledSearch: Story = { args: { initialSource: "installed", initialQuery: "spotify" } };
export const NativeConnectionWins: Story = { args: { initialQuery: "github" } };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };

export const SwitchFiltersAndSearch: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const filters = within(canvas.getByRole("navigation", { name: "App filters" }));
    await userEvent.click(filters.getByRole("button", { name: "Composio" }));
    await expect(filters.getByRole("button", { name: "Composio" })).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("list", { name: "Connected connectors" })).toHaveTextContent("Meeting notes");
    await userEvent.click(canvas.getByRole("button", { name: "Next page" }));
    await expect(canvas.getByRole("navigation", { name: "Catalog pages" })).toHaveTextContent("51–100");
    await userEvent.click(filters.getByRole("button", { name: "Installed" }));
    await expect(canvas.queryByRole("list", { name: "Available connectors" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("navigation", { name: "Catalog pages" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("list", { name: "Connected connectors" })).toHaveTextContent("Team workspace");
    await userEvent.type(canvas.getByRole("textbox", { name: "Search connectors" }), "Meeting notes");
    await expect(filters.getByRole("button", { name: "Installed" })).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("button", { name: "Manage Circleback" })).toBeVisible();
    await expect(canvas.queryByRole("heading", { name: "Notion" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }));
    await userEvent.click(filters.getByRole("button", { name: "Paperclip" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Search connectors" }), "calendar");
    await expect(filters.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("list", { name: "Available connectors" })).toHaveTextContent("Microsoft Outlook Calendar");
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }));
    await expect(filters.getByRole("button", { name: "Paperclip" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(filters.getByRole("button", { name: "All" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Search connectors" }), "github");
    await expect(canvas.getByRole("heading", { name: "GitHub" })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /Connect GitHub through/ })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }));
    await expect(filters.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  },
};
