import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { AcceptedPlanDecompositionSummary } from "@paperclipai/shared";
import { IssuePlanDecompositionsSection } from "@/components/IssuePlanDecompositionsSection";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAgentMap } from "../fixtures/paperclipData";

const issueId = "issue-plan-decomposition-story";
const issueIdentifier = "PAP-6831";

function buildDecomposition(
  overrides: Partial<AcceptedPlanDecompositionSummary>,
): AcceptedPlanDecompositionSummary {
  return {
    id: "decomposition-story-1",
    companyId: "company-storybook",
    sourceIssueId: issueId,
    acceptedPlanRevisionId: "revision-story-1",
    acceptedInteractionId: "interaction-story-1",
    status: "completed",
    requestFingerprint: "fingerprint-story-1",
    requestedChildCount: 2,
    childIssueIds: ["issue-child-1", "issue-child-2"],
    ownerAgentId: "agent-codex",
    ownerUserId: null,
    ownerRunId: "run-story-1",
    completedAt: "2026-05-28T06:22:00.000Z",
    createdAt: "2026-05-28T06:18:00.000Z",
    updatedAt: "2026-05-28T06:22:00.000Z",
    acceptedPlanRevisionNumber: 7,
    childIssues: [
      {
        id: "issue-child-1",
        identifier: "PAP-6840",
        title: "Harden accepted-plan wake routing",
        status: "done",
        priority: "medium",
        assigneeAgentId: "agent-codex",
        assigneeUserId: null,
      },
      {
        id: "issue-child-2",
        identifier: "PAP-6841",
        title: "Add decomposition regression coverage",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: "agent-qa",
        assigneeUserId: null,
      },
    ],
    ...overrides,
  };
}

function HydratedSection({
  decompositions,
}: {
  decompositions: AcceptedPlanDecompositionSummary[];
}) {
  const queryClient = useQueryClient();
  const [ready] = useState(() => {
    queryClient.setQueryData(queryKeys.issues.acceptedPlanDecompositions(issueId), decompositions);
    return true;
  });

  if (!ready) return null;

  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner">
        <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-background/95 p-6 shadow-sm">
          <IssuePlanDecompositionsSection
            issueId={issueId}
            issueIdentifier={issueIdentifier}
            agentMap={storybookAgentMap}
          />
        </div>
      </main>
    </div>
  );
}

const meta = {
  title: "Issue Detail/Plan Decompositions",
  component: HydratedSection,
  args: {
    decompositions: [],
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof HydratedSection>;

export default meta;

type Story = StoryObj<typeof meta>;

export const InFlight: Story = {
  args: {
    decompositions: [
      buildDecomposition({
        status: "in_flight",
        completedAt: null,
        updatedAt: "2026-05-28T06:20:00.000Z",
        childIssueIds: ["issue-child-1"],
        childIssues: [
          {
            id: "issue-child-1",
            identifier: "PAP-6840",
            title: "Harden accepted-plan wake routing",
            status: "done",
            priority: "medium",
            assigneeAgentId: "agent-codex",
            assigneeUserId: null,
          },
        ],
      }),
    ],
  },
};

export const Completed: Story = {
  args: {
    decompositions: [
      buildDecomposition({}),
    ],
  },
};
