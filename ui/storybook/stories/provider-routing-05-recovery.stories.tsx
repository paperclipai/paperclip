import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Recovery } from "../prototypes/provider-routing/Recovery";
import { ReviewFrame } from "../prototypes/provider-routing/shared";
import { reviewLifecycle } from "../prototypes/provider-routing/story-support";
const meta = {
  title: "AI Connections/Provider routing/05 Recovery",
  component: Recovery,
  parameters: { layout: "fullscreen" },
  ...reviewLifecycle,
  decorators: [
    (Story) => (
      <ReviewFrame location="Task thread → existing connection request card → inline Fix connection. Reuses ConnectionIntentInteractionBody and its completion/focus behavior; the gateway credential fields are proposed.">
        <Story />
      </ReviewFrame>
    ),
  ],
  render: (args) => <Recovery key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof Recovery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ExpiredCredential: Story = {};
export const MissingPersonalCredential: Story = {
  args: { problem: "missing" },
};
export const ProtocolMismatch: Story = { args: { problem: "protocol" } };
export const ProviderQuota: Story = { args: { problem: "quota" } };
export const Mobile: Story = {
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const ReconnectWalkthrough: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Fix connection" }),
    );
    const dialog = within(
      await canvas.findByRole("region", { name: "Gateway credential repair" }),
    );
    await userEvent.type(dialog.getByLabelText("API key"), "invalid");
    await userEvent.click(dialog.getByRole("button", { name: "Connect" }));
    await expect(dialog.getByRole("alert")).toHaveTextContent("rejected");
    await expect(dialog.getByLabelText("API key")).toHaveValue("");
    await userEvent.type(dialog.getByLabelText("API key"), "storybook-example");
    await userEvent.click(dialog.getByRole("button", { name: "Connect" }));
    await expect(
      await canvas.findByText("Engineering gateway connected", { exact: true }),
    ).toBeVisible();
  },
};
export const CancelRestoresFocus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Fix connection" });
    await userEvent.click(trigger);
    const dialog = within(
      await canvas.findByRole("region", { name: "Gateway credential repair" }),
    );
    await userEvent.type(
      dialog.getByLabelText("API key"),
      "discard-this-example",
    );
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await expect(
      canvas.getByTestId("connection-intent-focus-target"),
    ).toHaveFocus();
    await expect(
      canvas.queryByDisplayValue("discard-this-example"),
    ).not.toBeInTheDocument();
  },
};
