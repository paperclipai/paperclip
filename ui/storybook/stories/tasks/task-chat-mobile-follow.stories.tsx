import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatComposerDock } from "@/components/task-chat/TaskChatComposerDock";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { useMobileVisualViewport } from "@/hooks/useMobileVisualViewport";

function StreamingResponse({ running }: { running: boolean }) {
  const [lines, setLines] = useState(16);
  useEffect(() => {
    if (!running || lines >= 256) return;
    const timer = window.setTimeout(() => setLines(lines + 1), 500);
    return () => window.clearTimeout(timer);
  }, [running, lines]);
  return <TaskChatThreadView items={[
    { id: "request", kind: "message", author: "human", text: "Give me a detailed progress report as you work." },
    {
      id: "response", kind: "message", author: "agent", authorName: "Researcher", streaming: running,
      text: Array.from({ length: lines }, (_, index) => `Update ${index + 1}: I checked the next section and recorded the results for the final report.`).join("\n\n"),
    },
  ]} />;
}

function MobileFollow() {
  const [running, setRunning] = useState(true);
  const viewportRef = useMobileVisualViewport(true);
  return <div ref={viewportRef} data-mobile="true" className="paperclip-app-shell flex min-h-dvh flex-col bg-background text-foreground">
    <div className="app-main-row"><div className="app-content-column flex flex-col">
    <header className="app-breadcrumb flex h-12 shrink-0 items-center px-4 text-sm font-medium">iOS layout — focus-scroll correction</header>
    <div className="app-content-row"><main id="main-content" className="flex flex-1 flex-col p-4">
      <div data-task-chat-shell="" data-testid="task-chat-thread" className="-mx-4 flex min-h-0 flex-1 flex-col">
        <StreamingResponse running={running} />
        <TaskChatComposerDock mobile streamlined={false}>
          <TaskChatComposer mobile workMode="standard" onAdd={async () => setRunning(true)}
            onStop={running ? async () => setRunning(false) : undefined} />
        </TaskChatComposerDock>
      </div>
    </main></div></div></div>
    <MobileBottomNav visible />
  </div>;
}

const meta = {
  id: "task-chat-mobile-streaming-follow",
  title: "Tasks and conversations/Task creation and lifecycle/Task chat/Mobile streaming follow",
  component: MobileFollow,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Controlled output in the production thread and composer. At the bottom, updates stay visible. Scroll up to hold your reading position, then return to the bottom to resume following. Stop pauses the fixture; send a message to resume. No agent or provider calls." } },
    paperclip: {
      "capabilities": [
        "tasks/discussion"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production mobile viewport sizing, message scroller, and composer with bounded synthetic streaming. Physical iPhone keyboard acceptance is required."
    },
  },
  globals: { theme: "light", viewport: { value: "mobile", isRotated: false } },
} satisfies Meta<typeof MobileFollow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Streaming: Story = {};
