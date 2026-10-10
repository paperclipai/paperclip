import { useEffect, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  AgentDetail as AgentDetailRecord,
  AgentRuntimeState,
  BudgetOverview,
  HeartbeatRun,
} from "@paperclipai/shared";
import { AgentDetail } from "@/pages/AgentDetail";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAgentMap, storybookAgents, storybookIssues } from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";
const AGENT_ID = "agent-codex";
const AGENT_ROUTE_REF = "codexcoder"; // the agent fixture's urlKey

// The visual spec freezes Date, so relative fixtures stay deterministic.
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const agentDetailFixture: AgentDetailRecord = {
  ...storybookAgentMap.get(AGENT_ID)!,
  chainOfCommand: [
    { id: "agent-cto", name: "CTO", role: "cto", title: "CTO" },
    { id: AGENT_ID, name: "CodexCoder", role: "engineer", title: "Senior Product Engineer" },
  ],
  access: {
    canAssignTasks: true,
    taskAssignSource: "explicit_grant",
    membership: null,
    grants: [],
  },
};

const runtimeStateFixture: AgentRuntimeState = {
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
  adapterType: "codex_local",
  sessionId: "session-storybook",
  sessionDisplayId: "codex-session-7f2a",
  sessionParamsJson: null,
  stateJson: {},
  lastRunId: "run-agent-detail-2",
  lastRunStatus: "succeeded",
  totalInputTokens: 1_284_312,
  totalOutputTokens: 402_118,
  totalCachedInputTokens: 733_401,
  totalCostCents: 12_940,
  lastError: null,
  createdAt: minutesAgo(12_000),
  updatedAt: minutesAgo(3),
};

function heartbeatRun(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "run-agent-detail-1",
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    invocationSource: "timer",
    triggerDetail: null,
    status: "succeeded",
    responsibleUserId: null,
    startedAt: minutesAgo(90),
    finishedAt: minutesAgo(72),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: "session-storybook",
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    lastOutputAt: minutesAgo(72),
    lastOutputSeq: 0,
    lastOutputStream: null,
    lastOutputBytes: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    createdAt: minutesAgo(95),
    updatedAt: minutesAgo(72),
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: minutesAgo(72),
    ...overrides,
  } as HeartbeatRun;
}

const heartbeatRunsFixture: HeartbeatRun[] = [
  heartbeatRun({
    id: "run-agent-detail-3",
    invocationSource: "on_demand",
    status: "running",
    startedAt: minutesAgo(9),
    finishedAt: null,
    exitCode: null,
    livenessState: "advanced",
    lastOutputAt: minutesAgo(1),
    lastUsefulActionAt: minutesAgo(1),
  }),
  heartbeatRun({
    id: "run-agent-detail-2",
    invocationSource: "assignment",
    startedAt: minutesAgo(43),
    finishedAt: minutesAgo(31),
  }),
  heartbeatRun({ id: "run-agent-detail-1" }),
];

const budgetOverviewFixture: BudgetOverview = {
  companyId: COMPANY_ID,
  policies: [],
  activeIncidents: [],
  pausedAgentCount: 0,
  pausedProjectCount: 0,
  pendingApprovalCount: 0,
};

function seedAgentDetailData(queryClient: QueryClient) {
  queryClient.setQueryData(
    [...queryKeys.agents.detail(AGENT_ROUTE_REF), COMPANY_ID],
    agentDetailFixture,
  );
  queryClient.setQueryData(queryKeys.agents.runtimeState(AGENT_ID), runtimeStateFixture);
  queryClient.setQueryData(queryKeys.heartbeats(COMPANY_ID, AGENT_ID), heartbeatRunsFixture);
  queryClient.setQueryData(
    [...queryKeys.issues.list(COMPANY_ID), "participant-agent", AGENT_ID],
    storybookIssues.slice(0, 4),
  );
  queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), storybookAgents);
  queryClient.setQueryData(queryKeys.budgets.overview(COMPANY_ID), budgetOverviewFixture);
  queryClient.setQueryData(queryKeys.resourceMemberships.mine(COMPANY_ID), {
    projectMemberships: {},
    agentMemberships: {},
    starredProjects: [],
    starredAgents: [],
  });
}

/**
 * Mounts the real AgentDetail route page inside the preview's MemoryRouter
 * (fixed at /PAP/storybook): seed the QueryClient, then navigate to the
 * canonical agent URL so useParams resolves the fixture agent.
 */
function AgentDetailScenario() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  // Seed synchronously before the page's queries mount (staleTime: Infinity
  // in the preview QueryClient keeps these fixtures authoritative).
  useState(() => {
    seedAgentDetailData(queryClient);
    return true;
  });

  useEffect(() => {
    if (selectedCompanyId !== COMPANY_ID) setSelectedCompanyId(COMPANY_ID);
  }, [selectedCompanyId, setSelectedCompanyId]);

  const target = `/PAP/agents/${AGENT_ROUTE_REF}`;
  const onAgentRoute = location.pathname.startsWith(target);
  useEffect(() => {
    // One-way hop onto the agent route; the page owns the URL afterwards
    // (it may append a tab segment), so never navigate back.
    if (!onAgentRoute) navigate(target, { replace: true });
  }, [onAgentRoute, navigate, target]);

  if (selectedCompanyId !== COMPANY_ID || !onAgentRoute) return null;

  return (
    <Routes>
      <Route path="/:companyPrefix/agents/:agentId/:tab?" element={<AgentDetail />} />
      <Route path="*" element={null} />
    </Routes>
  );
}

const meta: Meta = {
  title: "Pages/Agent Detail",
  parameters: { layout: "fullscreen", a11y: { test: "off" } },
};
export default meta;
type Story = StoryObj;

export const Dashboard: Story = {
  render: () => <AgentDetailScenario />,
};
