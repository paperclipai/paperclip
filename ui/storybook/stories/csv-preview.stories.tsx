import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TaskWorkspaceFilePanel } from "@/components/task-side-panel/TaskWorkspaceFilePanel";
import { queryKeys } from "@/lib/queryKeys";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextAttachmentPreview } from "@/components/task-side-panel/TaskAttachmentPanel";

const meta: Meta<typeof TextAttachmentPreview> = {
  title: "Components/CSV File Tab",
  component: TextAttachmentPreview,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="h-screen bg-background text-foreground"><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof TextAttachmentPreview>;
export const RevenueExport: Story = {
  args: {
    title: "monthly-revenue.csv",
    markdown: false,
    csv: true,
    downloadUrl: "data:text/csv,Month%2CRevenue%0AOctober%2C12800",
    text: 'Month,Customer,Plan,Revenue,Status,Notes\nOctober,"Acme, Inc.",Enterprise,12800,Active,"Expanded to 40 seats"\nOctober,Northstar Studio,Pro,2400,Active,"Annual renewal"\nOctober,Atlas Labs,Enterprise,9600,Active,"Includes onboarding"\nOctober,Juniper Design,Starter,480,Trial,"Review on Friday"\nSeptember,"Acme, Inc.",Enterprise,11200,Active,"32 seats"\nSeptember,Northstar Studio,Pro,2400,Active,"Annual renewal"\nSeptember,Atlas Labs,Pro,4800,Active,"Upgrade scheduled"\nSeptember,Juniper Design,Starter,480,Trial,"First month"',
  },
};
export const Empty: Story = { args: { ...RevenueExport.args, text: "" } };
export const Invalid: Story = { args: { ...RevenueExport.args, text: 'Name,Notes\nSam,"unfinished' } };

// Exercise the same CSV renderer through the workspace tab query boundary.
function WorkspaceCsvTab() {
  const client = useQueryClient();
  const payload = { kind: "workspace-file" as const, path: "reports/monthly-revenue.csv", workspace: "auto" as const, projectId: null, workspaceId: null, line: null, column: null };
  const { kind: _kind, ...state } = payload;
  useState(() => {
    const resource = { kind: "file", provider: "git_worktree", title: "monthly-revenue.csv", displayPath: payload.path, workspaceLabel: "Report workspace", workspaceKind: "execution_workspace", workspaceId: "csv-story-workspace", contentType: "text/csv", byteSize: 512, previewKind: "text", capabilities: { preview: true, download: true, listChildren: false } };
    client.setQueryData(queryKeys.issues.fileResource("csv-story-task", state), resource);
    client.setQueryData(queryKeys.issues.fileResourceContent("csv-story-task", state), { resource, content: { encoding: "utf8", data: RevenueExport.args!.text } });
    return true;
  });
  return <TaskWorkspaceFilePanel issueId="csv-story-task" payload={payload} />;
}
export const WorkspaceTab: Story = { render: () => <WorkspaceCsvTab /> };
