import type {
  PipelineDetail,
  PipelineCase,
  PipelineReviewCaseRow,
  PipelineCompanyCaseEvent,
} from "@/api/pipelines";
import { prepareFixtureApi, type FixtureState } from "./api";
export const pipeline: PipelineDetail = {
  id: "pipeline-gap",
  companyId: "company-storybook",
  key: "release",
  name: "Release review",
  description: "Check and approve a release.",
  projectId: null,
  enforceTransitions: true,
  archivedAt: null,
  stageCount: 3,
  openCaseCount: 1,
  createdAt: "2026-10-12",
  updatedAt: "2026-10-12",
  stages: [
    {
      id: "stage-work",
      pipelineId: "pipeline-gap",
      key: "work",
      name: "Prepare",
      kind: "working",
      position: 0,
    },
    {
      id: "stage-review",
      pipelineId: "pipeline-gap",
      key: "review",
      name: "Review",
      kind: "review",
      position: 1,
      config: {
        approveToStageKey: "done",
        requestChangesToStageKey: "work",
        requireRequestChangesReason: true,
      },
    },
    {
      id: "stage-done",
      pipelineId: "pipeline-gap",
      key: "done",
      name: "Done",
      kind: "done",
      position: 2,
    },
  ],
  transitions: [
    { fromStageId: "stage-work", toStageId: "stage-review" },
    { fromStageId: "stage-review", toStageId: "stage-done" },
  ],
};
export function installPipelineFixture(
  state: FixtureState = "ready",
  options: { emptyStages?: boolean } = {},
) {
  let item: PipelineCase = {
    id: "case-pipeline-gap",
    companyId: "company-storybook",
    pipelineId: pipeline.id,
    stageId: "stage-review",
    caseKey: "REL-1",
    title: "Ship the release notes",
    version: 1,
    fields: { release: "2026.1013.0" },
    createdAt: "2026-10-12",
    updatedAt: "2026-10-12",
  };
  let review = true;
  const detail = () => ({
    case: item,
    stage: pipeline.stages.find((s) => s.id === item.stageId),
    pipeline,
    allowedNextStages: [pipeline.stages[2]],
    links: [],
    blockers: [],
    blocks: [],
    childrenSummary: {
      childCount: 0,
      terminalChildCount: 0,
      loadedChildren: 0,
    },
  });
  const event: PipelineCompanyCaseEvent = {
    id: "event-gap",
    companyId: "company-storybook",
    caseId: item.id,
    type: "review_decided",
    actorType: "user",
    actorUserId: "user-storybook",
    fromStageId: "stage-review",
    toStageId: "stage-done",
    fromStage: pipeline.stages[1],
    toStage: pipeline.stages[2],
    payload: {
      decision: "approve",
      actorName: "Release reviewer",
      reason: "All release checks passed.",
    },
    createdAt: "2026-10-12T12:00:00Z",
    updatedAt: "2026-10-12T12:00:00Z",
    case: {
      id: item.id,
      caseKey: item.caseKey ?? null,
      title: item.title,
      terminalKind: null,
    },
    pipeline: { id: pipeline.id, key: pipeline.key, name: pipeline.name },
  };
  const reviewRow = (): PipelineReviewCaseRow => ({
    case: item,
    pipeline: { id: pipeline.id, key: pipeline.key, name: pipeline.name },
    stage: pipeline.stages[1],
    reviewConfig: {
      approveToStageKey: "done",
      requestChangesToStageKey: "work",
      requireRequestChangesReason: true,
    },
  });
  return prepareFixtureApi(
    [
      {
        path: "/api/companies/company-storybook/pipelines",
        read: () => (state === "empty" ? [] : [pipeline]),
      },
      {
        path: "/api/pipelines/pipeline-gap",
        read: () =>
          options.emptyStages
            ? { ...pipeline, stages: [], stageCount: 0, transitions: [] }
            : pipeline,
      },
      {
        path: "/api/pipelines/pipeline-gap/cases",
        read: () =>
          state === "empty" ? [] : [{ case: item, stage: detail().stage }],
      },
      {
        path: "/api/pipelines/pipeline-gap/health",
        read: () => ({ warnings: [], pipelineId: pipeline.id }),
      },
      {
        path: "/api/pipelines/pipeline-gap/intake-form",
        read: () => ({
          pipelineId: pipeline.id,
          stageId: "stage-work",
          fields: [],
        }),
      },
      {
        path: "/api/companies/company-storybook/pipelines-attention",
        read: () => ({
          suggestions: [],
          reviews: [],
          headsUp: [],
          counts: { suggestions: 0, reviews: 0, headsUp: 0 },
        }),
      },
      {
        path: "/api/companies/company-storybook/review-cases",
        read: () => (state === "empty" || !review ? [] : [reviewRow()]),
      },
      { path: "/api/cases/case-pipeline-gap", read: detail },
      {
        path: /^\/api\/cases\/case-pipeline-gap\/(children|events|issue-links)$/,
        read: () => [],
      },
      {
        path: "/api/cases/case-pipeline-gap/review",
        method: "POST",
        read: ({ body }) => {
          review = false;
          item = {
            ...item,
            stageId: body.decision === "approve" ? "stage-done" : "stage-work",
            version: 2,
          };
          return detail();
        },
      },
      {
        path: "/api/companies/company-storybook/case-events",
        read: () => ({
          items: state === "empty" ? [] : [event],
          pagination: {
            limit: 50,
            offset: 0,
            nextOffset: null,
            hasMore: false,
            order: "desc",
          },
        }),
      },
    ],
    state,
  );
}
