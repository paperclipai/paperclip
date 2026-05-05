import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Agent } from "@paperclipai/shared";
import { AgentConfigForm } from "@/components/AgentConfigForm";
import { defaultCreateValues } from "@/components/agent-config-defaults";
import type { CreateConfigValues } from "@/components/AgentConfigForm";

const meta: Meta = {
  title: "Adapter/HermesProfile",
};
export default meta;

const now = new Date("2026-04-20T12:00:00.000Z");
const recent = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

const hermesAgent: Agent = {
  id: "agent-hermes",
  companyId: "company-storybook",
  name: "StellaHermes",
  urlKey: "stellahermes",
  role: "engineer",
  title: "Hermes Profile Agent",
  icon: "sparkles",
  status: "idle",
  reportsTo: null,
  capabilities: "Profile-isolated Hermes agent.",
  adapterType: "hermes_profile",
  adapterConfig: { profile: "stella" },
  runtimeConfig: {},
  budgetMonthlyCents: 50_000,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: recent(60),
  metadata: null,
  createdAt: recent(2_000),
  updatedAt: recent(60),
};

function HermesProfileCreate() {
  const [values, setValues] = useState<CreateConfigValues>({
    ...defaultCreateValues,
    adapterType: "hermes_profile",
    command: "stella",
  });

  return (
    <AgentConfigForm
      mode="create"
      values={values}
      onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
      sectionLayout="cards"
      showAdapterTestEnvironmentButton={false}
    />
  );
}

function HermesProfileEdit() {
  return (
    <AgentConfigForm
      mode="edit"
      agent={hermesAgent}
      onSave={() => {}}
      sectionLayout="cards"
      showAdapterTestEnvironmentButton={false}
    />
  );
}

export const Create: StoryObj = {
  render: () => <HermesProfileCreate />,
  name: "Create — Profile name field",
};

export const Edit: StoryObj = {
  render: () => <HermesProfileEdit />,
  name: "Edit — Profile name field",
};
