import { useEffect, useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import type { AuditActionRecord } from "@/api/audit";
import { AuditHub } from "@/pages/audit/AuditHub";
import { queryKeys } from "@/lib/queryKeys";
import { Route, Routes, useNavigate } from "@/lib/router";
import { storybookAgents } from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";
const leadAgent = storybookAgents[0]!;

const activity: AuditActionRecord[] = [
  {
    id: "activity-review",
    companyId: COMPANY_ID,
    actorType: "agent",
    actorId: leadAgent.id,
    action: "issue.comment_added",
    entityType: "issue",
    entityId: "issue-review",
    agentId: leadAgent.id,
    runId: "run-review-001",
    responsibleUserId: "user-product",
    details: { commentId: "comment-review" },
    createdAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    entity: {
      issue: {
        id: "issue-review",
        identifier: "PAP-1842",
        title: "Simplify the audit information architecture",
      },
      comment: {
        id: "comment-review",
        excerpt: "Grouped run history, spend, and budget controls under one review surface.",
      },
      document: null,
    },
  },
  {
    id: "activity-review-2",
    companyId: COMPANY_ID,
    actorType: "user",
    actorId: "user-product",
    action: "approval.approved",
    entityType: "issue",
    entityId: "issue-approval",
    agentId: null,
    runId: null,
    responsibleUserId: null,
    details: null,
    createdAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
    entity: {
      issue: {
        id: "issue-approval",
        identifier: "PAP-1839",
        title: "Approve navigation foundation",
      },
      comment: null,
      document: null,
    },
  },
];

const runs = [
  {
    id: "run-review-001",
    companyId: COMPANY_ID,
    agentId: leadAgent.id,
    invocationSource: "assignment",
    status: "running",
    startedAt: new Date(Date.now() - 3 * 60 * 1000),
    finishedAt: null,
    resultJson: { summary: "Verifying the new Audit section navigation" },
    error: null,
    createdAt: new Date(Date.now() - 3 * 60 * 1000),
  },
  {
    id: "run-review-previous",
    companyId: COMPANY_ID,
    agentId: storybookAgents[1]?.id ?? leadAgent.id,
    invocationSource: "manual",
    status: "succeeded",
    startedAt: new Date(Date.now() - 40 * 60 * 1000),
    finishedAt: new Date(Date.now() - 34 * 60 * 1000),
    resultJson: { summary: "Collected design-review evidence" },
    error: null,
    createdAt: new Date(Date.now() - 40 * 60 * 1000),
  },
] as unknown as HeartbeatRun[];

function SeededAuditRoutes({ startAt }: { startAt: "activity" | "runs" }) {
  const navigate = useNavigate();
  const client = useMemo(() => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: Infinity,
          gcTime: Infinity,
          retry: false,
          refetchOnMount: false,
        },
      },
    });
    queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), storybookAgents);
    queryClient.setQueryData(queryKeys.access.companyUserDirectory(COMPANY_ID), {
      users: [
        {
          principalId: "user-product",
          status: "active",
          user: { id: "user-product", name: "Product Lead", email: null, image: null },
        },
      ],
    });
    queryClient.setQueryData(
      queryKeys.audit.agentActions(COMPANY_ID, { actorScope: "all" }),
      {
        pages: [{ items: activity, nextCursor: null, accessTier: "full" }],
        pageParams: [null],
      },
    );
    queryClient.setQueryData(queryKeys.audit.runs(COMPANY_ID, null), runs);
    return queryClient;
  }, []);

  useEffect(() => {
    navigate(startAt === "runs" ? "/activity/runs" : "/activity", { replace: true });
  }, [navigate, startAt]);

  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-6xl p-8">
        <Routes>
          <Route path=":companyPrefix/activity" element={<AuditHub section="activity" />} />
          <Route path=":companyPrefix/activity/runs" element={<AuditHub section="runs" />} />
          <Route path=":companyPrefix/activity/costs" element={<AuditHub section="costs" />} />
          <Route path=":companyPrefix/activity/budgets" element={<AuditHub section="budgets" />} />
        </Routes>
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta = {
  title: "Design Review/Audit Hub",
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj;

export const ActivityFeed: Story = {
  name: "Activity — flat feed and explicit modes",
  render: () => <SeededAuditRoutes startAt="activity" />,
};

export const RunHistory: Story = {
  name: "Runs — organization-wide history",
  render: () => <SeededAuditRoutes startAt="runs" />,
};
