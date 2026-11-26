import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import type { TaskChatMessageItem } from "@/components/task-chat/task-chat-model";
import { prepareProactiveMessageFixtures, ProactiveMessageReview } from "../../support/agent-chat/proactive-messages";

const message: TaskChatMessageItem = {
  id: "digest", kind: "message", author: "agent", authorName: "Kodi",
  text: "## Morning PR digest\n\nThree PRs need your review:\n\n- **#124** — Fix chat reconnect\n- **#127** — Improve task search\n- **#130** — Add release notes",
  timestamp: "7:00 AM",
  chatMessage: { sourceTaskId: "11111111-1111-4111-8111-111111111111", sourceTaskIdentifier: "PC-42",
    sourceRunId: "22222222-2222-4222-8222-222222222222", contentHash: "0".repeat(64) },
};
const meta = {
  id: "agent-chat-proactive-messages",
  title: "Tasks and conversations/Agent conversations and project handoff/Proactive messages",
  component: TaskChatBubble,
  args: { item: message, animateEntry: false },
  render: args => <div className="mx-auto max-w-2xl p-6"><TaskChatBubble {...args} /></div>,
  parameters: { layout: "padded", initialEntries: ["/PAP/chats"], paperclip: {
    capabilities: ["agent-chat/history", "agent-chat/discovery"], status: "current", implementation: "production", boundary: "fixtures",
    notes: "Production Sidebar, CoordinatorSidebar, AgentConversationsSidebar, TaskChatBubble and read-receipt hook in a review-only gallery. Stateful API fixtures show unread-to-read and error transitions. The app navigation is currently expanded; the retired rail is not recreated. Server delivery, event refresh, account isolation, routine execution and real source-task navigation require the separate app/database checks.",
  } },
  beforeEach: ({ parameters }) => prepareProactiveMessageFixtures(parameters.readFailure === true, Number(parameters.transientReadFailures ?? 0)).cleanup,
} satisfies Meta<typeof TaskChatBubble>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AllChangedUx: Story = {
  name: "01 · All changed UX",
  parameters: { layout: "fullscreen", options: { showPanel: false } },
  render: () => <ProactiveMessageReview />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("img", { name: "Unread messages from Kodi" })).toBeVisible();
    await expect(canvas.getByRole("img", { name: "Unread messages from Mira" })).toBeVisible();
    await expect(canvas.findAllByLabelText("2 unread chats")).resolves.toHaveLength(2);
    await expect(canvas.getByRole("link", { name: "From PAP-42" })).toHaveAttribute("href", expect.stringContaining("/issues/PAP-42"));
  },
};
export const ReadOnOpen: Story = {
  ...AllChangedUx,
  name: "02 · Open chat marks the rendered message read",
  parameters: { layout: "fullscreen", options: { showPanel: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("img", { name: "Unread messages from Kodi" });
    await userEvent.click(canvas.getByRole("button", { name: "Open Kodi chat" }));
    await waitFor(() => expect(canvas.queryByRole("img", { name: "Unread messages from Kodi" })).not.toBeInTheDocument());
    await expect(canvas.getByRole("img", { name: "Unread messages from Mira" })).toBeVisible();
    await expect(canvas.findAllByLabelText("1 unread chats")).resolves.toHaveLength(2);
  },
};
export const ReadAutomaticallyRecovers: Story = {
  ...AllChangedUx,
  name: "03 · Read receipt recovers automatically",
  parameters: { layout: "fullscreen", options: { showPanel: true }, transientReadFailures: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("img", { name: "Unread messages from Kodi" });
    await userEvent.click(canvas.getByRole("button", { name: "Open Kodi chat" }));
    await waitFor(() => expect(canvas.queryByRole("img", { name: "Unread messages from Kodi" })).not.toBeInTheDocument(), { timeout: 5_000 });
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
    await expect(canvas.findAllByLabelText("1 unread chats")).resolves.toHaveLength(2);
  },
};
export const ReadReceiptFailure: Story = {
  ...AllChangedUx,
  name: "04 · Read receipt failed after retries",
  parameters: { layout: "fullscreen", options: { showPanel: true }, readFailure: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("img", { name: "Unread messages from Kodi" });
    await userEvent.click(canvas.getByRole("button", { name: "Open Kodi chat" }));
    await expect(await canvas.findByRole("alert", {}, { timeout: 5_000 })).toHaveTextContent("Couldn’t mark this chat read.");
    await expect(canvas.getByRole("img", { name: "Unread messages from Kodi" })).toBeVisible();
    await expect(canvas.findAllByLabelText("2 unread chats")).resolves.toHaveLength(2);
  },
};
export const MobileReview: Story = { ...AllChangedUx, name: "05 · All changed UX · Mobile", globals: { viewport: { value: "mobile", isRotated: false } } };
export const LightReview: Story = { ...AllChangedUx, name: "06 · All changed UX · Light", globals: { theme: "light" } };
export const MorningDigest: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("link", { name: "From PC-42" })).toHaveAttribute("href", expect.stringContaining("/issues/PC-42"));
  },
};
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
export const Light: Story = { globals: { theme: "light" } };
