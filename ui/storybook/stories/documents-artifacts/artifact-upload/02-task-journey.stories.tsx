import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Route, Routes } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { TaskChatPausedTakeover } from "@/components/task-chat/TaskChatPausedTakeover";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Box, X } from "lucide-react";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useSidebar } from "@/context/SidebarContext";
import { UploadPreview } from "../../../support/artifact-upload/UploadPreview";
import { issue, showFileDrag, type PreviewState } from "../../../support/artifact-upload/fixtures";

function TaskPage({ state = "empty", panelOpenInitially = false }: { state?: PreviewState; panelOpenInitially?: boolean }) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { isMobile: mobile } = useSidebar();
  const [open, setOpen] = useState(panelOpenInitially);
  useEffect(() => { setBreadcrumbs([{ label: "Tasks", href: "/PAP/issues" }, { label: issue.title, identifier: issue.identifier ?? undefined }]); }, [setBreadcrumbs]);
  return <div className="flex h-full min-h-0 flex-col lg:flex-row">
    <section className={mobile && open ? "hidden" : "flex min-h-0 min-w-0 flex-1 flex-col overflow-auto"}>
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-8">
        <header className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status="backlog" /><span className="font-mono text-xs text-muted-foreground">PAP-214</span><span className="text-xs text-muted-foreground">Unassigned</span></div>
            {mobile ? <Button variant="outline" size="sm" onClick={() => setOpen(true)}><Box aria-hidden="true" />Artifacts</Button> : null}
          </div>
          <h1 className="text-xl font-semibold">{issue.title}</h1>
        </header>
        <TaskChatBubble item={{ id: "placeholder-request", kind: "message", author: "human", text: "Keep this as an unassigned placeholder. I’ll add the engineering handoff and supporting references. Don’t start any work." }} />
        <div className="flex-1" />
        <TaskChatPausedTakeover scope="leaf" />
      </div>
    </section>
    <aside className={mobile ? (open ? "flex h-full min-h-0 flex-col" : "hidden") : "flex min-h-0 w-1/2 max-w-xl flex-col border-l border-border"} aria-label="Task side panel">
      {mobile ? <div className="flex items-center justify-between px-4 py-2"><Button variant="ghost" size="sm" onClick={() => setOpen(false)}><ArrowLeft aria-hidden="true" />Back to task</Button><Button variant="ghost" size="icon" aria-label="Close artifacts" onClick={() => setOpen(false)}><X aria-hidden="true" /></Button></div> : null}
      <div className="min-h-0 flex-1"><UploadPreview state={state} /></div>
    </aside>
  </div>;
}

function Journey(props: { state?: PreviewState; panelOpenInitially?: boolean }) {
  return <PluginLauncherProvider><Routes><Route path="/:companyPrefix" element={<Layout />}><Route path="issues/:issueId" element={<TaskPage {...props} />} /></Route></Routes></PluginLauncherProvider>;
}

const meta = {
  id: "artifact-upload-02-paused-task-journey",
  title: "Tasks and conversations/Documents, attachments, and work products/Artifact upload/02 Paused task journey", component: Journey,
  parameters: { layout: "fullscreen", initialEntries: ["/PAP/issues/PAP-214"], docs: { description: { component: "Start on the paused, unassigned PAP-214 placeholder in the production app shell. Upload or drop files in Artifacts, open a document in another tab, then return to Artifacts. On mobile, open Artifacts from the task header. Uses production chat bubbles, paused takeover, panel frame, desktop/mobile tabs, artifact list and document viewer. The story composes these components for review; upload persistence is simulated. No live issue is modified or resumed." }, story: { inline: false } },
    paperclip: {
      "capabilities": [
        "documents-artifacts/attachments"
      ],
      "implementation": "production",
      "boundary": "fixtures"
    },
  },
  render: (args, context) => <Journey key={`${context.id}-${args.state}`} {...args} />,
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AddToPlaceholder: Story = { args: { state: "empty" } };
export const HandoffAttached: Story = { args: { state: "populated" } };
export const DragOverArtifacts: Story = { args: { state: "populated" }, play: ({ canvasElement }) => showFileDrag(canvasElement) };
export const RecoverAnUpload: Story = { args: { state: "error" } };
export const MobileFromTask: Story = { args: { state: "empty" }, globals: { viewport: { value: "mobile", isRotated: false } } };
export const MobileArtifacts: Story = { args: { state: "populated", panelOpenInitially: true }, globals: { viewport: { value: "mobile", isRotated: false } } };
