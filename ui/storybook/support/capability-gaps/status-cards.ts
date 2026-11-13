import type { StatusCard } from "@paperclipai/shared";
import type { StatusCardView } from "@/pages/StatusCards/types";
export function makeStatusCard(
  overrides: Partial<StatusCardView> = {},
): StatusCardView {
  const card: StatusCard = {
    id: "card-gap",
    companyId: "company-storybook",
    createdByUserId: null,
    createdByAgentId: null,
    title: "Release readiness",
    titlePinned: false,
    interestPrompt: "issues that help ship the new install subcommand",
    queries: [],
    queryVersion: 1,
    queryCompiledAt: "2026-07-22T10:00:00.000Z",
    queryCompiledByAgentId: null,
    agentId: null,
    refreshPolicy: {
      mode: "interval",
      intervalMinutes: 15,
      triggers: {
        statusTransitions: true,
        membershipChanges: true,
        humanComments: true,
        assigneeChanges: true,
        anyUpdate: false,
      },
    },
    state: "active",
    pendingChangeCount: 0,
    lastChangeAt: null,
    fingerprint: null,
    fingerprintAt: null,
    mentionedIssueIds: [],
    documentId: null,
    lastUpdateRunKind: "full",
    lastGeneratedAt: "2026-07-22T11:00:00.000Z",
    lastModel: "claude-haiku",
    generatingIssueId: null,
    failureReason: null,
    nextEvalAt: null,
    archivedAt: null,
    archivedByUserId: null,
    archivedByAgentId: null,
    createdAt: "2026-07-22T09:00:00.000Z",
    updatedAt: "2026-07-22T11:00:00.000Z",
  };
  return {
    ...card,
    summaryBody: "All on track. Next: review the deep-link fix, then merge.",
    ...overrides,
  };
}
