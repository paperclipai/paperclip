import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatComposerDock } from "@/components/task-chat/TaskChatComposerDock";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";

function TaskFileDrop() {
  return <div className="flex min-h-dvh flex-col bg-background text-foreground">
    <header className="flex h-12 items-center border-b border-border px-6 text-sm">Tasks / Fix the sign-in redirect</header>
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col p-6">
      <h1 className="mb-6 text-xl font-semibold">Fix the sign-in redirect</h1>
      <div className="flex flex-1 flex-col" data-task-chat-shell="">
        <TaskChatThreadView items={[
          { id: "request", kind: "message", author: "human", text: "Review the sign-in flow and fix the redirect after a session expires." },
          { id: "response", kind: "message", author: "agent", authorName: "Codex", text: "I checked the redirect. Add a screenshot of the page you see after signing in so I can compare the result." },
        ]} />
        <TaskChatComposerDock mobile={false} streamlined={false}>
          <TaskChatComposer workMode="standard" onAdd={async () => {}}
            onImageUpload={async () => "/favicon.svg"} />
        </TaskChatComposerDock>
      </div>
    </main>
  </div>;
}

const meta = {
  id: "composer-file-drop",
  title: "Tasks and conversations/Task creation and lifecycle/Composer/Screen file drop",
  component: TaskFileDrop,
  parameters: {
    layout: "fullscreen",
    paperclip: { capabilities: ["tasks/discussion"], implementation: "production", boundary: "fixtures",
      notes: "Production thread, composer, and screen drop target in a task layout. Upload is a local fixture; no task or agent runs." },
  },
} satisfies Meta<typeof TaskFileDrop>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TaskPage: Story = {};
export const DragOver: Story = {
  play: async ({ canvasElement }) => {
    const document = canvasElement.ownerDocument;
    const transfer = new DataTransfer();
    transfer.items.add(new File(["image"], "screenshot.png", { type: "image/png" }));
    document.body.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    await waitFor(() => expect(within(document.body).getByTestId("composer-file-drop-overlay")).toBeVisible());
  },
};
