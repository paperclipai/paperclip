import { useEffect, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PipelineItemDetailView } from "@/pages/Pipelines";

const COMPANY_ID = "company-storybook";
const PIPELINE_ID = "pipeline-1";
const CASE_ID = "item-1";
const CONVERSATION_ISSUE_ID = "issue-conv-1";

interface FixtureOptions {
  withConversation: boolean;
  withChildren: boolean;
  pendingSuggestion: boolean;
  changedNotice: boolean;
}

const STAGES = [
  { id: "stage-intake", pipelineId: PIPELINE_ID, key: "intake", name: "Intake", kind: "open", position: 100 },
  {
    id: "stage-review",
    pipelineId: PIPELINE_ID,
    key: "review",
    name: "Review",
    kind: "review",
    position: 200,
    config: { requireChildrenTerminal: true, autoAdvanceOnChildrenTerminal: "done" },
  },
  { id: "stage-done", pipelineId: PIPELINE_ID, key: "done", name: "Done", kind: "done", position: 800 },
  { id: "stage-cancelled", pipelineId: PIPELINE_ID, key: "cancelled", name: "Removed", kind: "cancelled", position: 1000 },
];

const PIPELINE = {
  id: PIPELINE_ID,
  companyId: COMPANY_ID,
  key: "content",
  name: "Content",
  description: "Tutorial pipeline for QA",
  projectId: null,
  enforceTransitions: false,
  archivedAt: null,
  stageCount: STAGES.length,
  openCaseCount: 1,
  createdAt: "2026-06-10T12:00:00.000Z",
  updatedAt: "2026-06-10T12:00:00.000Z",
  stages: STAGES,
  transitions: [],
};

const CONVERSATION_ISSUE = {
  id: CONVERSATION_ISSUE_ID,
  companyId: COMPANY_ID,
  projectId: null,
  identifier: "PAP-9999",
  title: "Refine the launch announcement copy",
  description: "",
  status: "in_progress",
  createdAt: "2026-06-10T12:00:00.000Z",
  updatedAt: "2026-06-10T12:30:00.000Z",
};

const LINKED_ISSUE_LINK = [
  {
    link: {
      id: "link-1",
      companyId: COMPANY_ID,
      caseId: CASE_ID,
      issueId: CONVERSATION_ISSUE_ID,
      role: "conversation",
      createdAt: "2026-06-10T12:00:00.000Z",
      updatedAt: "2026-06-10T12:00:00.000Z",
    },
    issue: CONVERSATION_ISSUE,
  },
];

const CHILD_ROWS = [
  {
    case: {
      id: "child-1",
      companyId: COMPANY_ID,
      pipelineId: PIPELINE_ID,
      stageId: "stage-review",
      title: "Outline draft",
      fields: { audience: "Operators" },
      childCount: 2,
      terminalKind: null,
    },
    stage: STAGES[1],
  },
  {
    case: {
      id: "child-2",
      companyId: COMPANY_ID,
      pipelineId: PIPELINE_ID,
      stageId: "stage-done",
      title: "Headline benchmarks",
      fields: {},
      childCount: 0,
      terminalKind: "done",
    },
    stage: STAGES[2],
  },
  {
    case: {
      id: "child-3",
      companyId: COMPANY_ID,
      pipelineId: PIPELINE_ID,
      stageId: "stage-cancelled",
      title: "Audience notes",
      fields: {},
      childCount: 0,
      terminalKind: "cancelled",
    },
    stage: STAGES[3],
  },
];

