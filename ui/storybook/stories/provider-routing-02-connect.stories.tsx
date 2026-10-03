import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
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
      <ReviewFrame location="Apps → AI connections → Add connection. The same setup is opened from onboarding, agent settings, and task requests.">
        <Story />
      </ReviewFrame>
    ),
  ],
  render: (args) => <ConnectionSetup key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof ConnectionSetup>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ChooseProvider: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "OpenAI" })).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Custom provider or gateway" }),
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: "Amazon Bedrock" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole("button", { name: "Advanced providers" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Custom provider or gateway" }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Advanced providers" }),
    );
  },
};
export const AdvancedProviders: Story = { args: { initialAdvanced: true } };
export const Access: Story = { args: { initialStep: "access" } };
export const SharedAccess: Story = {
  ...Access,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("radio", { name: "Any human in the organization" }),
    );
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
    await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
    await expect(
      canvas.getByRole("heading", { name: "Connection ready" }),
    ).toBeVisible();
    await expect(
      canvas.queryByDisplayValue("storybook-example"),
    ).not.toBeInTheDocument();
  },
};
