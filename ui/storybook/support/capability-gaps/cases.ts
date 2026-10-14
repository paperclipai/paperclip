import { instanceExperimentalSettingsSchema } from "@paperclipai/shared";
import type { CaseSummary, CaseDetail, CaseEvent } from "@/api/cases";
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
export function installCaseFixtures(state: FixtureState = "ready") {
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
      { path: /^\/api\/cases\/(PAP-C42|case-gap)$/, read: () => caseDetail },
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
