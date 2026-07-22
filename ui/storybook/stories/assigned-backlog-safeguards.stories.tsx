import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { CircleDot, Flag, MoreHorizontal, Paperclip } from "lucide-react";
import type { IssueRelationIssueSummary } from "@paperclipai/shared";
import { IssueAssignedBacklogNotice } from "@/components/IssueAssignedBacklogNotice";
import { IssueBlockedNotice } from "@/components/IssueBlockedNotice";
import { IssueRow } from "@/components/IssueRow";
import { storybookAgents, createIssue } from "../fixtures/paperclipData";

const codexAgent = storybookAgents.find((agent) => agent.id === "agent-codex") ?? storybookAgents[0]!;
const qaAgent = storybookAgents.find((agent) => agent.id === "agent-qa") ?? storybookAgents[0]!;

function StoryFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">Assigned-backlog UI safeguards</div>
          <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

function CreationFormPanel() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-sm font-medium text-muted-foreground">A. Issue creation chip bar with intent note</div>

      <div className="space-y-3 rounded-md border border-border/60 bg-background p-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="w-6 shrink-0 text-center">For</span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
            ClaudeCoder
          </span>
          <span>in</span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
            Paperclip App
          </span>
        </div>
        <div className="space-y-1.5">
          <div className="text-sm font-semibold">Fix flaky deploy step on the worker pipeline</div>
          <div className="text-xs text-muted-foreground">
            Investigate the intermittent timeout the worker pipeline hit during the last release rehearsal.
          </div>
        </div>
        <div className="flex items-center gap-1.5 border-t border-border pt-3 flex-wrap">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-amber-100/40 px-2 py-1 text-xs dark:bg-amber-500/10">
            <CircleDot className="h-3 w-3 text-purple-500" />
            Backlog
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
            <CircleDot className="h-3 w-3 text-amber-500" />
            High
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
            <Paperclip className="h-3 w-3" />
            Upload
          </span>
          <span className="inline-flex items-center justify-center rounded-md border border-border p-1 text-xs text-muted-foreground">
            <MoreHorizontal className="h-3 w-3" />
          </span>
        </div>
        <div className="flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
          <span className="leading-snug">
            Assigning implies executable intent — leave status as <span className="font-medium">Backlog</span> only to deliberately park this. The assignee will not be woken until status moves to <span className="font-medium">Todo</span> or <span className="font-medium">In Progress</span>.
          </span>
        </div>
      </div>

      <div className="mt-4 rounded-md border border-border bg-popover p-1 text-xs">
        <div className="px-2 pb-1 text-[10px] uppercase text-muted-foreground">Status options</div>
        <div className="flex w-full items-start gap-2 rounded px-2 py-1.5 hover:bg-accent/50">
          <CircleDot className="h-3 w-3 mt-0.5 shrink-0 text-purple-500" />
          <span className="flex flex-col text-left leading-tight">
            <span>Backlog</span>
            <span className="text-[10px] text-muted-foreground">Parked — assignee will not be woken</span>
          </span>
        </div>
        <div className="flex w-full items-start gap-2 rounded bg-accent px-2 py-1.5">
          <CircleDot className="h-3 w-3 mt-0.5 shrink-0 text-blue-500" />
          <span className="flex flex-col text-left leading-tight">
            <span>Todo</span>
            <span className="text-[10px] text-muted-foreground">Executable — assignee will be woken</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function AssignedBacklogNoticePanel() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-sm font-medium text-muted-foreground">B. Issue panel banner — parked with assignee</div>
      <IssueAssignedBacklogNotice
        issueStatus="backlog"
        assigneeAgent={qaAgent}
        assigneeUserId={null}
        onResume={() => undefined}
      />
    </div>
  );
}

function BlockedByParkedWorkPanel() {
  const parkedBlocker: IssueRelationIssueSummary = {
    id: "blocker-parked",
    identifier: "PAP-3683",
    title: "Adapter restart fails after upgrade",
    status: "backlog",
    priority: "critical",
    assigneeAgentId: codexAgent.id,
    assigneeUserId: null,
  };
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-sm font-medium text-muted-foreground">C. Parent issue blocked by parked work</div>
      <IssueBlockedNotice
        issueStatus="blocked"
        blockers={[parkedBlocker]}
        blockerAttention={{
          state: "needs_attention",
          reason: "attention_required",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 0,
          stalledBlockerCount: 0,
          attentionBlockerCount: 1,
          sampleBlockerIdentifier: parkedBlocker.identifier,
          sampleStalledBlockerIdentifier: null,
        }}
      />
    </div>
  );
}

function ListRowsPanel() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-sm font-medium text-muted-foreground">D. Issue list row indicators</div>
      <div className="rounded-md border border-border">
        <IssueRow
          issue={createIssue({
            id: "issue-blocked-parent",
            identifier: "PAP-3643",
            issueNumber: 3643,
            title: "Restart deploy run after fixed adapter",
            status: "blocked",
            priority: "high",
            blockedBy: [
              {
                id: "blocker-parked-leaf",
                identifier: "PAP-3683",
                title: "Adapter restart fails after upgrade",
                status: "backlog",
                priority: "critical",
                assigneeAgentId: codexAgent.id,
                assigneeUserId: null,
              },
            ],
            blockerAttention: {
              state: "needs_attention",
              reason: "attention_required",
              unresolvedBlockerCount: 1,
              coveredBlockerCount: 0,
              stalledBlockerCount: 0,
              attentionBlockerCount: 1,
              sampleBlockerIdentifier: "PAP-3683",
              sampleStalledBlockerIdentifier: null,
            },
          })}
        />
        <IssueRow
          issue={createIssue({
            id: "issue-healthy",
            identifier: "PAP-3644",
            issueNumber: 3644,
            title: "Compute new deploy budget for next cycle",
            status: "in_progress",
            priority: "medium",
            blockedBy: [],
          })}
        />
      </div>
    </div>
  );
}

function AllStates() {
  return (
    <StoryFrame title="Assigned-backlog liveness UI">
      <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <CreationFormPanel />
        <AssignedBacklogNoticePanel />
      </section>
      <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <BlockedByParkedWorkPanel />
        <ListRowsPanel />
      </section>
    </StoryFrame>
  );
}

const meta = {
  title: "Paperclip/Assigned Backlog Safeguards",
  component: AllStates,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AllStates>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
export const CreationForm: Story = {
  render: () => (
    <StoryFrame title="Issue creation chip bar with intent note">
      <CreationFormPanel />
    </StoryFrame>
  ),
};
export const AssignedBacklogBanner: Story = {
  render: () => (
    <StoryFrame title="Issue panel banner — parked with assignee">
      <AssignedBacklogNoticePanel />
    </StoryFrame>
  ),
};
export const BlockedByParkedWork: Story = {
  render: () => (
    <StoryFrame title="Parent issue blocked by parked work">
      <BlockedByParkedWorkPanel />
    </StoryFrame>
  ),
};
export const ListRows: Story = {
  render: () => (
    <StoryFrame title="Issue list row indicators">
      <ListRowsPanel />
    </StoryFrame>
  ),
};
