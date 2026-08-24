import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { Agent, IssueDocument, IssueThreadInteraction } from "@paperclipai/shared";
import { PlanDecompositionWizard } from "@/components/PlanDecompositionWizard";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAgents } from "../fixtures/paperclipData";

const issueId = "issue-plan-decomposition-wizard";
const issueIdentifier = "PAP-6831";

function buildPlanDocument(): IssueDocument & { planMetadata: Record<string, unknown> | null } {
  return {
    id: "document-plan-1",
    companyId: "company-storybook",
    issueId,
    key: "plan",
    title: null,
    format: "markdown",
    latestRevisionId: "revision-story-1",
    latestRevisionNumber: 7,
    createdByAgentId: "agent-codex",
    createdByUserId: null,
    updatedByAgentId: "agent-codex",
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-05-28T06:00:00.000Z"),
    updatedAt: new Date("2026-05-28T06:18:00.000Z"),
    body: "# Plan\n\nBuild the decomposition wizard.",
    planMetadata: {
      version: 1,
      status: "approved",
      sections: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          title: "Approach",
          body: "Ship the wizard UI.",
          order: 0,
        },
      ],
      milestones: [
        {
          id: "00000000-0000-0000-0000-000000000011",
          title: "Design the wizard flow",
          description: "Define the step-by-step decomposition experience.",
          status: "pending",
          order: 0,
          acceptanceCriteria: ["Wizard opens from plan detail"],
        },
        {
          id: "00000000-0000-0000-0000-000000000012",
          title: "Map milestones to issues",
          description: "Auto-suggest child issue titles from milestone names.",
          status: "pending",
          order: 1,
          acceptanceCriteria: ["Titles are editable"],
        },
        {
          id: "00000000-0000-0000-0000-000000000013",
          title: "Trigger decomposition",
          description: "Create child issues from the accepted plan.",
          status: "pending",
          order: 2,
          acceptanceCriteria: ["Result view links to created issues"],
        },
      ],
    },
  };
}

function buildAcceptedPlanInteraction(): IssueThreadInteraction {
  return {
    id: "interaction-plan-accepted-1",
    companyId: "company-storybook",
    issueId,
    kind: "request_confirmation",
    status: "accepted",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-codex",
    createdByUserId: null,
    createdAt: new Date("2026-05-28T06:18:00.000Z"),
    resolvedByUserId: "user-storyboard",
    resolvedAt: new Date("2026-05-28T06:19:00.000Z"),
    updatedAt: new Date("2026-05-28T06:19:00.000Z"),
    payload: {
      version: 1,
      prompt: "Approve the plan?",
      acceptLabel: "Approve plan",
      rejectLabel: "Request changes",
      target: {
        type: "issue_document",
        issueId,
        documentId: "document-plan-1",
        key: "plan",
        revisionId: "revision-story-1",
        revisionNumber: 7,
      },
    },
  };
}

function HydratedWizard({ agents }: { agents: Agent[] }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);

  useState(() => {
    queryClient.setQueryData(queryKeys.issues.document(issueId, "plan"), buildPlanDocument());
    queryClient.setQueryData(queryKeys.issues.interactions(issueId), [buildAcceptedPlanInteraction()]);
    return true;
  });

  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner">
        <PlanDecompositionWizard
          issueId={issueId}
          issueIdentifier={issueIdentifier}
          agents={agents}
          open={open}
          onOpenChange={setOpen}
        />
      </main>
    </div>
  );
}

const meta = {
  title: "Issue Detail/Plan Decomposition Wizard",
  component: HydratedWizard,
  args: {
    agents: storybookAgents,
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof HydratedWizard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const MilestoneSelection: Story = {};

export const NoMilestones: Story = {
  args: {
    agents: storybookAgents,
  },
  render: (args) => {
    const queryClient = useQueryClient();
    const [open] = useState(true);
    const doc = buildPlanDocument();
    doc.planMetadata = {
      version: 1,
      status: "approved",
      sections: [],
      milestones: [],
    };
    useState(() => {
      queryClient.setQueryData(queryKeys.issues.document(issueId, "plan"), doc);
      queryClient.setQueryData(queryKeys.issues.interactions(issueId), [buildAcceptedPlanInteraction()]);
      return true;
    });
    return (
      <div className="paperclip-story">
        <main className="paperclip-story__inner">
          <PlanDecompositionWizard
            issueId={issueId}
            issueIdentifier={issueIdentifier}
            agents={args.agents}
            open={open}
            onOpenChange={() => {}}
          />
        </main>
      </div>
    );
  },
};
