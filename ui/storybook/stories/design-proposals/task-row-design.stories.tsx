import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { Fragment, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { Issue } from "@paperclipai/shared";
import { IssueRow } from "@/components/IssueRow";
import { TaskRowGroup } from "@/components/TaskRowGroup";
import { TaskList } from "@/components/TaskList";
import { TaskSummaryList } from "@/components/TaskSummaryList";
import { allTaskListColumns, defaultTaskListSort, sortTaskListItems, type TaskListSort } from "@/lib/task-list";
import { buildIssueTree } from "@/lib/issue-tree";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLocation } from "@/lib/router";
import { timeAgo } from "@/lib/timeAgo";
import { chatTask, columnData, connectorParent, healthTask, longTitle, ownerFor, readTask, recoveryChild, reviewTaskItems, sortValue, treeTasks, unreadTask } from "../../support/design-proposals/task-list-data";

type Density = "comfortable" | "compact";
type ContainerWidth = "standard" | "narrow" | "smallest";
type PlaygroundProps = {
  density: Density;
  containerWidth: ContainerWidth;
  onDensityChange?: (density: Density) => void;
  onWidthChange?: (width: ContainerWidth) => void;
};

function ReviewFrame({ title, detail, children, wide = false }: { title: string; detail: string; children: ReactNode; wide?: boolean }) {
  const location = useLocation();
  return (
    <main data-testid="task-row-design-preview" className="task-row-design-preview min-h-screen px-6 py-10 text-foreground sm:px-10">
      <output hidden data-testid="task-row-design-route">{location.pathname}</output>
      <div className={`mx-auto flex flex-col gap-8 ${wide ? "max-w-none" : "max-w-6xl"}`}>
        <header className="flex flex-col gap-3">
          <p className="text-xs font-normal text-muted-foreground">Paperclip · Design system · Proposed</p>
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{detail}</p>
        </header>
        {children}
      </div>
    </main>
  );
}

