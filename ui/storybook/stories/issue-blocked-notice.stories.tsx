import type { Meta, StoryObj } from "@storybook/react-vite";
import type { IssueRelationIssueSummary } from "@paperclipai/shared";
import { IssueBlockedNotice } from "@/components/IssueBlockedNotice";
import {
  resolveTaskChatLiveWork,
  TaskChatBlockerLinks,
  TaskChatLiveWorkLinks,
} from "@/components/task-chat/TaskChatBlockerLinks";

// Rule C (PAP-13554): when a human comment on a `blocked` issue does not reopen
// it, the blocked notice must state why and name the unresolved blocker leaf.
// These stories exercise the reopen-suppressed copy and its neighbours so the
// notice copy can be reviewed at a glance.

function blocker(
  overrides: Partial<IssueRelationIssueSummary> & Pick<IssueRelationIssueSummary, "id" | "identifier" | "title" | "status">,
): IssueRelationIssueSummary {
  return {
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    ...overrides,
  } as IssueRelationIssueSummary;
}

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[640px] space-y-2 p-6">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

const meta = {
  title: "Product/Issue/Blocked notice",
  component: IssueBlockedNotice,
  // Each story supplies its own props via `render`; this default satisfies the
  // component's one required prop (`blockers`) so the story args type-checks.
  args: { blockers: [] },
  parameters: {
    docs: {
      description: {
        component:
          "Blocked/recovery notice on the issue thread. Rule C: a `blocked` issue with a genuinely unresolved (not-done) blocker tells the human that a message won't reopen it yet and names the unresolved leaf with its status. Done-but-pending-finalize blockers are `done`, so they fall into the Rule B reopen path and are NOT shown as reopen-suppressed.",
      },
    },
  },
} satisfies Meta<typeof IssueBlockedNotice>;

export default meta;

type Story = StoryObj<typeof meta>;

export const RuleCSingleBlocker: Story = {
  name: "Rule C · single unresolved blocker",
  render: () => (
    <Frame label="Blocked · one in-progress blocker — a message won't reopen it yet">
      <IssueBlockedNotice
        issueId="issue-1"
        issueStatus="blocked"
        agentName="CodexCoder"
        blockers={[
          blocker({
            id: "b1",
            identifier: "PAP-500",
            title: "Server work still in flight",
            status: "in_progress",
          }),
        ]}
      />
    </Frame>
  ),
};

export const RuleCChainNamesLeaf: Story = {
  name: "Rule C · chain names the deepest leaf",
  render: () => (
    <Frame label="Blocked · direct blocker in review, ultimately waiting on an in-progress leaf">
      <IssueBlockedNotice
        issueId="issue-2"
        issueStatus="blocked"
        agentName="CodexCoder"
        blockers={[
          blocker({
            id: "b1",
            identifier: "PAP-600",
            title: "Waiting in review",
            status: "in_review",
            terminalBlockers: [
              blocker({
                id: "t1",
                identifier: "PAP-777",
                title: "Actual work",
                status: "in_progress",
                assigneeAgentId: "agent-2",
              }),
            ],
          }),
        ]}
      />
    </Frame>
  ),
};

export const TaskChatCompactRows: Story = {
  name: "Task chat · compact direct and ultimate blocker rows",
  render: () => (
    <Frame label="Task chat · lightweight blocker links">
      <TaskChatBlockerLinks
        placement="top"
        directBlocker={blocker({
          id: "b1",
          identifier: "PAP-600",
          title: "Waiting in review",
          status: "in_review",
        })}
        ultimateBlocker={blocker({
          id: "t1",
          identifier: "PAP-777",
          title: "Actual work",
          status: "in_progress",
          assigneeAgentId: "agent-2",
        })}
      />
    </Frame>
  ),
};

export const TaskChatLiveWorkRows: Story = {
  name: "Task chat · ordered live-work rows",
  render: () => {
    const terminal = blocker({
      id: "t1",
      identifier: "PAP-603",
      title: "Restore the live projection",
      status: "in_progress",
      assigneeAgentId: "agent-3",
    });
    const liveWork = resolveTaskChatLiveWork([
      blocker({ id: "b1", identifier: "PAP-601", title: "Run the guarded cutover", status: "done" }),
      blocker({
        id: "b2",
        identifier: "PAP-602",
        title: "Verify the live projection",
        status: "in_progress",
        assigneeAgentId: "agent-2",
        terminalBlockers: [terminal],
      }),
      blocker({ id: "b3", identifier: "PAP-604", title: "Complete final QA", status: "todo" }),
    ], new Set(["b2", "t1"]), terminal);

    return (
      <Frame label="Task chat · compact ordered live-work links">
        {liveWork ? <TaskChatLiveWorkLinks placement="top" liveWork={liveWork} /> : null}
      </Frame>
    );
  },
};

export const RuleCMultipleBlockers: Story = {
  name: "Rule C · several unresolved blockers",
  render: () => (
    <Frame label="Blocked · two unresolved blockers — count is summarized">
      <IssueBlockedNotice
        issueId="issue-3"
        issueStatus="blocked"
        agentName="CodexCoder"
        blockers={[
          blocker({ id: "b1", identifier: "PAP-501", title: "First dependency", status: "in_progress" }),
          blocker({ id: "b2", identifier: "PAP-502", title: "Second dependency", status: "todo" }),
        ]}
      />
    </Frame>
  ),
};

export const BlockedNoUnresolvedBlockers: Story = {
  name: "Rule B path · blocked, no unresolved blockers",
  render: () => (
    <Frame label="Blocked · all blocker edges done/absent — a message WILL move it back to todo">
      <IssueBlockedNotice issueId="issue-4" issueStatus="blocked" agentName="CodexCoder" blockers={[]} />
    </Frame>
  ),
};

export const InProgressWithBlocker: Story = {
  name: "In progress · blocker edge (not a reopen case)",
  render: () => (
    <Frame label="In progress · has a blocker edge — no reopen framing">
      <IssueBlockedNotice
        issueId="issue-5"
        issueStatus="in_progress"
        agentName="CodexCoder"
        blockers={[
          blocker({ id: "b1", identifier: "PAP-800", title: "Dependency", status: "in_progress" }),
        ]}
      />
    </Frame>
  ),
};
