import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { TaskBrowserActivity } from "@/components/task-side-panel/TaskBrowserActivity";
import {
  browserFixture,
  browserState,
  BrowserStoryProviders,
  InteractiveBrowserStory,
  mockBrowserUse,
} from "../fixtures/browser-use";
const meta = {
  title: "Tasks/Browser Use/Task activity",
  component: TaskBrowserActivity,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "The task-thread browser entry point, placed at the moment the browser was opened, including history and reopening a session. All data is simulated.",
      },
    },
  },
  args: { browser: browserFixture, onOpen: () => {} },
  decorators: [
    (Story) => (
      <div className="w-96 max-w-full bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskBrowserActivity>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Running: Story = {};
export const Starting: Story = {
  args: { browser: browserState("starting") },
};
export const Idle: Story = { args: { browser: browserState("idle") } };
export const Closed: Story = { args: { browser: browserState("closed") } };
export const Failed: Story = { args: { browser: browserState("failed") } };
export const InlineHistory: Story = {
  render: () => (
    <TaskChatThreadView scroll={false} onOpenBrowser={() => {}} items={[
      { id: "request-1", kind: "message", author: "human", text: "Open paperclip.ing", timestamp: "11:00 AM" },
      { id: "browser-1", kind: "browser", browser: browserState("closed"), label: "Browser 1", timestamp: "2026-09-29T16:00:10Z" },
      { id: "reply-1", kind: "message", author: "agent", authorName: "Browser Agent", text: "Opened paperclip.ing.", timestamp: "11:00 AM" },
      { id: "request-2", kind: "message", author: "human", text: "Now open Hacker News", timestamp: "11:15 AM" },
      { id: "browser-2", kind: "browser", browser: { ...browserFixture, id: "second", sessionId: "second" }, label: "Browser 2", timestamp: "2026-09-29T16:15:10Z" },
      { id: "reply-2", kind: "message", author: "agent", authorName: "Browser Agent", text: "The browser is ready for you.", timestamp: "11:15 AM" },
    ]} />
  ),
};
function ReopenFixture() {
  const [open, setOpen] = useState(false);
  return (
    <BrowserStoryProviders>
      <TaskBrowserActivity
        browser={browserFixture}
        onOpen={() => setOpen(true)}
      />
      {open && (
        <div className="h-96 border">
          <InteractiveBrowserStory initial={browserFixture} />
        </div>
      )}
    </BrowserStoryProviders>
  );
}
export const ReopenBrowser: Story = {
  beforeEach: () => mockBrowserUse(),
  render: () => <ReopenFixture />,
};
