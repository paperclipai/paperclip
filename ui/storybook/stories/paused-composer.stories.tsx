import type { Meta, StoryObj } from "@storybook/react-vite";
import { PausedComposerPreview } from "../prototypes/PausedTaskComposer";

const meta = {
  title: "Tasks/Composer/Paused task takeover",
  component: PausedComposerPreview,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Design preview: a paused task replaces the entire composer with an amber takeover. Resume restores the real composer; no dismiss, attachments, or sending while paused. Actions are local Storybook fixtures. See Tasks / Execution Controls for the current behavior.",
      },
    },
  },
} satisfies Meta<typeof PausedComposerPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TaskPaused: Story = { name: "Task paused" };
export const ComposerOnly: Story = { args: { composerOnly: true } };
export const DraftSaved: Story = {
  args: { draft: "Please check the keyboard interaction too." },
};
export const SubtreePaused: Story = { args: { subtree: true } };
export const Resuming: Story = { args: { initialState: "resuming" } };
export const ResumeFailed: Story = { args: { initialState: "error" } };
export const Light: Story = { globals: { theme: "light" } };
export const Mobile: Story = {
  args: { mobile: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
