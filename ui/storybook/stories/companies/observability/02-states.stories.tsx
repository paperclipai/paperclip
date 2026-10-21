import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { AgentObservabilitySettingsView } from "@/components/observability/AgentObservabilitySettings";
import { companyId, configured, receipt, failedReceipt } from "../../../support/observability/fixtures";
const meta = {
  id: "agent-observability-02-states",
  title: "Getting started and access/Companies and portability/Agent observability/02 States",
  component: AgentObservabilitySettingsView,
  decorators: [Story => <main className="p-6"><Story /></main>],
  args: { companyId, settings: configured, onSave: fn(), onTest: fn(), onRemove: fn(), onReload: fn() },
  parameters: { paperclip: { capabilities: ["companies/agent-observability"], implementation: "production", boundary: "fixtures",
    notes: "Production view with saving, testing, accepted/partial/failed receipts, stale revisions, and restricted access. Receipts do not establish real destination delivery." } },
} satisfies Meta<typeof AgentObservabilitySettingsView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Saving: Story = { args: { saving: true } };
export const Testing: Story = { args: { testing: true } };
export const Accepted: Story = { args: { result: receipt } };
export const Rejected: Story = { args: { result: failedReceipt } };
export const Partial: Story = { args: { result: { ...receipt, status: "partial", signals: { logs: receipt.signals.logs, traces: failedReceipt.signals.traces } } } };
export const Conflict: Story = { args: { conflict: true, error: "Another administrator changed these settings. Reload the saved settings to continue." } };
export const Restricted: Story = { args: { settings: null, canManage: false } };
