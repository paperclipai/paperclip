import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Route, Routes, useNavigate } from "react-router-dom";
import { queryKeys } from "@/lib/queryKeys";
import { PipelineSettings } from "@/pages/PipelineSettings";
import { Pipelines, PipelineItemDetail } from "@/pages/Pipelines";
import type {
  PipelineCaseDetail,
  PipelineDetail,
  PipelineHealthReport,
  PipelineIntakeForm,
  PipelineListItem,
  PipelineStage,
} from "@/api/pipelines";
import { storybookAgents } from "../fixtures/paperclipData";

/**
 * Visual coverage for the PAP-11059 "Break into pieces" breakdown UI. Each
 * story seeds the React Query cache (the storybook QueryClient uses
 * staleTime: Infinity + retry: false, so seeded data is never refetched) and
 * renders the real route page so screenshots reflect production markup.
 */

const companyId = "company-storybook";
const SOURCE = "pipeline-releases";
const TARGET = "pipeline-features";

const sourceStages: PipelineStage[] = [
  { id: "src-planning", pipelineId: SOURCE, key: "planning", name: "Planning", kind: "working", position: 100, config: { variables: [] } },
  {
    id: "src-coverage",
    pipelineId: SOURCE,
    key: "coverage",
    name: "Release Coverage",
    kind: "working",
    position: 200,
    config: {
      variables: [],
      automation: {
        assigneeAgentId: "agent-codex",
        instructionsBody: "Decide which parts of this release deserve their own coverage write-up. List one per piece.",
      },
      // Server derives the children gate from breakdown.waitForPieces; the
      // persisted stage keeps the breakdown block as the source of truth.
      breakdown: {
        targetPipelineId: TARGET,
        targetStageKey: "intake",
        pieceNoun: "feature",
        inheritFields: ["release"],
        advanceTo: "review",
        waitForPieces: true,
        whenFinishedMoveTo: "ship",
      },
    },
  },
  { id: "src-review", pipelineId: SOURCE, key: "review", name: "Review", kind: "review", position: 300, config: { variables: [], requireApproval: true, approver: { kind: "any_human" } } },
  { id: "src-ship", pipelineId: SOURCE, key: "ship", name: "Shipped", kind: "done", position: 400, config: { variables: [] } },
];

const targetStages: PipelineStage[] = [
  { id: "tg-intake", pipelineId: TARGET, key: "intake", name: "Intake", kind: "working", position: 100, config: { variables: [] } },
  { id: "tg-build", pipelineId: TARGET, key: "build", name: "Drafting", kind: "working", position: 200, config: { variables: [] } },
  { id: "tg-done", pipelineId: TARGET, key: "done", name: "Done", kind: "done", position: 300, config: { variables: [] } },
];

const baseList = (id: string, name: string, stages: PipelineStage[]): PipelineListItem => ({
  id,
  companyId,
  key: id,
  name,
  description: null,
  projectId: null,
  enforceTransitions: true,
  archivedAt: null,
  stageCount: stages.length,
  stages,
  openCaseCount: 3,
  connections: null,
  createdAt: new Date("2026-06-01T00:00:00Z"),
  updatedAt: new Date("2026-06-10T00:00:00Z"),
});

const sourceDetail: PipelineDetail = {
  ...baseList(SOURCE, "Releases", sourceStages),
  stages: sourceStages,
  transitions: [
    { fromStageId: "src-planning", toStageId: "src-coverage" },
    { fromStageId: "src-coverage", toStageId: "src-review" },
    { fromStageId: "src-review", toStageId: "src-ship" },
  ],
};

const targetDetail: PipelineDetail = {
  ...baseList(TARGET, "Features", targetStages),
  stages: targetStages,
  transitions: [
    { fromStageId: "tg-intake", toStageId: "tg-build" },
    { fromStageId: "tg-build", toStageId: "tg-done" },
  ],
};

const pipelineList: PipelineListItem[] = [
  baseList(SOURCE, "Releases", sourceStages),
  baseList(TARGET, "Features", targetStages),
];

const targetIntake: PipelineIntakeForm = {
  pipelineId: TARGET,
  stageId: "tg-intake",
  fields: [
    { key: "release", label: "Release", type: "text", required: false },
    { key: "owner", label: "Owner", type: "text", required: true },
  ],
} as PipelineIntakeForm;

const sourceHealth: PipelineHealthReport = {
  pipelineId: SOURCE,
  ok: false,
  warnings: [
    {
      code: "breakdown_field_mismatch",
      stageId: "src-coverage",
      stageKey: "coverage",
      stageName: "Release Coverage",
      message: "One or more carried-over fields don't exist on Features. The chosen fields won't be stamped onto new features.",
    },
  ],
};

function makeChild(id: string, title: string, stageKey: string, kind: string, terminal: string | null) {
  return {
    case: {
      id,
      companyId,
      pipelineId: TARGET,
      stageId: `tg-${stageKey}`,
      caseKey: id,
      title,
      terminalKind: terminal,
      version: 1,
    },
    stage: targetStages.find((s) => s.key === stageKey)!,
    activeWork: null,
  };
}

const coverageCaseDetail: PipelineCaseDetail = {
  case: {
    id: "case-q3",
    companyId,
    pipelineId: SOURCE,
    stageId: "src-coverage",
    caseKey: "REL-204",
    title: "Q3 platform release",
    summary: "Coverage pass for the Q3 release train.",
    version: 3,
    childCount: 5,
    terminalChildCount: 3,
  },
  stage: sourceStages[1]!,
  pipeline: sourceDetail,
  allowedNextStages: [sourceStages[2]!],
  links: [],
  blockers: [],
  blocks: [],
  childrenSummary: { childCount: 5, terminalChildCount: 3, loadedChildren: 5 },
  parentCase: null,
};

