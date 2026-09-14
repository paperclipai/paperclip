import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { RuntimeServicesReview } from "../prototypes/RuntimeServicesReview";

const meta = {
  title: "Runtime Services/02 Task and properties",
  component: RuntimeServicesReview,
  parameters: { layout: "fullscreen", docs: { description: { component: "The complete production IssueDetail page and app shell. Covers TaskRuntimeServices inside IssueProperties, service controls, the breadcrumb properties toggle, mobile properties sheet, and navigation to the company service inventory. The agent message and service records are review fixtures. On mobile, use the properties button in the task header." } } },
  args: { page: "task", scenario: "ready" },
  decorators: [(Story, context) => <Story key={context.id} />],
} satisfies Meta<typeof RuntimeServicesReview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AgentFinishedPreviewRunning: Story = {};
export const Starting: Story = { args: { scenario: "starting" } };
export const Sleeping: Story = { args: { scenario: "sleeping" } };
export const Failed: Story = { args: { scenario: "failed" } };
export const ExistingCommandHandoff: Story = { args: { scenario: "handoff" } };
export const RefreshFailed: Story = { args: { scenario: "refresh-error" } };
export const NoServices: Story = { args: { scenario: "empty" } };
export const ReadOnlyViewer: Story = { args: { scenario: "viewer" } };
export const MobileProperties: Story = { globals: { viewport: { value: "mobile" } }, play: async ({ canvasElement }) => { await userEvent.click(await within(canvasElement).findByRole("button", { name: "Show properties" })); await expect(await within(canvasElement.ownerDocument.body).findByRole("link", { name: "All company services" })).toBeVisible(); } };
export const Light: Story = { globals: { theme: "light" } };

export const ServiceActions: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "More actions for Customer dashboard" }));
    const menu = within(canvasElement.ownerDocument.body);
    await expect(await menu.findByRole("menuitem", { name: "Restart" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy web URL" })).toBeVisible();
  },
};
