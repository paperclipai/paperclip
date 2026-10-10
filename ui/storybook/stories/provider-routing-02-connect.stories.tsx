import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ProviderCatalogReview } from "../prototypes/provider-routing/ConnectionCatalog";
import { ConnectionSetup } from "../prototypes/provider-routing/ConnectionSetup";
import { ReviewFrame } from "../prototypes/provider-routing/shared";
import {
  choose,
  reviewLifecycle,
} from "../prototypes/provider-routing/story-support";
const meta = {
  title: "AI Connections/Provider routing/02 Connect",
  component: ConnectionSetup,
  parameters: { layout: "fullscreen" },
  ...reviewLifecycle,
  decorators: [
    (Story) => (
      <ReviewFrame location="Apps → Connectors → Connect on a provider row. Permissions default to everyone and all agents under Advanced.">
        <Story />
      </ReviewFrame>
    ),
  ],
  render: (args) => <ConnectionSetup key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof ConnectionSetup>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ChooseProvider: Story = {
  name: "Connector catalog",
  render: () => <ProviderCatalogReview />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("Connect a model provider")).not.toBeInTheDocument();
    for (const slug of ["openrouter", "bedrock", "responses-api", "messages-api", "chat-completions-api", "local"]) {
      const row = canvasElement.querySelector(`[data-app-slug="${slug}"]`)! as HTMLElement;
      await expect(within(row).getByRole("button", { name: /^Connect / })).toBeVisible();
    }
  },
};
export const Access: Story = { name: "Permissions defaults", args: { initialStep: "access" } };
export const SharedAccess: Story = {
  ...Access,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Change" }));
    await expect(
      canvas.getByRole("radio", { name: "Any human in the organization" }),
    ).toBeChecked();
  },
};
export const OpenRouterKey: Story = { args: { initialStep: "connect" } };
export const BedrockApiKey: Story = {
  args: { initialStep: "connect", initialProvider: "bedrock" },
};
export const BedrockEnvironmentIdentity: Story = {
  args: {
    initialStep: "connect",
    initialProvider: "bedrock",
    initialMethod: "identity",
  },
};
export const GoogleVertexIdentity: Story = {
  args: {
    initialStep: "connect",
    initialProvider: "google",
    initialMethod: "identity",
  },
};
export const CustomResponses: Story = {
  args: { initialStep: "connect", initialProvider: "custom" },
};
export const CustomAnthropic: Story = {
  args: {
    initialStep: "connect",
    initialProvider: "custom",
    initialProtocol: "messages",
  },
};
export const CustomHeader: Story = {
  args: {
    initialStep: "connect",
    initialProvider: "custom",
    initialMethod: "header",
  },
};
export const LocalEndpoint: Story = {
  args: {
    initialStep: "connect",
    initialProvider: "custom",
    initialMethod: "none",
    initialProtocol: "chat",
  },
};
export const InvalidCredential: Story = {
  args: { initialStep: "connect", initialError: "credential" },
};
export const MobileBedrock: Story = {
  ...BedrockApiKey,
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const CustomEndpointWalkthrough: Story = {
  ...CustomResponses,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByLabelText("Base URL"),
      "https://models.example.com/v1",
    );
    await userEvent.type(canvas.getByLabelText("API key"), "storybook-example");
    await userEvent.click(canvas.getByRole("button", { name: /^Connect$/ }));
    await expect(
      canvas.getByRole("heading", { name: "Connection ready" }),
    ).toBeVisible();
    await expect(
      canvas.queryByDisplayValue("storybook-example"),
    ).not.toBeInTheDocument();
  },
};
