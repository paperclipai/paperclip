import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Onboarding } from "../prototypes/provider-routing/AgentSetup";
import { ReviewFrame } from "../prototypes/provider-routing/shared";
import { reviewLifecycle } from "../prototypes/provider-routing/story-support";
const meta = {
  title: "AI Connections/Provider routing/01 Onboarding",
  component: Onboarding,
  parameters: { layout: "fullscreen" },
  ...reviewLifecycle,
  decorators: [
    (Story) => (
      <ReviewFrame location="First onboarding → connect provider, after choosing the harness.">
        <Story />
      </ReviewFrame>
    ),
  ],
  render: (args) => <Onboarding key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof Onboarding>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DefaultPath: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Sign in to OpenAI" }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Use another provider or gateway" }),
    ).not.toBeInTheDocument();
    await expect(canvas.queryByLabelText("Base URL")).not.toBeInTheDocument();
    await expect(
      canvas.queryByText("Use your ChatGPT subscription to get started."),
    ).not.toBeInTheDocument();
  },
};
export const HappyPathWalkthrough: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Sign in to OpenAI" }),
    );
    await expect(
      canvas.getByRole("combobox", { name: "Connection" }),
    ).toHaveTextContent("My ChatGPT subscription");
    await expect(
      canvas.getByRole("combobox", { name: "Connection" }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("region", { name: "Connection" }),
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", {
        name: "Connect another provider or gateway",
      }),
    ).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Run test" }));
    await expect(
      await canvas.findByText("Connection successful"),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Finish setup" }));
    await expect(canvas.getByText(/Nova’s configuration saved/)).toBeVisible();
  },
};
export const ReuseSavedConnection: Story = { args: { savedConnection: true } };
export const OtherProvider: Story = { args: { initialAlternate: true } };
export const Mobile: Story = {
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const OptionalProviderWalkthrough: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Advanced" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Use another provider or gateway" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "OpenRouter" }));
    await userEvent.type(canvas.getByLabelText("API key"), "storybook-example");
    await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Use connection" }),
    );
    await expect(
      canvas.getByRole("group", { name: "Harness selection" }),
    ).toHaveTextContent("Codex");
    await expect(
      canvas.getByRole("combobox", { name: "Connection" }),
    ).toHaveTextContent("Company OpenRouter");
    await expect(
      canvas.getByRole("button", { name: "Advanced model settings" }),
    ).toHaveAttribute("aria-expanded", "false");
  },
};
