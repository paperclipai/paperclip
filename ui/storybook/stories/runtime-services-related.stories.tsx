import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { RuntimeServicesReview } from "../prototypes/RuntimeServicesReview";

const meta = {
  title: "Runtime Services/04 Related app pages",
  component: RuntimeServicesReview,
  parameters: { layout: "fullscreen", docs: { description: { component: "Other production pages touched by this work. The environment delete dialog explains why retained service files prevent removal. Preview sign-in carries a return path; successful authentication and the cross-origin handoff require the actual gateway and are not simulated here. No real credentials should be entered." } } },
  args: { page: "environments", scenario: "ready" },
  decorators: [(Story, context) => <Story key={context.id} />],
} satisfies Meta<typeof RuntimeServicesReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EnvironmentWithRetainedServices: Story = {};
export const EnvironmentDeletionBlocked: Story = { play: async ({ canvasElement }) => { const c = within(canvasElement); await userEvent.click(await c.findByTestId("environment-delete-button")); await expect(await within(canvasElement.ownerDocument.body).findByText("This environment contains retained service files. Release their data retention before deleting it.")).toBeVisible(); } };
export const PreviewSignIn: Story = { args: { page: "auth" } };
export const PreviewSignInMobile: Story = { args: { page: "auth" }, globals: { viewport: { value: "mobile" } } };
