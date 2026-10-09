import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Route, Routes } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { WorkspaceBaseRefRecoveryNotice } from "@/components/WorkspaceBaseRefRecoveryNotice";
import { StatusBadge } from "@/components/StatusBadge";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { evidence, simulateRepair } from "./fixtures";

function TaskConversation() {
  const [retried, setRetried] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "Tasks", href: "/PAP/issues" }, { label: "Rewrite agent policy", identifier: "PAP-4024" }]); }, [setBreadcrumbs]);
  return <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-8">
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2"><StatusBadge status={retried ? "todo" : "blocked"} /><span className="font-mono text-xs text-muted-foreground">PAP-4024</span><span className="text-xs text-muted-foreground">Paperclip App</span></div>
      <h1 className="text-xl font-semibold">Let agents install missing dev tools</h1>
      <p className="text-sm text-muted-foreground">Assigned to Felix Novak</p>
    </header>
    <TaskChatBubble item={{ id: "request", kind: "message", author: "human", text: "Update the agent policy so agents can install missing dev tools in user space and keep working." }} />
    <TaskChatBubble item={{ id: "delegation", kind: "message", author: "agent", authorName: "Miranda Cole", text: "I’ve assigned the policy update to Felix in a separate workspace." }} />
    <WorkspaceBaseRefRecoveryNotice {...evidence} onRepair={async branch => { await simulateRepair(branch); setRetried(true); }} />
    {messages.map((text, index) => <TaskChatBubble key={index} item={{ id: `message-${index}`, kind: "message", author: "human", text }} />)}
    <div className="flex-1" />
    <TaskChatComposer workMode="standard" onAdd={async body => setMessages(current => [...current, body])} placeholder="Message Felix Novak…" />
  </div>;
}
function Journey() {
  return <PluginLauncherProvider><Routes><Route path="/:companyPrefix" element={<Layout />}><Route path="issues/:issueId" element={<TaskConversation />} /></Route></Routes></PluginLauncherProvider>;
}
const meta = {
  title: "Workspace branch recovery/02 Task journey", component: Journey,
  parameters: { layout: "fullscreen", initialEntries: ["/PAP/issues/PAP-4024"], docs: { description: { component: "Interactive proposal in the production app shell, using the shared task bubbles, composer and repair component. Save/retry and branch lookup are simulated. Use master or choose release/next; a missing branch shows an inline error. No live task is modified." }, story: { inline: false } } },
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FixAndRetry: Story = {};
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
