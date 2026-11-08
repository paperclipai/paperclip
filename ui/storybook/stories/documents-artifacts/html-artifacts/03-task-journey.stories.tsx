import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueAttachment } from "@paperclipai/shared";
import { Routes, Route } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { TaskSidePanel } from "@/components/task-side-panel/TaskSidePanel";
import { IssueArtifactFile } from "@/components/artifacts/IssueArtifactCard";
import { TextAttachmentContext } from "@/context/TextAttachmentContext";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { queryKeys } from "@/lib/queryKeys";
import { createIssue, storybookAgents } from "../../../fixtures/paperclipData";
import { reportHtml } from "../../../support/html-artifacts/fixtures";
import reportDownload from "../../../support/html-artifacts/report.html?url";

const issue = createIssue({ id: "html-artifact-journey", identifier: "DEMO-101", title: "Find popular repositories that use Paperclip a lot", status: "done", completedAt: new Date("2026-10-07T12:54:00Z"), currentExecutionWorkspace: null, executionWorkspaceId: null });
const attachment: IssueAttachment = {
  id: "html-usage-report", companyId: issue.companyId, issueId: issue.id, issueCommentId: null,
  assetId: "html-usage-asset", provider: "local_disk", sha256: "storybook-fixture",
  createdByAgentId: "agent-codex", createdByUserId: null, originatingRunId: null,
  originalFilename: "repository-usage.html", objectKey: "repository-usage.html", contentType: "text/html",
  byteSize: reportHtml.length, contentPath: "/api/attachments/html-usage-report/content",
  downloadPath: reportDownload,
  createdAt: new Date("2026-10-07T12:54:00Z"),
  updatedAt: new Date("2026-10-07T12:54:00Z"),
};

interface JourneyProps {
  openInitially?: boolean;
  streamlinedTabs?: boolean;
  panelWidth?: number;
}

function TaskJourney({ openInitially = false, streamlinedTabs = false, panelWidth }: JourneyProps) {
  const [open, setOpen] = useState<{ id: string; title: string; requestId: number } | null>(() => openInitially ? { id: attachment.id, title: attachment.originalFilename!, requestId: 1 } : null);
  const [client] = useState(() => {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    cache.setQueryData(queryKeys.issues.attachments(issue.id), [attachment]);
    cache.setQueryData(queryKeys.issues.workProducts(issue.id), []);
    cache.setQueryData([...queryKeys.issues.documents(issue.id), "list"], []);
    cache.setQueryData([...queryKeys.issues.documents(issue.id), "plan"], null);
    cache.setQueryData(queryKeys.issues.runs(issue.id), []);
    cache.setQueryData(queryKeys.agents.list(issue.companyId), storybookAgents);
    cache.setQueryData(["task-text-attachment", issue.id, attachment.id], reportHtml);
    window.localStorage.removeItem(`paperclip:task-side-panel:v1:storybook-html:${issue.companyId}`);
    return cache;
  });
  return <QueryClientProvider client={client}>
    <TextAttachmentContext.Provider value={(id, title) => setOpen({ id, title, requestId: Date.now() })}>
      <div className="flex h-full min-h-0 flex-col gap-6 p-4 lg:flex-row">
        <section className="min-w-0 flex-1 space-y-6 overflow-auto">
          <h1 className="text-xl font-semibold">{issue.title}</h1>
          <TaskChatBubble item={{ id: "request", kind: "message", author: "human", text: "Give me a report that combines repository popularity and repeated Paperclip usage." }} />
          <TaskChatBubble item={{ id: "response", kind: "message", author: "agent", text: "Hyperswitch and Storybook lead the combined ranking. Open the report to explore the weighting and filter the results." }} />
          <IssueArtifactFile id={attachment.id} attachmentId={attachment.id} title="Interactive repository usage report" summary="" filename={attachment.originalFilename!} contentType={attachment.contentType} contentPath={attachment.contentPath} downloadPath={attachment.downloadPath!} byteSize={attachment.byteSize} author="CodexRunner" updatedAt="7:54 AM" />
        </section>
        <section className={`h-(--sz-640px) min-w-0 max-w-full overflow-hidden rounded-lg border border-border ${panelWidth ? "shrink-0" : "flex-1"}`} style={panelWidth ? { width: panelWidth } : undefined} aria-label="Task side panel">
          <TaskSidePanel issue={issue} accountScope="storybook-html" inline onUpdate={() => {}} fileTabsEnabled={false} openAttachment={open} streamlinedTabs={streamlinedTabs} artifactsOpenRequestId={streamlinedTabs ? 1 : undefined} />
        </section>
      </div>
    </TextAttachmentContext.Provider>
  </QueryClientProvider>;
}

