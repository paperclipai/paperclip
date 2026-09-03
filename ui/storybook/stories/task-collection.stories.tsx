import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue } from "@paperclipai/shared";
import { Columns3, Filter, MoreHorizontal, Plus, Search } from "lucide-react";
import { CollectionToolbar } from "@/components/CollectionToolbar";
import { IssueRow } from "@/components/IssueRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { storybookIssues } from "../fixtures/paperclipData";

const baseIssue = storybookIssues[0]!;
const taskRows: Issue[] = [
  {
    ...baseIssue,
    id: "collection-task-1",
    identifier: "PAP-427",
    title: "Reconcile the navigation model across operator surfaces",
    status: "in_progress",
    isUnreadForMe: true,
  },
  {
    ...baseIssue,
    id: "collection-task-2",
    identifier: "PAP-431",
    title: "Verify a deliberately long task title truncates before metadata and actions move out of view",
    status: "blocked",
    isUnreadForMe: false,
  },
  {
    ...baseIssue,
    id: "collection-task-3",
    identifier: "PAP-438",
    title: "Publish the visual review fixtures",
    status: "done",
    isUnreadForMe: false,
  },
];

function TaskCollectionFoundation() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <CollectionToolbar
        ariaLabel="Task collection controls"
        context={<span className="text-sm font-medium">Recent tasks</span>}
        search={(
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search tasks" placeholder="Search tasks..." className="pl-7" />
          </div>
        )}
        controls={(
          <>
            <Button variant="outline" size="sm"><Filter className="h-3.5 w-3.5" /> Filter</Button>
            <Button variant="outline" size="icon-sm" aria-label="Choose columns"><Columns3 className="h-3.5 w-3.5" /></Button>
          </>
        )}
        actions={<Button size="sm"><Plus className="h-3.5 w-3.5" /> New task</Button>}
        feedback={<span className="text-xs text-muted-foreground">3 tasks · Updated newest first</span>}
      />

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Today</div>
        {taskRows.slice(0, 2).map((issue, index) => (
          <IssueRow
            key={issue.id}
            issue={issue}
            presentation="task"
            unreadState={index === 0 ? "visible" : "hidden"}
            metadata={<span className="text-xs text-muted-foreground">{index === 0 ? "12m" : "1h"}</span>}
            actions={(
              <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${issue.identifier}`}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            )}
            showDivider
          />
        ))}
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Yesterday</div>
        <IssueRow
          issue={taskRows[2]!}
          presentation="task"
          unreadState="hidden"
          metadata={<span className="text-xs text-muted-foreground">Yesterday</span>}
        />
      </div>
    </div>
  );
}

const meta = {
  title: "Foundations/Task collection",
  component: TaskCollectionFoundation,
  parameters: {
    docs: {
      description: {
        component:
          "Shared collection geometry and the opt-in canonical task row. Behavior remains owned by each consuming page; status leads, unread state uses title weight, and the machine identifier trails.",
      },
    },
  },
} satisfies Meta<typeof TaskCollectionFoundation>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = { render: () => <TaskCollectionFoundation /> };

export const CompactViewport: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => <TaskCollectionFoundation />,
};
