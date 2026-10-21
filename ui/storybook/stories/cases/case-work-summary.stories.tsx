import type { Meta, StoryObj } from "@storybook/react-vite";
import { CaseWorkSummary } from "@/components/cases/CaseWorkSummary";
import { caseFixtureDetail, caseFixtureHandoffs, installReadOnlyCaseFixtures } from "../../support/cases-read-only-api";
import { readonlyCaseFixtures } from "../../support/cases-read-only-fixtures";

const meta = {
  id: "cases-read-only-work-summary",
  title: "Automation and structured work/Cases/Read-only work summary",
  component: CaseWorkSummary,
  args: { caseData: caseFixtureDetail(readonlyCaseFixtures[0]) },
  beforeEach: () => installReadOnlyCaseFixtures().cleanup,
  decorators: [(Story) => <div className="max-w-sm"><Story /></div>],
  parameters: {
    layout: "padded",
    paperclip: {
      capabilities: ["cases/handoffs", "cases/task-links"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Read-only work context used by the case page: assigned work awaiting a handoff, a paused recipient and a passive case. Uses shared property rows and agent identity. Fixture delivery reasons; no assignment or recovery mutation controls.",
    },
  },
} satisfies Meta<typeof CaseWorkSummary>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Assigned: Story = {};
export const PausedRecipient: Story = { args: { caseData: caseFixtureDetail(readonlyCaseFixtures[4]) } };
export const Passive: Story = { args: { caseData: caseFixtureDetail(readonlyCaseFixtures[2]) } };

const closingCase = caseFixtureDetail(readonlyCaseFixtures[0]);
export const WaitingForCompletion: Story = { args: { caseData: {
  ...closingCase,
  workIssue: closingCase.workIssue ? { ...closingCase.workIssue, status: "in_review" } : null,
  pendingHandoff: { ...caseFixtureHandoffs(readonlyCaseFixtures[0])[0]!,
    destinationKind: "done", toAgentId: null, toAgentName: null, phase: "done", state: "awaiting_completion" },
} } };
export const Completed: Story = { args: { caseData: {
  ...closingCase, status: "done", phase: "done", pendingHandoff: null,
  workIssue: closingCase.workIssue ? { ...closingCase.workIssue, status: "done" } : null,
} } };
