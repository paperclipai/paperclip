import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActionCard, ActionCardMobile, BindingsTable } from "@/components/actions/ActionCard";

const binding = {
  application: "Slack",
  manifestVersion: "2.4.1",
  connection: "https://slack.com/api · acme-workspace",
  catalogSha256: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  payloadSha256: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
};

const baseProps = {
  toolName: "slack.post_message",
  risk: "medium" as const,
  isWrite: true,
  binding,
  input: { channel: "#launch", text: "Deploy v2 is live 🎉", unfurl_links: false },
  reason: "This tool can write to your workspace, so a human signs off before the agent posts.",
  policyNumber: 7,
  expiresInLabel: "expires in 23h 51m",
};

const meta: Meta<typeof ActionCard> = {
  title: "Tools & Access/ActionCard",
  component: ActionCard,
};
export default meta;

type Story = StoryObj<typeof ActionCard>;

export const Pending: Story = {
  render: () => (
    <div className="max-w-xl p-6">
      <ActionCard {...baseProps} />
    </div>
  ),
};

export const Stale: Story = {
  render: () => (
    <div className="max-w-xl p-6">
      <ActionCard
        {...baseProps}
        variant="stale"
        binding={{
          ...binding,
          catalogSha256: "sha256:7d793037a0760186574b0282f2f435e7a4b1b2b0b822cd15d6c15b0f00a0e3f1",
          previousCatalogSha256: binding.catalogSha256,
        }}
        expiresInLabel="expires in 18h 02m"
      />
    </div>
  ),
};

export const DesktopSideBySide: Story = {
  render: () => (
    <div className="grid max-w-5xl gap-4 p-6 lg:grid-cols-2">
      <ActionCard {...baseProps} />
      <ActionCard
        {...baseProps}
        variant="stale"
        binding={{
          ...binding,
          catalogSha256: "sha256:7d793037a0760186574b0282f2f435e7a4b1b2b0b822cd15d6c15b0f00a0e3f1",
          previousCatalogSha256: binding.catalogSha256,
        }}
        expiresInLabel="expires in 18h 02m"
      />
    </div>
  ),
};

export const Mobile: Story = {
  render: () => (
    <div className="w-[390px] bg-background p-3">
      <ActionCardMobile {...baseProps} />
    </div>
  ),
};

export const Bindings: Story = {
  render: () => (
    <div className="max-w-md p-6">
      <BindingsTable
        rows={[
          { label: "Application", value: "Slack · manifest v2.4.1" },
          { label: "Connection", value: "https://slack.com/api · acme-workspace", mono: true },
          { label: "Catalog", value: "sha256:9f86d08188…f00a08", mono: true },
          { label: "Payload", value: "sha256:2c26b46b68…66e7ae", mono: true },
        ]}
      />
    </div>
  ),
};
