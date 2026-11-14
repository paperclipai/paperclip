import type { Meta, StoryObj } from "@storybook/react-vite";
import { InboxIssueTrailingColumns } from "@/components/IssueColumns";
import { storybookIssues } from "../../fixtures/paperclipData";

const names = [
  { id: "agent-spaces", name: "Research and Engineering Agent With a Very Long Display Name", human: false },
  { id: "agent-unbroken", name: "ResearchAndEngineeringAgentWithAVeryLongUnbrokenDisplayName", human: false },
  { id: "human", name: "Alexandria Morgan With a Very Long Display Name", human: true },
  { id: "short", name: "Ada", human: false },
];

function TaskColumnIdentities() {
  return (
    <div className="flex flex-col gap-4">
      {names.map(({ id, name, human }) => (
        <div key={id} data-testid={id}>
          <InboxIssueTrailingColumns
            issue={{
              ...storybookIssues[0]!,
              assigneeAgentId: human ? null : id,
              assigneeUserId: human ? id : null,
              createdByAgentId: human ? null : id,
              createdByUserId: human ? id : null,
              responsibleUserId: null,
            }}
            columns={["assignee", "kickedOffBy", "project", "updated"]}
            projectName="Paperclip"
            projectColor={null}
            workspaceName={null}
            assigneeName={name}
            assigneeUserName={name}
            creatorAgentName={name}
            creatorUserName={name}
            currentUserId={null}
            parentIdentifier={null}
            parentTitle={null}
          />
        </div>
      ))}
    </div>
  );
}

const meta = {
  id: "task-column-identities",
  title: "Tasks and conversations/Task creation and lifecycle/Column identities",
  component: TaskColumnIdentities,
  parameters: {
    layout: "padded",
    paperclip: {
      capabilities: ["tasks/organize"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Production task columns with long agent and human names, unbroken names, and a fitting-name control. Verifies layout only; assignment and attribution persistence need live acceptance.",
    },
  },
} satisfies Meta<typeof TaskColumnIdentities>;

export default meta;
type Story = StoryObj<typeof meta>;
export const LongNames: Story = {};
