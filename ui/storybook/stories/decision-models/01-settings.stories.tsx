import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { DecisionModelSettingsView } from "@/components/decision-models/DecisionModelSettings";
import { choices, configured, result, unconfigured } from "./fixtures";

const meta = { title: "Decision models/01 Settings", component: DecisionModelSettingsView,
  decorators: [Story => <main className="p-6"><Story /></main>],
  args: { settings: configured, choices, onSave: fn(), onTest: fn(), onAdd: fn() },
} satisfies Meta<typeof DecisionModelSettingsView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = { args: { settings: unconfigured, choices: [] } };
export const SelectExisting: Story = { args: { settings: unconfigured } };
export const Configured: Story = {};
export const SponsorshipOff: Story = { args: { settings: { ...configured, allowBackground: false } } };
export const Disabled: Story = { args: { settings: { ...configured, enabled: false } } };
export const Reconnect: Story = { args: { choices: [{ ...choices[0]!, status: "needs_attention" }] } };
export const Revoked: Story = { args: { choices: [] } };
export const Testing: Story = { args: { testing: true } };
export const Results: Story = { args: { result } };
export const Failure: Story = { args: { result: { status: "failed", invocationId: "decision-failure", errorCode: "provider_auth_failed", usage: { inputTokens: 0, outputTokens: 0, costCents: "0", costStatus: "estimated" } } } };
export const Mobile: Story = { args: { result }, globals: { viewport: { value: "mobile1", isRotated: false } } };
