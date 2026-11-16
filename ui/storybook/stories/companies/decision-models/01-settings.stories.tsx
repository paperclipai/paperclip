import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { DecisionModelSettingsView } from "@/components/decision-models/DecisionModelSettings";
import { choices, configured, gatewayChoice, models, result, unconfigured } from "../../../support/decision-models/fixtures";

const meta = {
  parameters: { paperclip: {
      "capabilities": [
        "companies/identity",
        "budgets-costs/cost-reporting",
        "companies/decision-models"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Related decision-service examples show connection/model configuration, bounded test receipts or invocation history using shipped subjects and simulated data. No paid provider or authorization proof."
    } }, id: "decision-models-01-settings",
  title: "Getting started and access/Companies and portability/Decision models/01 Settings", component: DecisionModelSettingsView,
  decorators: [Story => <main className="p-6"><Story /></main>],
  args: { settings: configured, choices, models, onSave: fn(), onTest: fn(), onAdd: fn() },
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
export const GatewayModel: Story = { args: { choices: [...choices, gatewayChoice], models: [{ id: "combo/fast", name: "Fast combo" }],
  settings: { ...configured, connectionId: gatewayChoice.id, grantId: gatewayChoice.grantId, provider: "gateway", model: "combo/fast" } } };
export const ModelListUnavailable: Story = { args: { models: [], modelsError: "provider_failed" } };