const EVENTS = [
  {
    id: "ev-1",
    companyId: COMPANY_ID,
    caseId: CASE_ID,
    type: "case.ingested",
    actorType: "system",
    payload: {},
    createdAt: "2026-06-10T08:00:00.000Z",
    updatedAt: "2026-06-10T08:00:00.000Z",
  },
  {
    id: "ev-2",
    companyId: COMPANY_ID,
    caseId: CASE_ID,
    type: "case.transitioned",
    actorType: "agent",
    actorAgent: { id: "agent-copy", name: "Dotta" },
    payload: { reason: "Start content intake for v0.42", transitionClass: "manual" },
    fromStageId: "stage-intake",
    toStageId: "stage-review",
    createdAt: "2026-06-10T09:00:00.000Z",
    updatedAt: "2026-06-10T09:00:00.000Z",
  },
  {
    id: "ev-automation",
    companyId: COMPANY_ID,
    caseId: CASE_ID,
    type: "automation_executed",
    actorType: "system",
    payload: { routineId: "routine-1", routineRunId: "routine-run-1", issueId: "issue-auto-1" },
    automation: {
      routine: { id: "routine-1", title: "Draft announcement" },
      issue: {
        id: "issue-auto-1",
        identifier: "PAP-1001",
        title: "Draft the launch announcement",
        status: "todo",
      },
      routineRunId: "routine-run-1",
      stage: { id: "stage-review", key: "review", name: "Review", kind: "review" },
    },
    createdAt: "2026-06-10T10:20:00.000Z",
    updatedAt: "2026-06-10T10:20:00.000Z",
  },
  {
    id: "ev-3",
    companyId: COMPANY_ID,
    caseId: CASE_ID,
    type: "case.suggested",
    actorType: "agent",
    payload: { suggestion: { toStageKey: "done" } },
    createdAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T10:00:00.000Z",
  },
  {
    id: "ev-4",
    companyId: COMPANY_ID,
    caseId: CASE_ID,
    type: "case.conversation_opened",
    actorType: "agent",
    payload: {},
    createdAt: "2026-06-10T10:30:00.000Z",
    updatedAt: "2026-06-10T10:30:00.000Z",
  },
];

const CONVERSATION_COMMENTS = [
  {
    id: "comment-1",
    companyId: COMPANY_ID,
    issueId: CONVERSATION_ISSUE_ID,
    authorAgentId: null,
    authorUserId: "user-board",
    body: "Looks great — can we tighten the headline?",
    authorType: "user",
    presentation: null,
    metadata: null,
    createdAt: "2026-06-10T11:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
  },
  {
    id: "comment-2",
    companyId: COMPANY_ID,
    issueId: CONVERSATION_ISSUE_ID,
    authorAgentId: "agent-script",
    authorUserId: null,
    body: "Pushed a shorter version with a stronger hook.",
    authorType: "agent",
    presentation: null,
    metadata: null,
    createdAt: "2026-06-10T11:30:00.000Z",
    updatedAt: "2026-06-10T11:30:00.000Z",
  },
];

function buildCaseDetail(options: FixtureOptions) {
  const fields: Record<string, unknown> = {
    audience: ["Operators", "Founders"],
    owner: { label: "Launch team" },
    notes: "Keep it plain and direct.",
    nextSuggestedStageId: options.pendingSuggestion ? "done" : undefined,
  };
  if (!options.pendingSuggestion) {
    delete fields.nextSuggestedStageId;
  }
  if (options.changedNotice) {
    fields.upstreamDrift = true;
  }
  return {
    case: {
      id: CASE_ID,
      companyId: COMPANY_ID,
      pipelineId: PIPELINE_ID,
      stageId: "stage-review",
      title: "Draft launch announcement",
      summary: "Prepare a plain-language announcement for the launch.",
      fields,
      version: 4,
      terminalKind: null,
      childCount: options.withChildren ? CHILD_ROWS.length : 0,
      terminalChildCount: options.withChildren ? 2 : 0,
      pendingSuggestion: options.pendingSuggestion
        ? {
            id: "suggestion-1",
            toStageKey: "done",
            rationale: "Approval criteria look met. Move forward?",
            createdAt: "2026-06-10T10:00:00.000Z",
          }
        : null,
    },
    stage: STAGES[1],
    pipeline: PIPELINE,
    allowedNextStages: STAGES,
    links: [],
    blockers: [],
    blocks: [],
    childrenSummary: {
      childCount: options.withChildren ? CHILD_ROWS.length : 0,
      terminalChildCount: options.withChildren ? 2 : 0,
      loadedChildren: options.withChildren ? CHILD_ROWS.length : 0,
    },
    pendingSuggestion: null,
  };
}

