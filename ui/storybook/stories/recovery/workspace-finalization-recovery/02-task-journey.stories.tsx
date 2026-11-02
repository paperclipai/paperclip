import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Route, Routes } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { WorkspaceExportRecovery } from "@/components/WorkspaceExportRecovery";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { automaticAction } from "../../../support/workspace-finalization-recovery/fixtures";

function TaskConversation({ saved = false }: { saved?: boolean }) {
  const [messages, setMessages] = useState<string[]>([]);
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "Tasks", href: "/PAP/issues" }, { label: "Prepare the rollout plan", identifier: "PAP-24" }]); }, [setBreadcrumbs]);
  return <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-8">
    <header className="flex flex-col gap-2">
      <span className="font-mono text-xs text-muted-foreground">PAP-24</span>
      <h1 className="text-xl font-semibold">Prepare the rollout plan</h1>
      <p className="text-sm text-muted-foreground">Assigned to Jordan Lee</p>
    </header>
    <TaskChatBubble item={{ id: "request", kind: "message", author: "human", authorName: "Riley Board", authorUserId: "user-board", isCurrentUser: true, text: "Prepare the rollout plan and wait for my confirmation before starting implementation." }} />
    <TaskChatBubble item={{ id: "saved-result", kind: "message", author: "agent", authorName: "Jordan Lee", text: "The plan is ready. I’m waiting for your confirmation before continuing." }} />
    <WorkspaceExportRecovery action={saved ? null : automaticAction} />
    {messages.map((text, index) => <TaskChatBubble key={index} item={{ id: `followup-${index}`, kind: "message", author: "human", authorName: "Riley Board", authorUserId: "user-board", isCurrentUser: true, text }} />)}
    <div className="flex-1" />
    <TaskChatComposer workMode="standard" onAdd={async body => setMessages(current => [...current, body])} placeholder="Message Jordan Lee…" />
  </main>;
}

function Journey({ saved = false }: { saved?: boolean }) {
  return <PluginLauncherProvider><Routes><Route path="/:companyPrefix" element={<Layout />}><Route path="issues/:issueId" element={<TaskConversation saved={saved} />} /></Route></Routes></PluginLauncherProvider>;
}
const meta = {
  id: "workspace-finalization-recovery-02-task-journey",
  title: "Projects and execution/Recovery/Workspace finalization recovery/02 Task journey", component: Journey, args: { saved: false },
  parameters: { layout: "fullscreen", initialEntries: ["/PAP/issues/PAP-24"], docs: { description: { component: "A composed task conversation in the production app shell, using the shipped recovery notice, task bubbles and composer. Recovery happens automatically with no form or user action. This is a composed UI preview; finalization and approval resolution are verified separately by server tests." }, story: { inline: false } },
    paperclip: {
      "capabilities": [
        "recovery/workspace",
        "recovery/source-action"
      ],
      "implementation": "mixed",
      "boundary": "fixtures",
      "notes": "Production shell, status, bubbles and composer in a local conversation composition; shows restoration and saved work waiting for confirmation. Fixture messages; not the shipped task page or live provider acceptance."
    },
  },
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ResumeInContext: Story = {};
export const SavedAndWaitingForConfirmation: Story = { args: { saved: true } };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
