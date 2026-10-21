import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { PromptInjectionPreventionSettingsView } from "@/components/prompt-injection-prevention/PromptInjectionPreventionSettings";
import { PROMPT_INJECTION_DEFAULT_MODEL } from "@paperclipai/shared";
import { choices as allChoices } from "../../../support/decision-models/fixtures";
const choices = allChoices.filter(c => c.provider === "openrouter");
const empty = { companyId: "company-storybook", enabled: false, connectionId: null, grantId: null, model: PROMPT_INJECTION_DEFAULT_MODEL };
const configured = { ...empty, enabled: true, connectionId: choices[0]!.id, grantId: choices[0]!.grantId };
const meta = {
  parameters: { paperclip: {
    capabilities: ["companies/prompt-injection-prevention", "connection-setup/identity-and-access", "budgets-costs/cost-reporting"],
    implementation: "production", boundary: "fixtures",
    notes: "Production settings view with simulated save/test callbacks. Covers empty, configured, custom model, disabled, stale connection, saving, testing, success, incorrect verdict, and provider failure. Does not establish provider accuracy or API authorization.",
  } },
  id: "prompt-injection-prevention-01-settings",
  title: "Getting started and access/Companies and portability/Prompt Injection Prevention/01 Settings",
  component: PromptInjectionPreventionSettingsView,
  decorators: [(Story) => <main className="p-6"><Story /></main>],
  args: { settings: configured, choices, onSave: fn(), onTest: fn(), onAdd: fn(), onConnectionChange: fn() },
} satisfies Meta<typeof PromptInjectionPreventionSettingsView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = { args: { settings: empty, choices: [] } };
export const Configured: Story = {};
export const CustomModel: Story = { args: { settings: { ...configured, model: "openai/gpt-oss-safeguard-120b" } } };
export const Disabled: Story = { args: { settings: { ...configured, enabled: false } } };
export const UnavailableConnection: Story = { args: { choices: [] } };
export const Saving: Story = { args: { saving: true } };
export const Testing: Story = { args: { testing: true } };
export const Passed: Story = { args: { result: { passed: true, samples: [
  { name: "Benign source code", expectedViolation: false, actualViolation: false, passed: true, durationMs: 900 },
  { name: "Malicious instructions", expectedViolation: true, actualViolation: true, passed: true, durationMs: 850 },
] } } };
export const IncorrectVerdict: Story = { args: { result: { passed: false, samples: [
  { name: "Benign source code", expectedViolation: false, actualViolation: true, passed: false, durationMs: 900 },
] } } };
export const ProviderFailure: Story = { args: { result: { passed: false, samples: [
  { name: "Benign source code", expectedViolation: false, actualViolation: null, passed: false, durationMs: 10000, reason: "timeout" },
] } } };
export const SaveFailure: Story = { args: { error: "Could not save settings. Your changes are still here." } };
