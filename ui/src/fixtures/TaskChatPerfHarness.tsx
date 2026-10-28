import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import type { TaskChatItem } from "@/components/task-chat/task-chat-model";
import "@/index.css";

const paragraphs = Array.from({ length: 8 }, (_, i) =>
  `### Investigation ${i + 1}\n\nThe agent inspected the implementation, checked **boundary conditions**, and recorded the result.\n\n- Preserve existing behavior.\n- Verify the next update.\n\n\`\`\`ts\nconst result = await inspect({ attempt: ${i} });\n\`\`\``,
).join("\n\n");
const history: TaskChatItem[] = Array.from({ length: 200 }, (_, index) => ({
  id: `history-${index}`,
  kind: "message",
  author: "agent",
  authorName: "Engineer",
  text: `Historical response ${index}\n\n${paragraphs}`,
  timestamp: "12:00 PM",
  attachedTurn: {
    id: `turn-${index}`,
    kind: "turn",
    settled: true,
    summary: { toolCount: 20, added: 0, removed: 0, durationLabel: "38s" },
    items: Array.from({ length: 20 }, (_, tool) => ({
      id: `tool-${index}-${tool}`, kind: "tool", name: "Read", status: "completed", target: `src/file-${tool}.ts`, detail: "File inspected successfully.",
    })),
  },
}));
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Harness() {
  const [streaming, setStreaming] = useState(false);
  const [reproject, setReproject] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 100);
    return () => window.clearInterval(timer);
  }, [streaming]);
  return (
    <div className="flex h-dvh flex-col px-6">
      <header className="flex shrink-0 items-center gap-4 py-3">
        <h1>Task chat: 200 responses, 4,000 tools</h1>
        <button onClick={() => setStreaming((value) => !value)}>{streaming ? "Stop streaming" : "Start streaming"}</button>
        <label><input type="checkbox" checked={reproject} onChange={(event) => setReproject(event.target.checked)} /> Recreate history objects</label>
        <output data-testid="stream-tick">{tick}</output>
      </header>
      <TaskChatThreadView items={reproject ? history.map((item) => ({ ...item })) : history} contentKey={tick} tail={<p>Live response {tick}</p>} />
      <textarea className="shrink-0 border p-3" aria-label="Reply" placeholder="Reply to the task" />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}><MemoryRouter><ThemeProvider><Harness /></ThemeProvider></MemoryRouter></QueryClientProvider>,
);
