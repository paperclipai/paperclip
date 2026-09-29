import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ComposerRunSettingsLiveStory } from "../prototypes/composer-model-picker/ComposerRunSettingsLiveStory";

const meta = {
  title: "Composer/Mobile assignee picker",
  component: ComposerRunSettingsLiveStory,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "The same assignee, model, and effort picker shown on desktop, in its responsive mobile dialog. Agent capsule avatars use the shared persona palettes." } },
  },
  args: { agentId: "codex", mobile: true, compact: true, initialPanel: "agents" },
} satisfies Meta<typeof ComposerRunSettingsLiveStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PickerOpen: Story = {
  globals: { viewport: { value: "mobile", isRotated: false } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.getByTestId("composer-mobile-dialog")).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Assignees" })).toBeVisible();
    await expect(page.getByTestId("task-chat-composer-assignee").querySelector('[data-slot="agent-avatar"] img')).toBeVisible();
  },
};

export const ComposerClosed: Story = {
  args: { initialPanel: "closed" },
  globals: { viewport: { value: "mobile", isRotated: false } },
};

export const SearchAssignees: Story = {
  args: { initialAssigneeSearch: "Claude" },
  globals: { viewport: { value: "mobile", isRotated: false } },
};