function installFixtures(options: FixtureOptions) {
  if (typeof window === "undefined") return;
  const winAny = window as typeof window & {
    __pipelineItemFetchInstalled?: boolean;
    __pipelineItemOriginalFetch?: typeof window.fetch;
  };
  const fixtures: Record<string, unknown> = {
    [`/api/pipelines/${PIPELINE_ID}`]: PIPELINE,
    [`/api/cases/${CASE_ID}`]: buildCaseDetail(options),
    [`/api/pipelines/${PIPELINE_ID}/cases?parentCaseId=${CASE_ID}`]: options.withChildren ? CHILD_ROWS : [],
    [`/api/cases/${CASE_ID}/events?limit=100&order=asc`]: {
      items: EVENTS,
      pagination: { limit: 100, offset: 0, nextOffset: null, hasMore: false, order: "asc" },
    },
    [`/api/issues/${CONVERSATION_ISSUE_ID}/comments?limit=50&order=asc`]: CONVERSATION_COMMENTS,
    [`/api/cases/${CASE_ID}/issue-links`]: options.withConversation ? LINKED_ISSUE_LINK : [],
    [`/api/issues/${CONVERSATION_ISSUE_ID}/comments?order=asc&limit=50`]: CONVERSATION_COMMENTS,
  };
  const originalFetch = winAny.__pipelineItemFetchInstalled
    ? (winAny.__pipelineItemOriginalFetch as typeof window.fetch)
    : window.fetch.bind(window);
  winAny.__pipelineItemOriginalFetch = originalFetch;
  winAny.__pipelineItemFetchInstalled = true;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, window.location.origin);
    const pathWithQuery = `${url.pathname}${url.search}`;
    if (Object.prototype.hasOwnProperty.call(fixtures, pathWithQuery)) {
      return Response.json(fixtures[pathWithQuery]);
    }
    if (Object.prototype.hasOwnProperty.call(fixtures, url.pathname)) {
      return Response.json(fixtures[url.pathname]);
    }
    return originalFetch(input, init);
  };
}

function Wrapper({ options }: { options: FixtureOptions }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    installFixtures(options);
    setReady(true);
  }, [options]);
  if (!ready) return null;
  return <PipelineItemDetailView pipelineId={PIPELINE_ID} caseId={CASE_ID} />;
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="paperclip-story__frame">
      <div className="border-b border-border bg-muted/30 px-5 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">QA fixture</p>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
      </div>
      <div className="bg-background">{children}</div>
    </div>
  );
}

const meta: Meta = {
  title: "Pipelines/Item detail (QA)",
  parameters: {
    layout: "fullscreen",
  },
};
export default meta;

type Story = StoryObj;

export const FullPage: Story = {
  name: "P4 — pending suggestion, conversation, children",
  render: () => (
    <Frame title="Tutorial item with pending suggestion, linked conversation, children">
      <Wrapper
        options={{
          withConversation: true,
          withChildren: true,
          pendingSuggestion: true,
          changedNotice: false,
        }}
      />
    </Frame>
  ),
};

export const NoConversationNoChildren: Story = {
  name: "P4 empty — no conversation, no children",
  render: () => (
    <Frame title="Tutorial item without conversation or children">
      <Wrapper
        options={{
          withConversation: false,
          withChildren: false,
          pendingSuggestion: false,
          changedNotice: false,
        }}
      />
    </Frame>
  ),
};

export const ChangedBanner: Story = {
  name: "P8 — This changed banner",
  render: () => (
    <Frame title="Item with upstream drift (This changed banner)">
      <Wrapper
        options={{
          withConversation: true,
          withChildren: true,
          pendingSuggestion: false,
          changedNotice: true,
        }}
      />
    </Frame>
  ),
};

export const ActivityTimeline: Story = {
  name: "Activity — event-to-sentence timeline",
  render: () => (
    <Frame title="Activity timeline showing translated event sentences">
      <Wrapper
        options={{
          withConversation: true,
          withChildren: false,
          pendingSuggestion: false,
          changedNotice: false,
        }}
      />
    </Frame>
  ),
};
