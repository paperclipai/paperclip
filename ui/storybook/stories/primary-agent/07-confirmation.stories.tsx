import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { PrimaryPage, mobile, primaryDecorator, primaryParameters } from "./PrimaryAgentStory";

export default {
  title: "Primary Agent/07 Confirmation",
  decorators: [primaryDecorator],
  parameters: { ...primaryParameters, initialEntries: ["/PAP/agents/alex"] },
  render: () => <PrimaryPage />,
} satisfies Meta;
type Story = StoryObj;

export const ReplacePrimary: Story = { play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await page.findByRole("button", { name: "Set as my primary" }));
  await expect(await page.findByRole("alertdialog", { name: "Change your primary agent?" })).toBeVisible();
} };
export const LongName: Story = { ...ReplacePrimary, args: { primaryName: "Maia · Strategy and cross-functional operations" } };
export const Mobile: Story = { ...ReplacePrimary, globals: mobile };
export const Light: Story = { ...ReplacePrimary, globals: { theme: "light" } };
