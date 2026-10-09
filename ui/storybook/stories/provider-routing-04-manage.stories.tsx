import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Management } from "../prototypes/provider-routing/Management";
import { ReviewFrame } from "../prototypes/provider-routing/shared";
import { reviewLifecycle } from "../prototypes/provider-routing/story-support";
const meta = {
  title: "AI Connections/Provider routing/04 Manage",
  component: Management,
  parameters: { layout: "fullscreen" },
  ...reviewLifecycle,
  decorators: [
    (Story) => (
      <ReviewFrame location="Connectors (/apps) → provider account → connection details, models, and access. Uses the existing provider cards and account rows.">
        <Story />
      </ReviewFrame>
    ),
  ],
  render: (args) => <Management key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof Management>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ConnectionList: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", {
        name: "Open My ChatGPT subscription permissions",
      }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("heading", { name: "Custom provider or gateway" }),
    ).not.toBeInTheDocument();
  },
};
export const WithAdvancedConnections: Story = {
  args: { includeAdvancedConnections: true },
};
export const ConnectionDetails: Story = { args: { initialView: "details" } };
export const ModelsAndHelperDefaults: Story = {
  args: { initialView: "details", initialTab: "models" },
};
export const Access: Story = {
  args: { initialView: "details", initialTab: "access" },
};
export const ReadOnly: Story = {
  args: { initialView: "details", readOnly: true },
};
export const MobileModels: Story = {
  ...ModelsAndHelperDefaults,
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const ReplaceCredential: Story = {
  ...ConnectionDetails,
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Replace credential" }),
    );
  },
};
export const NewEndpoint: Story = {
  ...ConnectionDetails,
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Advanced connection settings",
      }),
    );
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Use a different endpoint",
      }),
    );
    await expect(
      within(canvasElement).getByRole("heading", {
        name: "Connect Custom provider or gateway",
      }),
    ).toBeVisible();
  },
};
export const AddModelWalkthrough: Story = {
  ...ModelsAndHelperDefaults,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByLabelText("Model ID or alias"),
      "team-reviewer",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Add model" }));
    await expect(
      canvas.getByText("team-reviewer", { exact: true }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }));
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Connection settings saved",
    );
  },
};
export const RevokeCredential: Story = {
  ...Access,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Revoke credential" }),
    );
    const dialog = within(
      await within(canvasElement.ownerDocument.body).findByRole("dialog"),
    );
    await userEvent.click(
      dialog.getByRole("button", { name: "Revoke credential" }),
    );
    await expect(
      canvas.getByText(/Credential revoked. Reconnect/),
    ).toBeVisible();
  },
};