const coverageChildren = [
  makeChild("case-auth", "Auth rate-limit coverage", "done", "done", "done"),
  makeChild("case-billing", "Billing webhook coverage", "done", "done", "done"),
  makeChild("case-search", "Search reindex coverage", "done", "done", "done"),
  makeChild("case-mobile", "Mobile deep-link coverage", "build", "working", null),
  makeChild("case-export", "CSV export coverage", "intake", "working", null),
];

function Seeder({ seed, children }: { seed: (qc: ReturnType<typeof useQueryClient>) => void; children: ReactNode }) {
  const qc = useQueryClient();
  const seeded = useRef(false);
  if (!seeded.current) {
    qc.setQueryData(queryKeys.agents.list(companyId), storybookAgents);
    seed(qc);
    seeded.current = true;
  }
  return <>{children}</>;
}

// The storybook decorator already provides a single MemoryRouter; nesting
// another throws. Instead we navigate the existing router to the target URL
// once on mount, then match it with a local <Routes>.
function RouteHarness({ entry, path, element }: { entry: string; path: string; element: ReactNode }) {
  const navigate = useNavigate();
  const navigated = useRef(false);
  if (!navigated.current) {
    navigated.current = true;
  }
  useEffect(() => {
    navigate(entry, { replace: true });
  }, [entry, navigate]);
  return (
    <Routes>
      <Route path={path} element={element} />
    </Routes>
  );
}

const meta: Meta = {
  title: "Pipelines/Breakdown primitive",
  parameters: { layout: "fullscreen", a11y: { test: "off" } },
};
export default meta;

type Story = StoryObj;

/** Settings → Advanced: the "Break into smaller pieces" card + generated summary. */
export const SettingsBreakIntoPiecesCard: Story = {
  render: () => (
    <Seeder
      seed={(qc) => {
        qc.setQueryData(queryKeys.pipelines.detail(SOURCE), sourceDetail);
        qc.setQueryData(queryKeys.pipelines.health(SOURCE), sourceHealth);
        qc.setQueryData(queryKeys.pipelines.list(companyId), pipelineList);
        qc.setQueryData(queryKeys.pipelines.intakeForm(TARGET), targetIntake);
        qc.setQueryData(queryKeys.pipelines.document(SOURCE, "stage-instructions:src-coverage"), null);
      }}
    >
      <div className="min-h-screen bg-background p-6">
        <RouteHarness
          entry={`/PAP/pipelines/${SOURCE}/settings?stage=src-coverage`}
          path="/:companyPrefix/pipelines/:pipelineId/settings"
          element={<PipelineSettings />}
        />
      </div>
    </Seeder>
  ),
};

/** Board: outbound "Breaks into Features" chip + inbound "Fed by Releases" chip. */
export const BoardConnectorChips: Story = {
  render: () => (
    <Seeder
      seed={(qc) => {
        qc.setQueryData(queryKeys.pipelines.detail(SOURCE), sourceDetail);
        qc.setQueryData(queryKeys.pipelines.health(SOURCE), sourceHealth);
        qc.setQueryData(queryKeys.pipelines.list(companyId), pipelineList);
        qc.setQueryData(queryKeys.pipelines.cases(SOURCE), [
          { case: coverageCaseDetail.case, activeWork: null },
        ]);
      }}
    >
      <div className="min-h-screen bg-background">
        <RouteHarness
          entry={`/PAP/pipelines/${SOURCE}`}
          path="/:companyPrefix/pipelines/:pipelineId"
          element={<Pipelines />}
        />
      </div>
    </Seeder>
  ),
};

/** Board for the target pipeline: "Fed by Releases" chip on the title bar. */
export const BoardFedByChip: Story = {
  render: () => (
    <Seeder
      seed={(qc) => {
        qc.setQueryData(queryKeys.pipelines.detail(TARGET), targetDetail);
        qc.setQueryData(queryKeys.pipelines.health(TARGET), { pipelineId: TARGET, ok: true, warnings: [] });
        qc.setQueryData(queryKeys.pipelines.list(companyId), pipelineList);
        qc.setQueryData(queryKeys.pipelines.cases(TARGET), coverageChildren.map((c) => ({ case: c.case, activeWork: null })));
      }}
    >
      <div className="min-h-screen bg-background">
        <RouteHarness
          entry={`/PAP/pipelines/${TARGET}`}
          path="/:companyPrefix/pipelines/:pipelineId"
          element={<Pipelines />}
        />
      </div>
    </Seeder>
  ),
};

/** Case detail: piece-noun rollup banner + "Built from 5 features" section. */
export const CaseDetailPiecesRollup: Story = {
  render: () => (
    <Seeder
      seed={(qc) => {
        qc.setQueryData(queryKeys.pipelines.detail(SOURCE), sourceDetail);
        qc.setQueryData(queryKeys.pipelines.caseDetail("case-q3"), coverageCaseDetail);
        qc.setQueryData(queryKeys.pipelines.caseChildren("case-q3"), coverageChildren);
        qc.setQueryData(queryKeys.pipelines.caseEvents("case-q3"), { items: [] });
        qc.setQueryData(queryKeys.pipelines.caseIssueLinks("case-q3"), []);
      }}
    >
      <div className="min-h-screen bg-background">
        <RouteHarness
          entry={`/PAP/pipelines/${SOURCE}/items/case-q3`}
          path="/:companyPrefix/pipelines/:pipelineId/items/:caseId"
          element={<PipelineItemDetail />}
        />
      </div>
    </Seeder>
  ),
};
