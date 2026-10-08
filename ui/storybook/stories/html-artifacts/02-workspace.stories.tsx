import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResolvedWorkspaceResource } from "@paperclipai/shared";
import { TaskWorkspaceFilePanel } from "@/components/task-side-panel/TaskWorkspaceFilePanel";
import { FileViewerSheet } from "@/components/FileViewerSheet";
import { FileViewerProvider } from "@/context/FileViewerContext";
import { queryKeys } from "@/lib/queryKeys";
import { reportHtml } from "./fixtures";

const issueId = "html-workspace-story";
const state = { path: "reports/repository-usage.html", workspace: "project" as const, workspaceId: null, projectId: null, line: null, column: null };

function Workspace({ sheet = false }: { sheet?: boolean }) {
  const [client] = useState(() => {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const resource: ResolvedWorkspaceResource = {
      kind: "file", provider: "local_fs", title: "repository-usage.html", displayPath: state.path,
      workspaceLabel: "Research workspace", workspaceKind: "project_workspace", workspaceId: "research-workspace",
      contentType: "text/html", byteSize: reportHtml.length, previewKind: "text", denialReason: null,
      capabilities: { preview: true, download: true, listChildren: false },
    };
    cache.setQueryData(queryKeys.issues.fileResource(issueId, state), resource);
    cache.setQueryData(queryKeys.issues.fileResourceContent(issueId, state), { resource, content: { encoding: "utf8", data: reportHtml } });
    return cache;
  });
  return <QueryClientProvider client={client}><FileViewerProvider issueId={issueId}>
    <main className="min-h-screen bg-background p-4 text-foreground">
      {sheet ? <FileViewerSheet issueId={issueId} state={state} open /> : <section className="mx-auto h-(--sz-640px) max-w-3xl overflow-hidden rounded-lg border border-border">
        <TaskWorkspaceFilePanel issueId={issueId} payload={{ kind: "workspace-file", ...state }} />
      </section>}
    </main>
  </FileViewerProvider></QueryClientProvider>;
}
const meta = { title: "HTML artifacts/02 Workspace", component: Workspace, render: (args, context) => <Workspace key={context.id} {...args} />, parameters: { layout: "fullscreen", docs: { story: { inline: false } } } } satisfies Meta<typeof Workspace>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TaskPanel: Story = {};
export const FileSheet: Story = { args: { sheet: true } };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
