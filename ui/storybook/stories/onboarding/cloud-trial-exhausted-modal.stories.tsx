import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor } from "storybook/test";
import type { CloudTrialInferenceStatus } from "@paperclipai/shared";
import { CloudTrialExhaustedModal } from "@/components/CloudTrialExhaustedModal";
import { prepareFixtureApi } from "../../support/capability-gaps/api";

const COMPANY_ID = "company-storybook";

const singleAgentExhaustedStatus: CloudTrialInferenceStatus = {
  enabled: true,
  provider: "openrouter",
  status: "exhausted",
  reason: "openrouter_http_402",
  limitUsdCents: 100,
  spentUsdCents: 100,
  remainingUsdCents: 0,
  defaultModel: "openrouter/openai/gpt-6-luna",
  canMigrate: true,
  trialAgentIds: ["11111111-1111-4111-8111-111111111111"],
  trialAgents: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Nova",
      role: "ceo",
      title: "Chief of Staff",
    },
  ],
  blockedRun: {
    runId: "22222222-2222-4222-8222-222222222222",
    agentId: "11111111-1111-4111-8111-111111111111",
    issueId: "33333333-3333-4333-8333-333333333333",
    failedAt: "2026-11-24T19:00:00Z",
  },
};

const multiAgentExhaustedStatus: CloudTrialInferenceStatus = {
  ...singleAgentExhaustedStatus,
  trialAgentIds: [
    "11111111-1111-4111-8111-111111111111",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
  ],
  trialAgents: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Nova",
      role: "ceo",
      title: "Chief of Staff",
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Atlas",
      role: "engineer",
      title: "Founding Engineer",
    },
    {
      id: "55555555-5555-4555-8555-555555555555",
      name: "Sage",
      role: "researcher",
      title: "Market Researcher",
    },
  ],
};

