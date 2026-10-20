import { instanceExperimentalSettingsSchema } from "@paperclipai/shared";
import type { CaseSummary, CaseDetail, CaseEvent, CaseHandoffView } from "@/api/cases";
import { prepareFixtureApi, type FixtureState } from "./api";
export const caseItem: CaseSummary = {
  id: "case-gap",
  companyId: "company-storybook",
  projectId: null,
  caseNumber: 42,
  identifier: "PAP-C42",
  caseType: "release",
  key: "release-preview",
  title: "Release readiness",
  summary: "The release review record.",
  status: "in_review",
  fields: {
    version: "0.3.1",
    ready: false,
    checks: { build: "passed", tests: "pending" },
    environments: [{ name: "staging", checks: { build: "passed", tests: "pending" } }],
    task_identifiers: ["PAP-42"],
  },
  parentCaseId: null,
  createdByAgentId: null,
  createdByUserId: null,
  completedAt: null,
  createdAt: "2026-10-12T12:00:00Z",
  updatedAt: "2026-10-12T12:00:00Z",
};
export const childCase: CaseSummary = {
  ...caseItem,
  id: "child-gap",
  caseNumber: 43,
  identifier: "PAP-C43",
  title: "API qualification",
  parentCaseId: caseItem.id,
  status: "in_progress",
};
export const caseDetail: CaseDetail = {
  ...caseItem,
  parent: null,
  labels: [],
  documents: [],
  attachments: [],
  issueLinks: [
    {
      id: "link-gap",
      caseId: caseItem.id,
      issueId: "task-gap",
      role: "work",
      createdAt: caseItem.createdAt,
      issue: {
        id: "task-gap",
        identifier: "PAP-42",
        title: "Qualify the release",
        status: "in_progress",
      },
    },
  ],
};
const event: CaseEvent = {
  id: "event-gap",
  caseId: caseItem.id,
  kind: "status_changed",
  actorType: "agent",
  actorAgentId: "agent-coder",
  actorUserId: null,
  runId: "run-gap",
  payload: { from: "in_progress", to: "in_review" },
  createdAt: caseItem.updatedAt,
  actorAgentName: "Codex Coder",
  issue: caseDetail.issueLinks[0].issue,
};
export function installCaseFixtures(state: FixtureState = "ready", workflow?: "waiting" | "blocked") {
  const handoff: CaseHandoffView = {
    id: "handoff-gap", companyId: caseItem.companyId, caseId: caseItem.id, issueId: "task-gap", version: 2,
    destinationKind: "agent", completedAt: null,
    fromAgentId: "agent-coder", fromAgentName: "Codex Coder", toAgentId: "agent-verifier", toAgentName: "Release Verifier",
    phase: "verification", instructions: "Verify the saved release checklist and report any missing evidence on this task.",
    commentId: null, actorType: "agent", actorId: "agent-coder", sourceRunId: "run-gap", responsibleUserId: "user-storybook",
    expectedIssueStatusVersion: 1, appliedIssueStatusVersion: null, wakeupRequestId: "wake-gap", idempotencyKey: "storybook-handoff",
    inputFingerprint: "fixture", state: "awaiting_release", attemptCount: 1, nextAttemptAt: caseItem.updatedAt,
    leaseExpiresAt: null, lastErrorCode: workflow === "blocked" ? "workspace_settlement" : null,
    lastError: workflow === "blocked" ? "Waiting for the outgoing workspace to finish saving." : null,
    createdAt: caseItem.updatedAt, assignmentAppliedAt: null, deliveredAt: null, cancelledAt: null, updatedAt: caseItem.updatedAt,
  };
  let pending = !!workflow;
  const detail = () => workflow ? { ...caseDetail, workIssueId: "task-gap", phase: "implementation", handoffVersion: 2,
    workIssue: { ...caseDetail.issueLinks[0].issue, statusVersion: 1, assigneeAgentId: "agent-coder", assigneeAgentName: "Codex Coder" },
    pendingHandoff: pending ? handoff : null } : caseDetail;
  return prepareFixtureApi(
    [
      {
        path: "/api/instance/settings/experimental",
        state: "ready",
        read: () => ({
          ...instanceExperimentalSettingsSchema.parse({}),
          enableCases: true,
        }),
      },
      {
        path: "/api/companies/company-storybook/cases",
        read: ({ url }) =>
          state === "empty"
            ? []
            : url.searchParams.has("parent")
              ? [childCase]
              : [caseItem, childCase],
      },
      { path: /^\/api\/cases\/(PAP-C42|case-gap)$/, read: detail },
      { path: "/api/cases/case-gap/handoffs", read: () => ({ items: workflow ? [handoff] : [], nextCursor: null, canControl: true }) },
      { path: "/api/cases/case-gap/handoffs/handoff-gap/retry", method: "POST", read: () => {
        handoff.lastError = null; handoff.lastErrorCode = null; return handoff;
      } },
      { path: "/api/cases/case-gap/handoffs/handoff-gap/cancel", method: "POST", read: () => {
        pending = false; handoff.state = "cancelled"; return handoff;
      } },
      {
        path: /^\/api\/cases\/(PAP-C42|case-gap)\/events$/,
        read: () => (state === "empty" ? [] : [event]),
      },
      {
        path: "/api/issues/task-gap/cases",
        read: () =>
          state === "empty"
            ? []
            : [
                {
                  id: "reverse-link-gap",
                  role: "work",
                  createdAt: caseItem.createdAt,
                  case: caseItem,
                },
              ],
      },
    ],
    state,
  ).cleanup;
}
