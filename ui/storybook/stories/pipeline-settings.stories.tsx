import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Route, Routes, useNavigate } from "@/lib/router";
import { PipelineSettings } from "@/pages/PipelineSettings";

const COMPANY_ID = "company-storybook";
const PIPELINE_ID = "pipeline-settings-1";

const STAGES = [
  {
    id: "stage-drafting",
    pipelineId: PIPELINE_ID,
    key: "drafting",
    name: "Drafting",
    kind: "working",
    position: 100,
    config: {
      variables: [
        { name: "audience", label: "Audience", type: "text", required: true, options: [], defaultValue: null },
        { name: "deadline", label: "Deadline", type: "text", required: false, options: [], defaultValue: null },
      ],
    },
  },
  {
    id: "stage-review",
    pipelineId: PIPELINE_ID,
    key: "review",
    name: "Final review",
    kind: "review",
    position: 200,
    config: {
      requireApproval: true,
      approveToStageKey: "published",
      rejectToStageKey: "dropped",
      requireRejectReason: true,
    },
  },
  {
    id: "stage-published",
    pipelineId: PIPELINE_ID,
    key: "published",
    name: "Published",
    kind: "done",
    position: 300,
    config: {},
  },
  {
    id: "stage-dropped",
    pipelineId: PIPELINE_ID,
    key: "dropped",
    name: "Dropped",
    kind: "cancelled",
    position: 400,
    config: {},
  },
];

const PIPELINE = {
  id: PIPELINE_ID,
  companyId: COMPANY_ID,
  key: "content",
  name: "Content production",
  description: "Draft, review, and publish launch content.",
  projectId: null,
  enforceTransitions: true,
  archivedAt: null,
  stageCount: STAGES.length,
  openCaseCount: 4,
  createdAt: "2026-06-01T12:00:00.000Z",
  updatedAt: "2026-06-10T12:00:00.000Z",
  stages: STAGES,
  transitions: [
    { fromStageId: "stage-drafting", toStageId: "stage-review", label: null },
    { fromStageId: "stage-drafting", toStageId: "stage-dropped", label: null },
    { fromStageId: "stage-review", toStageId: "stage-published", label: null },
    { fromStageId: "stage-review", toStageId: "stage-dropped", label: null },
  ],
};

function installFixtures() {
  if (typeof window === "undefined") return;
  const winAny = window as typeof window & {
    __pipelineSettingsOriginalFetch?: typeof window.fetch;
    __pipelineSettingsInstalled?: boolean;
  };
  const draftingDocKey = "stage-instructions:stage-drafting";
  const draftingDocBody =
    "Draft a piece for the **{{audience}}** audience.\n\nGround it in the latest launch notes and keep the tone punchy. Ship before {{deadline}}.";
  const draftingDoc = {
    link: { key: draftingDocKey, documentId: "doc-drafting" },
    document: {
      id: "doc-drafting",
      title: "Drafting instructions",
      latestBody: draftingDocBody,
      latestRevisionId: "rev-drafting-3",
      latestRevisionNumber: 3,
    },
    revision: { id: "rev-drafting-3", body: draftingDocBody, title: "Drafting instructions" },
  };
  const draftingRevisions = [
    {
      id: "rev-drafting-3",
      companyId: COMPANY_ID,
      documentId: "doc-drafting",
      pipelineId: PIPELINE_ID,
      key: draftingDocKey,
      revisionNumber: 3,
      title: "Drafting instructions",
      format: "markdown",
      body: draftingDocBody,
      changeSummary: "Tightened the tone guidance",
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: "2026-06-09T16:00:00.000Z",
    },
    {
      id: "rev-drafting-2",
      companyId: COMPANY_ID,
      documentId: "doc-drafting",
      pipelineId: PIPELINE_ID,
      key: draftingDocKey,
      revisionNumber: 2,
      title: "Drafting instructions",
      format: "markdown",
      body: "Draft a piece for the {{audience}} audience.",
      changeSummary: "Added the deadline variable",
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: "2026-06-07T10:30:00.000Z",
    },
    {
      id: "rev-drafting-1",
      companyId: COMPANY_ID,
      documentId: "doc-drafting",
      pipelineId: PIPELINE_ID,
      key: draftingDocKey,
      revisionNumber: 1,
      title: "Drafting instructions",
      format: "markdown",
      body: "Draft the piece.",
      changeSummary: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: "2026-06-05T09:00:00.000Z",
    },
  ];
  const fixtures: Record<string, unknown> = {
    [`/api/pipelines/${PIPELINE_ID}`]: PIPELINE,
    [`/api/companies/${COMPANY_ID}/agents`]: [
      { id: "agent-draft", name: "Drafting agent", role: "writer" },
      { id: "agent-review", name: "Review agent", role: "editor" },
    ],
  };
  const originalFetch = winAny.__pipelineSettingsInstalled
    ? (winAny.__pipelineSettingsOriginalFetch as typeof window.fetch)
    : window.fetch.bind(window);
  winAny.__pipelineSettingsOriginalFetch = originalFetch;
  winAny.__pipelineSettingsInstalled = true;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, window.location.origin);
    if (Object.prototype.hasOwnProperty.call(fixtures, url.pathname)) {
      return Response.json(fixtures[url.pathname]);
    }
    const decoded = decodeURIComponent(url.pathname);
    // Pipeline guidance document — none yet.
    if (url.pathname === `/api/pipelines/${PIPELINE_ID}/documents/guidance`) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    // Drafting stage instructions document + revision history.
    if (decoded === `/api/pipelines/${PIPELINE_ID}/documents/${draftingDocKey}/revisions`) {
      return Response.json(draftingRevisions);
    }
    if (decoded === `/api/pipelines/${PIPELINE_ID}/documents/${draftingDocKey}`) {
      return Response.json(draftingDoc);
    }
    // Any other per-stage instructions document — none yet.
    if (decoded.includes(`/api/pipelines/${PIPELINE_ID}/documents/stage-instructions:`)) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    return originalFetch(input, init);
  };
}

function Wrapper() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    installFixtures();
    navigate(`/pipelines/${PIPELINE_ID}/settings`, { replace: true });
    setReady(true);
  }, [navigate]);
  if (!ready) return null;
  return (
    <div className="px-6 py-6">
      <Routes>
        <Route path="/pipelines/:pipelineId/settings" element={<PipelineSettings />} />
      </Routes>
    </div>
  );
}

const meta: Meta<typeof PipelineSettings> = {
  title: "Pipelines/Settings",
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof PipelineSettings>;

export const StageEditor: Story = {
  name: "Stage settings (allowed next steps, pause, review outcomes)",
  render: () => <Wrapper />,
};