function installCloudTrialFixtures(opts?: { migrateFails?: boolean }) {
  return prepareFixtureApi([
    {
      path: `/api/companies/${COMPANY_ID}/ai-connections`,
      read: () => ({
        canManageConnections: true,
        accounts: [],
      }),
    },
    {
      path: `/api/companies/${COMPANY_ID}/agents`,
      read: () =>
        singleAgentExhaustedStatus.trialAgents.map((a) => ({
          id: a.id,
          companyId: COMPANY_ID,
          name: a.name,
          role: a.role,
          title: a.title,
          status: "idle",
          adapterType: "paperclip_runner",
          adapterConfig: { provider: "opencode", model: "openrouter/openai/gpt-6-luna" },
          runtimeConfig: { cloudTrialInference: true },
        })),
    },
    {
      path: `/api/companies/${COMPANY_ID}/environments`,
      read: () => [
        {
          id: "env-managed-1",
          companyId: COMPANY_ID,
          name: "Paperclip Computer",
          driver: "local",
          status: "active",
        },
      ],
    },
    {
      path: `/api/companies/${COMPANY_ID}/environments/capabilities`,
      read: () => ({ drivers: {} }),
    },
    {
      path: "/api/instance/settings",
      read: () => ({
        id: "inst-1",
        defaultEnvironmentId: "env-managed-1",
        general: { executionMode: "any" },
        experimental: { enableCloudTrialInference: true, enableManagedSandboxOnly: false },
      }),
    },
    {
      path: "/api/instance/settings/experimental",
      read: () => ({
        enableCloudTrialInference: true,
        enableManagedSandboxOnly: false,
      }),
    },
    {
      path: "/api/instance/settings/general",
      read: () => ({
        executionMode: "any",
      }),
    },
    {
      path: `/api/companies/${COMPANY_ID}/ai-connections`,
      method: "POST",
      read: () => ({
        connectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        grantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    },
    {
      path: `/api/companies/${COMPANY_ID}/cloud-inference/telemetry`,
      method: "POST",
      read: () => new Response(null, { status: 204 }),
    },
    {
      path: `/api/companies/${COMPANY_ID}/cloud-inference/migrate`,
      method: "POST",
      read: () => {
        if (opts?.migrateFails) {
          return Response.json(
            { error: "Selected AI connection could not be applied to agent Nova." },
            { status: 500 },
          );
        }
        return {
          migratedCount: 1,
          agents: [
            {
              agentId: "11111111-1111-4111-8111-111111111111",
              name: "Nova",
              adapterType: "paperclip_runner",
              runnerProvider: "claude",
              model: "claude-sonnet-4-6",
            },
          ],
          resumedRunIds: ["99999999-9999-4999-8999-999999999999"],
          resumedIssueId: "33333333-3333-4333-8333-333333333333",
        };
      },
    },
  ]);
}

const meta = {
  id: "onboarding-cloud-trial-exhausted",
  title:
    "Getting started and access/Onboarding and first work/Onboarding/Connect model required",
  component: CloudTrialExhaustedModal,
  parameters: {
    layout: "centered",
    paperclip: {
      capabilities: ["onboarding/adapter"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes:
        "Production CloudTrialExhaustedModal mounted against fixture APIs covering required model-provider connection, multi-agent migration, success confirmation, and error retry.",
    },
  },
  beforeEach: () => installCloudTrialFixtures().cleanup,
} satisfies Meta<typeof CloudTrialExhaustedModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ExhaustedSingleAgent: Story = {
  args: {
    open: true,
    companyId: COMPANY_ID,
    status: singleAgentExhaustedStatus,
    required: true,
  },
  play: async () => {
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Connect a model provider to continue" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Nova")).toBeInTheDocument();
    expect(screen.queryByText(/\$1/)).not.toBeInTheDocument();
  },
};

export const ExhaustedMultipleAgents: Story = {
  args: {
    open: true,
    companyId: COMPANY_ID,
    status: multiAgentExhaustedStatus,
    required: true,
  },
  play: async () => {
    await waitFor(() => {
      expect(screen.getByText(/all 3 agents/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Atlas")).toBeInTheDocument();
    expect(screen.getByText("Sage")).toBeInTheDocument();
  },
};

export const MigratingAgents: Story = {
  args: {
    open: true,
    companyId: COMPANY_ID,
    status: singleAgentExhaustedStatus,
    required: true,
    initialPhase: "migrating",
  },
  play: async () => {
    await waitFor(() => {
      expect(screen.getByText(/Updating your agents to your model provider/i)).toBeInTheDocument();
    });
  },
};

export const MigrationSucceeded: Story = {
  args: {
    open: true,
    companyId: COMPANY_ID,
    status: multiAgentExhaustedStatus,
    required: true,
    initialPhase: "done",
    initialResult: {
      migratedCount: 2,
      agents: [
        {
          agentId: "11111111-1111-4111-8111-111111111111",
          name: "Nova",
          adapterType: "paperclip_runner",
          runnerProvider: "claude",
          model: "claude-sonnet-4-6",
        },
        {
          agentId: "44444444-4444-4444-8444-444444444444",
          name: "Atlas",
          adapterType: "paperclip_runner",
          runnerProvider: "claude",
          model: "claude-sonnet-4-6",
        },
      ],
      resumedRunIds: ["99999999-9999-4999-8999-999999999999"],
      resumedIssueId: "33333333-3333-4333-8333-333333333333",
    },
  },
  play: async () => {
    await waitFor(() => {
      expect(screen.getByText(/Model provider connected/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/automatically resumed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue to workspace/i })).toBeEnabled();
  },
};

export const MigrationError: Story = {
  args: {
    open: true,
    companyId: COMPANY_ID,
    status: singleAgentExhaustedStatus,
    required: true,
    initialPhase: "error",
    initialError: "Selected AI connection could not be verified on this environment.",
  },
  play: async () => {
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/Could not finish updating your agents/i);
    });
    const backBtn = screen.getByRole("button", { name: /Choose another provider/i });
    await userEvent.click(backBtn);
    await waitFor(() => {
      expect(screen.getByText("OpenAI")).toBeInTheDocument();
    });
  },
};

export const ViewerNonBlocking: Story = {
  args: {
    open: true,
    companyId: COMPANY_ID,
    status: {
      ...singleAgentExhaustedStatus,
      canMigrate: false,
    },
    required: false,
  },
  play: async () => {
    await waitFor(() => {
      expect(
        screen.getByText(/company administrator needs to connect a model provider/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Dismiss/i })).toBeEnabled();
  },
};
