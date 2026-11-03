import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { PrimaryPage, mobile, primaryDecorator, primaryParameters } from "../../../support/primary-agent/PrimaryAgentStory";

export default {
  id: "primary-agent-07-confirmation",
  title: "Agents and reusable capabilities/Hiring, configuration, and organization/Primary Agent/07 Confirmation",
  decorators: [primaryDecorator],
  parameters: { ...primaryParameters, initialEntries: ["/PAP/agents/alex"],
    paperclip: {
      "capabilities": [
        "agents/primary-agent",
        "tasks/create",
        "agent-chat/discovery"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Primary choice, replacement confirmation, unavailable states and task/chat fallback presentation use local presentation-provider callbacks. Production preference persistence and default-resolution precedence remain unverified by this suite. The filter uses one lowercase label without helper text. All chat-channel tasks count as bot-created; the focused visibility stories cover human-initiated channel work."
    },
  },
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