function Row({
  issue,
  density = "comfortable",
  unread = false,
  depth = 0,
  expanded,
  onToggle,
  owner = "Codex",
  allColumns = false,
}: {
  issue: Issue;
  density?: Density;
  unread?: boolean;
  depth?: number;
  expanded?: boolean;
  onToggle?: () => void;
  owner?: string;
  allColumns?: boolean;
}) {
  const data = columnData(issue, owner);
  const { parent } = data;
  const rowIssue = allColumns ? data.issue : issue;
  const rowLabels = rowIssue.labels ?? [];
  return (
    <IssueRow
      issue={rowIssue}
      presentation="task"
      appearance="refreshed"
      density={density}
      unreadState={unread ? "visible" : "hidden"}
      treeGuides={depth}
      chevronInGuide={depth > 0 && Boolean(onToggle)}
      leadingControl={onToggle ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="task-row-disclosure"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${issue.title}`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        </Button>
      ) : undefined}
      metadata={<span className="block w-24 truncate text-xs text-muted-foreground">{owner}</span>}
      trailingMeta="2h ago"
      columnValues={allColumns ? {
        createdBy: data.creator,
        assignee: data.assignee ?? "Unassigned",
        project: rowIssue.project?.name,
        parentTask: parent ? <span><span className="font-mono">{parent.identifier}</span> {parent.title}</span> : undefined,
        tags: rowLabels.length ? <span className="inline-flex items-center gap-1">{rowLabels.map(label => <Badge key={label.id} variant="secondary" className="shrink-0 px-1.5 py-0">{label.name}</Badge>)}</span> : undefined,
        lastUpdated: timeAgo(rowIssue.updatedAt),
        worktree: rowIssue.currentExecutionWorkspace?.branchName ? <span className="inline-flex items-center gap-1.5"><GitBranch className="size-3 shrink-0" aria-hidden />{rowIssue.currentExecutionWorkspace.branchName}</span> : undefined,
      } : undefined}
    />
  );
}

function TaskTree({ density = "comfortable", allColumns = false, sort = defaultTaskListSort }: { density?: Density; allColumns?: boolean; sort?: TaskListSort }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const { roots, childMap } = buildIssueTree(sortTaskListItems(treeTasks, sort, sortValue));
  const renderBranch = (issue: Issue, depth: number): ReactNode => {
    const children = childMap.get(issue.id) ?? [];
    const expanded = !collapsed.has(issue.id);
    return (
      <Fragment key={issue.id}>
        <Row issue={issue} density={density} allColumns={allColumns} depth={depth} unread={issue === connectorParent || issue === healthTask} owner={ownerFor(issue)} expanded={expanded} onToggle={children.length ? () => setCollapsed(current => {
          const next = new Set(current);
          if (next.has(issue.id)) next.delete(issue.id); else next.add(issue.id);
          return next;
        }) : undefined} />
        {expanded ? children.map(child => renderBranch(child, depth + 1)) : null}
      </Fragment>
    );
  };
  return (
    <div aria-label={`${density} task list`}>
      {roots.map(issue => (
        <TaskRowGroup key={issue.id} role={allColumns ? "rowgroup" : "group"} aria-label={issue === connectorParent ? "Connector reliability task group" : issue === chatTask ? "Chat style task group" : "Empty-state task group"}>
          {renderBranch(issue, 0)}
        </TaskRowGroup>
      ))}
    </div>
  );
}

function InteractiveColumns() {
  return (
    <ReviewFrame wide title="Task-list columns" detail="Click a header to sort, or drag it left or right to rearrange columns. Alt + Left/Right also reorders a focused header. Tasks stay with their parents. Use Columns to show or hide columns.">
      <section className="min-w-0 space-y-4" aria-label="Complete task-list column specimen">
        <TaskList items={reviewTaskItems} initialColumns={allTaskListColumns} />
        <p className="text-xs text-muted-foreground">An em dash means no value. Column choices and sorting are local to this preview. Task includes status and title. Reset defaults shows Task, Task ID, and Last updated.</p>
      </section>
    </ReviewFrame>
  );
}

function StateSamples({ density = "comfortable" }: { density?: Density }) {
  return (
    <section className="flex flex-col gap-4" aria-label="Title states">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-normal">Read and unread</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">Hover either row: the title becomes foreground and the row background changes. Weight continues to indicate unread status.</p>
      </div>
      <div className="grid gap-6">
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs text-muted-foreground">Read · Regular</p>
          <TaskRowGroup><Row issue={readTask} density={density} /></TaskRowGroup>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs text-muted-foreground">Unread · Semibold</p>
          <TaskRowGroup><Row issue={unreadTask} density={density} unread /></TaskRowGroup>
        </div>
      </div>
    </section>
  );
}

function TaskRowSpecimen({ density = "comfortable", containerWidth = "standard", onDensityChange, onWidthChange }: PlaygroundProps) {
  const widthClass = { standard: "w-full", narrow: "w-96", smallest: "w-64" }[containerWidth];
  return (
    <ReviewFrame
      title="Task rows"
      detail="Change row density and container width to explore title states and nesting. Truncated text reveals on hover or keyboard focus and resets on exit."
    >
      <div className="flex flex-wrap gap-6" aria-label="Playground controls">
        <div role="group" aria-label="Row density" className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Row density</span>
          {(["comfortable", "compact"] as const).map(value => <Button key={value} size="sm" variant={density === value ? "secondary" : "outline"} aria-pressed={density === value} onClick={() => onDensityChange?.(value)}>
            {value === "comfortable" ? "Comfortable (44px)" : "Compact (32px)"}
          </Button>)}
        </div>
        <div role="group" aria-label="Container width" className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Container width</span>
          {(["standard", "narrow", "smallest"] as const).map(value => <Button key={value} size="sm" variant={containerWidth === value ? "secondary" : "outline"} aria-pressed={containerWidth === value} onClick={() => onWidthChange?.(value)}>
            {value === "standard" ? "Standard" : value === "narrow" ? "Narrow" : "Smallest"}
          </Button>)}
        </div>
      </div>
      <div data-testid="task-row-playground-container" className={`task-row-responsive-container flex max-w-full flex-col gap-8 ${widthClass}`}>
        <section className="flex flex-col gap-4" aria-label={`${density === "comfortable" ? "Comfortable" : "Compact"} density specimen`}>
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-normal">{density === "comfortable" ? "Comfortable" : "Compact"}</h2>
            <p className="font-mono text-xs text-muted-foreground">{density === "comfortable" ? "44px" : "32px"} rows · 24px nesting</p>
          </div>
          <TaskTree density={density} />
          <p className="text-xs leading-relaxed text-muted-foreground">Vertical guides connect nested tasks. One boundary encloses each parent and all its visible descendants; child rows have no horizontal separators.</p>
        </section>
        <StateSamples density={density} />
      </div>
      <footer className="text-xs leading-relaxed text-muted-foreground">This playground uses the shared task-row component with fixture data. Narrow containers show status, title and timestamp; the smallest containers show status and title. Fixed stories remain available as review references. Review the full composition under Design proposals → Pages → Tasks.</footer>
    </ReviewFrame>
  );
}

const meta = {
  id: "tasks-row-design",
  title: "Design proposals/Components/Task list",
  component: TaskRowSpecimen,
  args: { density: "comfortable", containerWidth: "standard" },
  argTypes: {
    density: { control: "inline-radio", options: ["comfortable", "compact"] },
    containerWidth: { control: "inline-radio", options: ["standard", "narrow", "smallest"] },
    onDensityChange: { control: false, table: { disable: true } },
    onWidthChange: { control: false, table: { disable: true } },
  },
  parameters: {
    layout: "fullscreen",
    controls: { include: [] },
    docs: {
      description: {
        component: "Proposed task-row design using production IssueRow and TaskRowGroup. Comfortable and compact share one component. Read/unread typography is independent of hover; nested guides and group boundaries follow the parent hierarchy. Use real pointer hover to inspect the four visual combinations. Play assertions cover typography, disclosure, and full-title access; fixtures do not establish production navigation or persistence.",
      },
    },
    paperclip: {
      capabilities: ["tasks/organize"],
      status: "proposed",
      home: "design-proposals",
      exception: "Staged design-system refresh awaiting visual review and app adoption; kept separate from production references.",
      implementation: "production",
      boundary: "fixtures",
      notes: "Library specimen of refreshed IssueRow, TaskRowGroup, and TaskListColumnHeader. Task combines status and title under one header and visibility choice; Task sorting uses titles, with no status sort. All Columns starts with every column and demonstrates sibling hierarchy, sorting, pointer/keyboard column reordering, pinned column settings, visibility and reset using local fixture state. Last updated is last by default; the flyout follows the current column order. Reset restores that order and shows only Task, Task ID, and Last updated. The Columns flyout follows the Paper reference with compact 32px items, regular labels, and right-aligned checks. Sorted headers retain their background. Table typography uses sm with a 16px line height; every truncated cell uses a local marquee. The entire proposal canvas uses Paper's background token. Status tooltips use shared labels. The composition is under review and does not establish production API, preference persistence, or full accessibility acceptance.",
    },
  },
} satisfies Meta<typeof TaskRowSpecimen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Keep the export stable so existing specimen links continue to work. */
export const Specimen: Story = {
  name: "Playground",
  parameters: { controls: { include: ["density", "containerWidth"] } },
  render: function Playground(args) {
    const [, updateArgs] = useArgs<PlaygroundProps>();
    return <TaskRowSpecimen {...args} onDensityChange={density => updateArgs({ density })} onWidthChange={containerWidth => updateArgs({ containerWidth })} />;
  },
};

export const AllColumns: Story = {
  render: () => <InteractiveColumns />,
};

export const Summary: Story = {
  name: "Narrow",
  parameters: {
    paperclip: {
      capabilities: ["tasks/organize", "activity/overview"],
      status: "proposed", home: "design-proposals", implementation: "production", boundary: "fixtures",
      exception: "Reusable narrow summary staged with the task-list proposal; Dashboard opts in only in the local integration sandbox.",
      notes: "TaskSummaryList renders the same refreshed IssueRow in a flat, read-style list. It preserves 44px density, sm typography, hover, status tooltip, cell-local marquee and full task navigation. Task ID hides below a 28rem container; time hides below 20rem. Rendering does not mark tasks read. The caller owns ordering and data; no table headers, column controls, query controller or hierarchy are introduced. The normal Dashboard remains unchanged when the design sandbox is off.",
    },
  },
  render: () => <ReviewFrame title="Task summaries" detail="The same read-style task row in smaller containers. Row height and text size stay fixed; optional metadata yields space to the title.">
    <section aria-label="Standard task summary" className="max-w-2xl space-y-3">
      <h2 className="text-sm font-normal">Standard · Status, title, task ID, last updated</h2>
      <TaskRowGroup><TaskSummaryList label="Standard task summary" issues={[recoveryChild, healthTask, chatTask]} /></TaskRowGroup>
    </section>
    <section aria-label="Narrow task summary" className="w-96 max-w-full space-y-3">
      <h2 className="text-sm font-normal">Narrow · Status, title, timestamp</h2>
      <TaskRowGroup><TaskSummaryList label="Narrow task summary" issues={[recoveryChild, healthTask, chatTask]} /></TaskRowGroup>
    </section>
    <section aria-label="Smallest task summary" className="w-64 max-w-full space-y-3">
      <h2 className="text-sm font-normal">Smallest · Status and title</h2>
      <TaskRowGroup><TaskSummaryList label="Smallest task summary" issues={[recoveryChild, healthTask, chatTask]} /></TaskRowGroup>
    </section>
  </ReviewFrame>,
};

export const Comfortable: Story = {
  render: () => (
    <ReviewFrame title="Comfortable rows" detail="44px task rows. Expand the nested branch to inspect continuous guides and aligned metadata.">
      <TaskTree />
    </ReviewFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rootControl = canvas.getByRole("button", { name: "Collapse Improve connector reliability" });
    await userEvent.click(rootControl);
    await expect(canvas.queryByRole("link", { name: /Open PAP-429:/ })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Expand Improve connector reliability" }));
    await expect(canvas.getByRole("link", { name: /Open PAP-429:/ })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Collapse Design reconnect and recovery flows" }));
    await expect(canvas.queryByRole("link", { name: /Open PAP-431:/ })).not.toBeInTheDocument();
    await expect(canvas.getByRole("link", { name: /Open PAP-432:/ })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Expand Design reconnect and recovery flows" }));
    await expect(canvas.getByRole("link", { name: /Open PAP-431:/ })).toBeVisible();
    for (const row of canvasElement.querySelectorAll<HTMLElement>('[data-slot="task-row"]')) {
      await expect(row.getBoundingClientRect().height).toBe(44);
    }
    // Restore an unfocused, unhovered specimen for subsequent visual review.
    (canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
    await userEvent.unhover(rootControl);
  },
};

export const Compact: Story = {
  render: () => (
    <ReviewFrame title="Compact rows" detail="32px preview of the same task row. This defines the future density option; it does not add a user setting yet.">
      <TaskTree density="compact" />
    </ReviewFrame>
  ),
  play: async ({ canvasElement }) => {
    for (const row of canvasElement.querySelectorAll<HTMLElement>('[data-slot="task-row"]')) {
      await expect(row.getBoundingClientRect().height).toBe(32);
    }
  },
};

function SingleState({ unread }: { unread: boolean }) {
  return (
    <ReviewFrame
      title={unread ? "Unread title" : "Read title"}
      detail={unread ? "Semibold foreground. Hover changes the background while preserving the title’s color and weight." : "Regular muted foreground. Hover changes the background and promotes the title to foreground without changing its weight."}
    >
      <TaskRowGroup><Row issue={recoveryChild} unread={unread} /></TaskRowGroup>
    </ReviewFrame>
  );
}

async function checkTitleAccess(canvasElement: HTMLElement, unread: boolean) {
  const canvas = within(canvasElement);
  const link = canvas.getByRole("link", { name: `Open PAP-431: ${longTitle}` });
  const row = link.closest<HTMLElement>('[data-slot="task-row"]')!;
  const title = row.querySelector<HTMLElement>('[data-slot="task-row-title"]')!;
  const text = title.querySelector<HTMLElement>('[data-slot="task-row-title-text"]')!;
  await expect(getComputedStyle(title).fontWeight).toBe(unread ? "600" : "400");
  await expect(text.scrollWidth).toBeGreaterThan(title.clientWidth);
  await userEvent.pointer({ target: link, coords: { clientX: title.getBoundingClientRect().left + title.clientWidth / 2, clientY: title.getBoundingClientRect().top + title.clientHeight / 2 } });
  await expect(title).toHaveAttribute("data-revealing", "true");
  await expect(within(canvasElement.ownerDocument.body).queryByRole("tooltip")).not.toBeInTheDocument();
  await userEvent.unhover(link);
  await expect(title).not.toHaveAttribute("data-revealing");
  link.focus();
  await expect(link).toHaveFocus();
  await waitFor(() => expect(title).toHaveAttribute("data-revealing", "true"));
  link.blur();
  await userEvent.keyboard("{Escape}");
}

export const Read: Story = {
  render: () => <SingleState unread={false} />,
  play: async ({ canvasElement }) => checkTitleAccess(canvasElement, false),
};

export const Unread: Story = {
  render: () => <SingleState unread />,
  play: async ({ canvasElement }) => checkTitleAccess(canvasElement, true),
};
