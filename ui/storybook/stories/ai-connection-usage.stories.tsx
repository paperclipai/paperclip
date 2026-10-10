import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { AiConnectionUsageReview, USAGE_REVIEW_SCENARIOS } from "../prototypes/AiConnectionUsageReview";

const { codex, claude, grok, openRouter, unavailable } = USAGE_REVIEW_SCENARIOS;
const meta = {
  title: "AI Connections/Usage limits",
  component: AiConnectionUsageReview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AiConnectionUsageReview>;
export default meta;
type Story = StoryObj<typeof meta>;

const checkUsage: NonNullable<Story["play"]> = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getAllByRole("button", { name: "Check usage" })).toHaveLength(args.scenarios.length));
  const buttons = canvas.getAllByRole("button", { name: "Check usage" });
  for (const button of buttons) await userEvent.click(button);
  await waitFor(() => expect(canvas.getAllByText(/Updated/)).toHaveLength(buttons.length));
};

export const AllProviders: Story = {
  args: { scenarios: [codex, claude, grok, openRouter] },
  play: checkUsage,
};

export const BeforeChecking: Story = {
  args: { scenarios: [claude] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Check usage" })).toBeEnabled();
    await expect(canvas.queryByRole("progressbar")).not.toBeInTheDocument();
  },
};

export const CodexLimitReached: Story = { args: { scenarios: [codex] }, play: checkUsage };
export const ClaudeScopedLimits: Story = { args: { scenarios: [claude] }, play: checkUsage };
export const GrokPartialUsage: Story = { args: { scenarios: [grok] }, play: checkUsage };
export const OpenRouterKeyLimit: Story = { args: { scenarios: [openRouter] }, play: checkUsage };

export const CheckingUsage: Story = {
  args: { scenarios: [{ ...claude, pending: true }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Check usage" }));
    await expect(await canvas.findByRole("button", { name: "Checking…" })).toBeDisabled();
  },
};

export const UsagePermissionDenied: Story = {
  args: { scenarios: [unavailable] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Check usage" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Usage access denied.");
    await expect(canvas.queryByRole("progressbar")).not.toBeInTheDocument();
  },
};
