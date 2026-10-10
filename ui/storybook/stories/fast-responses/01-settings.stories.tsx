import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { FastResponseSettingsView } from "@/components/fast-responses/FastResponseSettings";
import { choices } from "../decision-models/fixtures";
import type {
  FastResponseSettings,
  FastResponseTestResult,
} from "@paperclipai/shared";
export const empty: FastResponseSettings = {
  companyId: "company-storybook",
  enabled: false,
  connectionId: null,
  grantId: null,
  provider: null,
  model: null,
  allowSponsored: true,
};
export const configured: FastResponseSettings = {
  ...empty,
  enabled: true,
  connectionId: choices[1]!.id,
  grantId: choices[1]!.grantId,
  provider: "openrouter",
  model: "openai/gpt-oss-120b",
};
export const result: FastResponseTestResult = {
  status: "succeeded",
  invocationId: "receipt-fixture",
  text: "I’ll check the settings panel’s border styling and work on the fix.",
  durationMs: 842,
  usage: {
    inputTokens: 190,
    outputTokens: 17,
    costCents: "0.001",
    costStatus: "reported",
  },
};
const meta = {
  title: "Fast responses/01 Settings",
  component: FastResponseSettingsView,
  decorators: [
    (Story) => (
      <main className="p-6">
        <Story />
      </main>
    ),
  ],
  args: {
    settings: configured,
    choices,
    models: [{ id: "openai/gpt-oss-120b" }],
    onSave: fn(),
    onTest: fn(),
    onAdd: fn(),
  },
} satisfies Meta<typeof FastResponseSettingsView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = { args: { settings: empty, choices: [] } };
export const Configured: Story = {};
export const Disabled: Story = {
  args: { settings: { ...configured, enabled: false } },
};
export const SponsorshipOff: Story = {
  args: { settings: { ...configured, allowSponsored: false } },
};
export const Revoked: Story = { args: { choices: [] } };
export const Testing: Story = { args: { testing: true } };
export const Result: Story = { args: { result } };
export const Timeout: Story = {
  args: { result: { status: "failed", reason: "timeout" } },
};
export const Mobile: Story = {
  args: { result },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