function Journey(props: JourneyProps) {
  return <PluginLauncherProvider><Routes><Route path="/:companyPrefix" element={<Layout />}>
    <Route path="issues/:issueId" element={<TaskJourney {...props} />} />
  </Route></Routes></PluginLauncherProvider>;
}
const meta = {
  id: "html-artifacts-03-task-journey",
  title: "Tasks and conversations/Documents, attachments, and work products/HTML artifacts/03 Task journey", component: Journey,
  parameters: { layout: "fullscreen", initialEntries: ["/PAP/issues/html-artifact-journey"], docs: { description: { component: "Open the HTML artifact from the task's report card or Artifacts tab, filter the report, then switch to Raw beside Download. Uses the production app shell, artifact card, task panel and HTML renderer with simulated report data." }, story: { inline: false } },
    paperclip: {
      "capabilities": [
        "documents-artifacts/attachments",
        "workspaces/files-git",
        "navigation-preferences/navigation"
      ],
      "implementation": "production",
      "boundary": "fixtures"
    },
  },
  beforeEach: () => {
    const originalFetch = window.fetch;
    const fixtureFetch: typeof window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      if (url.pathname === `/api/issues/${issue.id}/work-products`) return Response.json([]);
      return originalFetch(input, init);
    };
    window.fetch = fixtureFetch;
    return () => { if (window.fetch === fixtureFetch) window.fetch = originalFetch; };
  },
  render: (args, context) => <Journey key={context.id} {...args} />,
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;
export const OpenFromTask: Story = {};
export const ReportOpen: Story = { args: { openInitially: true } };
export const Mobile: Story = { args: { openInitially: true }, globals: { viewport: { value: "mobile", isRotated: false } } };

export const StableTabWidths: Story = {
  args: { openInitially: true, streamlinedTabs: true, panelWidth: 320 },
  parameters: {
    docs: { description: { story: "Production task panel in a constrained pane. Switching between Artifacts, Properties, and the report keeps every tab the same width while the upload control appears or disappears. Upload requests remain outside this fixture's scope." } },
  },
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement).getByRole("region", { name: "Task side panel" });
    const canvas = within(panel);
    const widths = () => Array.from(panel.querySelectorAll<HTMLElement>("[data-side-panel-tab-wrapper]"))
      .map((tab) => tab.getBoundingClientRect().width);
    await userEvent.click(await canvas.findByRole("tab", { name: "Artifacts" }));
    await expect(canvas.getByRole("button", { name: "Upload files" })).toBeVisible();
    const baseline = widths();
    await expect(baseline).toHaveLength(3);
    await expect(new Set(baseline).size).toBe(1);
    for (const name of ["Properties", "repository-usage.html", "Artifacts"]) {
      await userEvent.click(canvas.getByRole("tab", { name }));
      await waitFor(() => expect(widths()).toEqual(baseline));
      if (name === "Artifacts") {
        await expect(canvas.getByRole("button", { name: "Upload files" })).toBeVisible();
      } else {
        await expect(canvas.queryByRole("button", { name: "Upload files" })).toBeNull();
      }
    }
  },
};
