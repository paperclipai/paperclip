import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueAttachment } from "@paperclipai/shared";
import { TaskSidePanel } from "@/components/task-side-panel/TaskSidePanel";
import { queryKeys } from "@/lib/queryKeys";
import { createIssue } from "../fixtures/paperclipData";

const markdown = "# Account review charter\n\nInvestigate whether new and active accounts succeeded.\n\n## Rules\n\n- Read customer data only.\n- Keep private information out of reports.\n- Report failures with evidence.\n\n```text\nReview → Evidence → Report\n```";
const plain = "Daily review summary\n\nAccounts reviewed: 20\nCompleted successfully: 18\nNeeds investigation: 2\n\n<This is plain text, not HTML.>";
function TextFilesStory({ initial = "list", width = 640 }: { initial?: "list" | "markdown" | "text" | "empty" | "large" | "missing"; width?: number }) {
  const [fixture] = useState(() => {
    const issue = createIssue({ id: `text-files-${initial}-${width}`, title: "Review account outcomes", conversationAgentId: "reviewer" });
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const files = [
      { id: "charter", originalFilename: "AGENTS.md", contentType: "text/markdown", byteSize: 320 },
      { id: "summary", originalFilename: "summary.txt", contentType: "text/plain", byteSize: 160 },
      { id: "empty", originalFilename: "empty.txt", contentType: "text/plain", byteSize: 0 },
      { id: "large", originalFilename: "large.log", contentType: "text/plain", byteSize: 600000 },
    ].map((file) => ({ ...file, issueId: issue.id, companyId: issue.companyId, createdByAgentId: "reviewer", createdByUserId: null, issueCommentId: null, objectKey: file.originalFilename, contentPath: `/api/attachments/${file.id}/content`, downloadPath: `data:text/plain;charset=utf-8,${encodeURIComponent(file.id === "charter" ? markdown : plain)}`, createdAt: new Date("2026-09-27T00:00:00Z"), updatedAt: new Date("2026-09-27T00:00:00Z") } as IssueAttachment));
    client.setQueryData(queryKeys.issues.attachments(issue.id), files);
    client.setQueryData(queryKeys.issues.workProducts(issue.id), []);
    client.setQueryData([...queryKeys.issues.documents(issue.id), "list"], []);
    client.setQueryData([...queryKeys.issues.documents(issue.id), "plan"], null);
    client.setQueryData(queryKeys.issues.runs(issue.id), []);
    client.setQueryData(queryKeys.agents.list(issue.companyId), []);
    for (const [id, text] of [["charter", markdown], ["summary", plain], ["empty", ""]]) client.setQueryData(["task-text-attachment", issue.id, id], text);
    window.localStorage.removeItem(`paperclip:task-side-panel:v1:storybook-text-files:${issue.companyId}`);
    return { client, issue };
  });
  const id = initial === "markdown" ? "charter" : initial === "text" ? "summary" : initial;
  return <QueryClientProvider client={fixture.client}>
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex max-w-6xl flex-wrap gap-6">
        <div className="min-w-0 flex-1"><h1 className="text-xl font-semibold">Review account outcomes</h1><p className="mt-3 text-sm text-muted-foreground">Open AGENTS.md or summary.txt from Artifacts. Each file opens in its own tab. Markdown can switch between rendered and raw text.</p></div>
        <section className="h-(--sz-640px) max-w-full overflow-hidden rounded-lg border border-border" style={{ width }} aria-label="Task side panel">
          <TaskSidePanel issue={fixture.issue} accountScope="storybook-text-files" inline onUpdate={() => {}} fileTabsEnabled={false} openAttachment={initial === "list" ? null : { id, title: id === "charter" ? "AGENTS.md" : `${id}.txt`, requestId: 1 }} />
        </section>
      </div>
    </main>
  </QueryClientProvider>;
}
const meta = { title: "Tasks/Text file tabs", component: TextFilesStory, parameters: { layout: "fullscreen" }, render: (args, context) => <TextFilesStory key={context.id} {...args} /> } satisfies Meta<typeof TextFilesStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const OpenFromArtifacts: Story = {};
export const Markdown: Story = { args: { initial: "markdown" } };
export const PlainText: Story = { args: { initial: "text" } };
export const Empty: Story = { args: { initial: "empty" } };
export const Oversize: Story = { args: { initial: "large" } };
export const Missing: Story = { args: { initial: "missing" } };
export const Narrow: Story = { args: { initial: "markdown", width: 360 } };
