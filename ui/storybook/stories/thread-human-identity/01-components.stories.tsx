import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { commentsToTaskChatItems } from "@/components/task-chat/task-chat-adapter";
import type { TaskChatMessageItem } from "@/components/task-chat/task-chat-model";
import { comments, profiles, alexId, samId } from "./fixtures";

function Bubble({ viewer = alexId, photo = null, unresolved = false }: { viewer?: string; photo?: string | null; unresolved?: boolean }) {
  const userProfileMap = new Map(profiles);
  userProfileMap.set(samId, { label: "Sam Rivera", image: photo });
  const item = commentsToTaskChatItems([comments[5]!], { currentUserId: viewer, userProfileMap: unresolved ? undefined : userProfileMap })[0] as TaskChatMessageItem;
  return <div className="mx-auto max-w-2xl p-6"><TaskChatBubble item={item} animateEntry={false} /></div>;
}
const meta = {
  title: "Chat & Comments/Human identity/01 Components", component: Bubble,
  args: { viewer: alexId, photo: null },
  parameters: { layout: "padded", docs: { description: { component: "Production adapter → model → TaskChatBubble → Identity. Other humans sit on the left on the same page surface as agents with their own name/photo; no-photo profiles use the shared initials fallback. Edit photo to exercise an uploaded Paperclip asset URL. External URLs use initials. The production avatar URL is taken from the company directory, never from the current viewer or the relay bot." } } },
} satisfies Meta<typeof Bubble>;
export default meta;
type Story = StoryObj<typeof meta>;
export const OtherHuman: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("task-chat-human-identity")).toHaveTextContent("Sam Rivera");
    await expect(canvas.getByTestId("task-chat-human-bubble").parentElement).toHaveClass("items-start");
  },
};
export const OwnMessage: Story = { args: { viewer: samId }, play: async ({ canvasElement }) => {
  await expect(within(canvasElement).queryByTestId("task-chat-human-identity")).not.toBeInTheDocument();
} };
export const UnknownProfile: Story = { args: { unresolved: true } };
export const Light: Story = { globals: { theme: "light" } };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
