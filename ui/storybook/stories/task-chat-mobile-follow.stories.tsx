import { useEffect, useState, type CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatComposerDock } from "@/components/task-chat/TaskChatComposerDock";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { useWindowAutoFollow } from "@/components/task-chat/useWindowAutoFollow";

function StreamingResponse({ running }: { running: boolean }) {
  const [lines, setLines] = useState(16);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setLines((count) => Math.min(count + 1, 256)), 500);
    return () => window.clearInterval(timer);
  }, [running]);
  return <TaskChatThreadView scroll={false} items={[
    { id: "request", kind: "message", author: "human", text: "Give me a detailed progress report as you work." },
    {
      id: "response", kind: "message", author: "agent", authorName: "Researcher", streaming: running,
      text: Array.from({ length: lines }, (_, index) => `Update ${index + 1}: I checked the next section and recorded the results for the final report.`).join("\n\n"),
    },
  ]} />;
}

function MobileFollow() {
  const [running, setRunning] = useState(true);
  // The child updates independently, exercising late layout growth as well as
  // normal streaming without relying on a parent content-key notification.
  useWindowAutoFollow(0, true);
  return <div className="flex min-h-dvh flex-col bg-background text-foreground">
    <header className="flex h-12 shrink-0 items-center px-4 text-sm font-medium">Streaming progress report</header>
    <main className="flex flex-1 flex-col p-4 pb-(--tc-composer-visible-nav-offset)"
      style={{ "--tc-composer-bottom": "var(--tc-composer-visible-nav-offset)" } as CSSProperties}>
      <div data-testid="task-chat-thread" className="-mx-4 flex flex-col">
        <StreamingResponse running={running} />
        <TaskChatComposerDock mobile streamlined={false}>
          <TaskChatComposer mobile workMode="standard" onAdd={async () => setRunning(true)}
            onStop={running ? async () => setRunning(false) : undefined} />
        </TaskChatComposerDock>
      </div>
    </main>
    <MobileBottomNav visible />
  </div>;
}

const meta = {
  title: "Task chat/Mobile streaming follow",
  component: MobileFollow,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Controlled output in the production thread and composer. At the bottom, updates stay visible. Scroll up to hold your reading position, then return to the bottom to resume following. Stop pauses the fixture; send a message to resume. No agent or provider calls." } },
  },
  globals: { theme: "light", viewport: { value: "mobile", isRotated: false } },
} satisfies Meta<typeof MobileFollow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Streaming: Story = {};
