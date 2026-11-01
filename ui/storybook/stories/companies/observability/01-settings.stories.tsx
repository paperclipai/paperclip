import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AgentObservabilitySettingsView } from "@/components/observability/AgentObservabilitySettings";
import { companyId, configured, custom } from "../../../support/observability/fixtures";

const meta = {
  id: "agent-observability-01-settings",
  title: "Getting started and access/Companies and portability/Agent observability/01 Settings",
  component: AgentObservabilitySettingsView,
  decorators: [Story => <main className="p-6"><Story /></main>],
  args: { companyId, settings: configured, onSave: fn(), onTest: fn(), onRemove: fn() },
  parameters: { paperclip: { capabilities: ["companies/agent-observability"], implementation: "production", boundary: "fixtures",
    notes: "Production settings view: initial setup, destinations, stored credentials, content controls, and narrow layout. Provider and authorization behavior are simulated." } },
} satisfies Meta<typeof AgentObservabilitySettingsView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = { args: { settings: null } };
export const Braintrust: Story = {};
export const CustomAuthenticated: Story = { args: { settings: custom } };
export const CustomAnonymous: Story = { args: { settings: { ...custom, credentialsConfigured: false, headerNames: [] } } };
export const Disabled: Story = { args: { settings: { ...configured, enabled: false } } };
export const ReplaceCredential: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement); await userEvent.click(canvas.getByRole("button", { name: "Replace API key" }));
  await userEvent.type(canvas.getByLabelText("API key"), "fake-storybook-key");
  await expect(canvas.getByRole("button", { name: "Save changes" })).toBeEnabled();
} };
export const EditHeaders: Story = { args: { settings: custom }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement); await userEvent.click(canvas.getByRole("button", { name: "Remove x-team" }));
  await userEvent.click(canvas.getByRole("button", { name: "Add header" }));
  await userEvent.type(canvas.getAllByLabelText("Header name")[1]!, "x-project");
} };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } } };
