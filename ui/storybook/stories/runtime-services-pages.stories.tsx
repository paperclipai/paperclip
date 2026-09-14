import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { RuntimeServicesReview } from "../prototypes/RuntimeServicesReview";

const meta = {
  title: "Runtime Services/01 Company services",
  component: RuntimeServicesReview,
  parameters: { layout: "fullscreen", docs: { description: { component: "Review of the actual service pages, Sidebar, BreadcrumbBar, routing and shared controls changed by Runtime Services V2. All data and mutations are simulated in this browser; no sandbox or real service is created. Open service names to navigate, try Start/Stop/Restart and Logs, or create a service. Preview links use reserved .invalid domains. Theme and viewport are available in the Storybook toolbar." } } },
  args: { page: "inventory", scenario: "ready" },
  decorators: [(Story, context) => <Story key={context.id} />],
} satisfies Meta<typeof RuntimeServicesReview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Inventory: Story = {};
export const Empty: Story = { args: { scenario: "empty" } };
export const Loading: Story = { args: { scenario: "loading" } };
export const RefreshFailed: Story = { args: { scenario: "refresh-error" } };
export const Viewer: Story = { args: { scenario: "viewer" } };
export const Mobile: Story = { globals: { viewport: { value: "mobile" } } };
export const Light: Story = { globals: { theme: "light" } };
export const CreateService: Story = {
  play: async ({ canvasElement }) => { const c = within(canvasElement); await userEvent.click(await c.findByRole("button", { name: "New service" })); await expect(c.getByRole("form", { name: "Create service" })).toBeVisible(); },
};
export const CreateWithTaskAndEnvironment: Story = {
  play: async ({ canvasElement }) => { const c = within(canvasElement); await userEvent.click(await c.findByRole("button", { name: "New service" })); await userEvent.click(c.getByText("Task and environment")); await expect(c.getByLabelText("Associated task")).toBeVisible(); },
};
export const CompanyDefaultsAndLimits: Story = {
  play: async ({ canvasElement }) => { const c = within(canvasElement); const button = await c.findByRole("button", { name: "Company defaults and limits" }); await waitFor(() => expect(button).toBeEnabled()); await userEvent.click(button); await expect(c.getByLabelText("Running service limit")).toBeVisible(); },
};
