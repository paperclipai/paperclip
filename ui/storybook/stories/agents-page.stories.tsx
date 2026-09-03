import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Agent } from "@paperclipai/shared";
import { Agents, type AgentsView } from "@/pages/Agents";
import type { OrgNode } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAgents } from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";

function toOrgTree(agents: Agent[]): OrgNode[] {
  const byManager = new Map<string | null, Agent[]>();
  const agentIds = new Set(agents.map((agent) => agent.id));
  for (const agent of agents) {
    const managerId = agent.reportsTo && agentIds.has(agent.reportsTo) ? agent.reportsTo : null;
    const reports = byManager.get(managerId) ?? [];
    reports.push(agent);
    byManager.set(managerId, reports);
  }
  const build = (agent: Agent): OrgNode => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    reports: (byManager.get(agent.id) ?? []).map(build),
  });
  return (byManager.get(null) ?? []).map(build);
}

function AgentsPageStory({ initialView }: { initialView: AgentsView }) {
  const queryClient = useQueryClient();
  const [fixtures] = useState(() => storybookAgents.slice(0, 6));
  queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), fixtures);
  queryClient.setQueryData(queryKeys.org(COMPANY_ID), toOrgTree(fixtures));
  queryClient.setQueryData(queryKeys.instance.settings, {
    defaultEnvironmentId: null,
    experimental: {
      enableBuiltInAgents: false,
      enableEnvironments: false,
    },
  });
  queryClient.setQueryData([...queryKeys.liveRuns(COMPANY_ID), "agents-page"], []);
  queryClient.setQueryData(queryKeys.resourceMemberships.mine(COMPANY_ID), {
    projectMemberships: {},
    agentMemberships: {},
    starredProjects: [],
    starredAgents: [],
  });
  queryClient.setQueryData(queryKeys.health, { cloud: null, hiddenSettings: [] });

  return (
    <div className="h-screen bg-background p-6 text-foreground">
      <Agents initialView={initialView} />
    </div>
  );
}

const meta = {
  title: "Pages/Agents",
  component: AgentsPageStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AgentsPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ListView: Story = { args: { initialView: "list" } };
export const OrgChartView: Story = { args: { initialView: "org" } };
