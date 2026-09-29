import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ComposerModelPickerPreview } from "../prototypes/composer-model-picker/ComposerModelPickerPreview";
import { ComposerRunSettingsLiveStory } from "../prototypes/composer-model-picker/ComposerRunSettingsLiveStory";

const meta = {
  title: "Composer/Model and effort picker",
  component: ComposerModelPickerPreview,
  parameters: {
    layout: "fullscreen",
    options: { showPanel: false },
    docs: { description: { component:
      "The approved composer picker design and two matching stories using the production picker. The assignee capsule stays beside Send on desktop and mobile. The assignee determines the harness and catalog; changing assignees clears per-message overrides. Effort is selected only with a model-specific slider where levels are known. The picker animates its height as content changes and opens as a modal on mobile. Custom IDs are accepted for harnesses that support them, while OpenRouter requires openrouter/provider/model. A fast-mode icon sits to the left of the effort label only for supported known Codex models, and the reset icon sits to the right."
    } },
  },
  args: { agentId: "codex", initialPanel: "closed" },
  render: (args) => <ComposerModelPickerPreview key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof ComposerModelPickerPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultComposer: Story = {
  name: "01 · Unified assignee and model picker",
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const capsule = screen.getByRole("button", { name: "Select assignee, model and effort" });
    const send = screen.getByRole("button", { name: "Send message" });
    await expect(send.getBoundingClientRect().left - capsule.getBoundingClientRect().right).toBeLessThanOrEqual(16);
  },
};
export const EffortSlider: Story = {
  name: "02 · Codex effort slider",
  args: { initialPanel: "settings", initialEffort: "high" },
};
export const ExactEffort: Story = {
  name: "02b · Slider at Extra High",
  args: { initialPanel: "settings", initialEffort: "xhigh" },
};
export const ExactModelList: Story = {
  name: "03 · Search exact Codex models",
  args: { initialPanel: "models" },
};
export const AstraFastMode: Story = {
  name: "04 · Astra · fast icon active",
  args: { initialModel: "gpt-6-astra", initialEffort: "ultra", initialFast: true, initialPanel: "settings" },
};
export const FastModeToggle: Story = {
  name: "04b · Toggle fast icon",
  args: { initialPanel: "settings" },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const toggle = screen.getByRole("button", { name: "Fast mode" });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  },
};
export const FastModeUnavailable: Story = {
  name: "05 · Model without fast mode",
  args: { initialModel: "gpt-5.4-mini", initialPanel: "settings" },
};
export const CodexCustomUnknown: Story = {
  name: "05b · Custom Codex ID · capabilities unknown",
  args: { initialModel: "my-private-codex-model", initialPanel: "settings" },
};
export const ResetToAgentDefault: Story = {
  name: "06 · Reset model, effort and fast mode",
  args: { initialModel: "gpt-6-astra", initialEffort: "ultra", initialFast: true, initialPanel: "settings" },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(screen.getByRole("button", { name: "Reset to agent default" }));
    await expect(screen.getByTestId("selected-effort")).toHaveTextContent("Default");
    await expect(screen.getByRole("button", { name: "Choose exact model" })).toHaveTextContent("GPT-5.6 Sol");
    await expect(screen.getByRole("button", { name: "Fast mode" })).toHaveAttribute("aria-pressed", "false");
  },
};
export const Claude: Story = {
  name: "07 · Claude Code · low to high",
  args: { agentId: "claude", initialPanel: "settings", initialEffort: "medium" },
};
export const OpenRouterSearch: Story = {
  name: "08 · OpenRouter · search this provider",
  args: { agentId: "openrouter", initialPanel: "models", initialSearch: "deepseek" },
};
export const OpenRouterCustomId: Story = {
  name: "09 · OpenRouter · pasted custom ID",
  args: { agentId: "openrouter", initialModel: "openrouter/qwen/qwen3-coder-next", initialPanel: "settings" },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await expect(screen.queryByRole("slider")).toBeNull();
    await expect(screen.queryByText(/Effort levels are not advertised/)).toBeNull();
    await expect(screen.getByRole("button", { name: "Reset to agent default" })).toBeVisible();
  },
};
export const OpenRouterManualEntry: Story = {
  name: "10 · OpenRouter · type exact model",
  args: { agentId: "openrouter", initialPanel: "models", initialSearch: "openrouter/qwen/qwen3-coder-next" },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(screen.getByRole("button", { name: /Use exact ID/ }));
    await expect(screen.getByRole("button", { name: "Choose exact model" })).toHaveTextContent("openrouter/qwen/qwen3-coder-next");
    await expect(screen.queryByRole("slider")).toBeNull();
    await expect(screen.queryByText(/Effort levels are not advertised/)).toBeNull();
  },
};
export const OpenRouterPasteProposal: Story = {
  name: "10b · OpenRouter · paste proposal",
  args: { agentId: "openrouter", initialPanel: "models", initialSearch: "openrouter/qwen/qwen3-coder-next" },
};
export const OpenRouterInvalidId: Story = {
  name: "10c · OpenRouter · invalid ID guidance",
  args: { agentId: "openrouter", initialPanel: "models", initialSearch: "anthropic/claude-sonnet-4.6" },
};
export const PiThinking: Story = {
  name: "11 · Pi · thinking levels",
  args: { agentId: "pi", initialPanel: "settings", initialEffort: "high" },
};
export const KimiSupported: Story = {
  name: "12 · Kimi K3 · low, high, max",
  args: { agentId: "kimi", initialPanel: "settings", initialEffort: "high" },
};
export const KimiModelDefault: Story = {
  name: "13 · Kimi highspeed · no effort override",
  args: { agentId: "kimi", initialModel: "kimi-code/kimi-for-coding-highspeed", initialPanel: "settings" },
};
export const GeminiModelOnly: Story = {
  name: "14 · Gemini · model only",
  args: { agentId: "gemini", initialPanel: "settings" },
};
export const CursorModelOnly: Story = {
  name: "15 · Cursor · model only",
  args: { agentId: "cursor", initialPanel: "settings" },
};
export const CursorCloudManual: Story = {
  name: "15b · Cursor Cloud · manual model ID",
  args: { agentId: "cursor-cloud", initialPanel: "models" },
};
export const RunnerCodexProfile: Story = {
  name: "16 · Runner · Codex profile",
  args: { agentId: "runner", initialPanel: "models" },
};
export const GrokModelOnly: Story = {
  name: "17 · Grok · model only",
  args: { agentId: "grok", initialPanel: "settings" },
};
export const HermesManual: Story = {
  name: "17b · Hermes CLI · manual model ID",
  args: { agentId: "hermes", initialPanel: "models" },
};
export const ProcessNoModel: Story = {
  name: "18 · Process · no model setting",
  args: { agentId: "process", initialPanel: "settings" },
};
export const HttpNoModel: Story = {
  name: "18b · HTTP · remote model",
  args: { agentId: "http", initialPanel: "settings" },
};
export const GatewayNoModel: Story = {
  name: "19 · OpenClaw · remote model",
  args: { agentId: "openclaw", initialPanel: "settings" },
};
export const HermesGatewayNoModel: Story = {
  name: "19b · Hermes Gateway · remote model",
  args: { agentId: "hermes-gateway", initialPanel: "settings" },
};
export const AgentMenu: Story = {
  name: "20 · Searchable assignee list",
  args: { initialPanel: "agents" },
};
export const AssigneeSearch: Story = {
  name: "20a · Search by assignee harness",
  args: { initialPanel: "agents", initialAssigneeSearch: "OpenRouter" },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await expect(screen.getByRole("searchbox", { name: "Search assignees" })).toHaveValue("OpenRouter");
    await expect(screen.getAllByRole("option")).toHaveLength(1);
    await expect(screen.getByRole("option", { name: /Nora/ })).toBeVisible();
  },
};
export const AssigneeSearchNoMatches: Story = {
  name: "20aa · Assignee search has no matches",
  args: { initialPanel: "agents", initialAssigneeSearch: "unknown teammate" },
};
export const AssigneeSearchKeyboard: Story = {
  name: "20ab · Choose searched assignee with Enter",
  args: { initialPanel: "agents", initialAssigneeSearch: "OpenRouter" },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search assignees" }), "{Enter}");
    await expect(screen.getByRole("button", { name: "Choose exact model" })).toHaveTextContent("Claude Sonnet 4.6");
  },
};
export const AgentSwitchClearsOverrides: Story = {
  name: "20b · Switching agents resets overrides",
  args: { initialModel: "gpt-6-astra", initialEffort: "ultra", initialFast: true, initialPanel: "agents" },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(screen.getByRole("option", { name: /Nora/ }));
    await expect(screen.getByRole("button", { name: "Choose exact model" })).toHaveTextContent("Claude Sonnet 4.6");
    await expect(screen.queryByRole("slider")).toBeNull();
    await expect(screen.queryByText(/Effort levels are not advertised/)).toBeNull();
    await expect(screen.queryByRole("button", { name: "Fast mode" })).toBeNull();
  },
};
export const Mobile: Story = {
  name: "21 · Mobile · centered picker modal",
  args: { agentId: "codex", initialPanel: "settings", compact: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await expect(screen.getByTestId("composer-mobile-dialog")).toBeVisible();
    await expect(screen.getByRole("slider", { name: "Effort" })).toBeVisible();
  },
};
export const MobileAssigneeSearch: Story = {
  name: "21b · Mobile assignee search",
  args: { agentId: "codex", initialPanel: "agents", initialAssigneeSearch: "Claude", compact: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const MobileOpenRouterCustomId: Story = {
  name: "21c · Mobile · custom model without effort",
  args: { agentId: "openrouter", initialModel: "openrouter/qwen/qwen3-coder-next", initialPanel: "settings", compact: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await expect(screen.getByTestId("composer-mobile-dialog")).toBeVisible();
    await expect(screen.queryByRole("slider")).toBeNull();
    await expect(screen.queryByText(/Effort levels are not advertised/)).toBeNull();
  },
};
export const MobileModelSearch: Story = {
  name: "21d · Mobile · searchable model modal",
  args: { agentId: "openrouter", initialPanel: "models", initialSearch: "deepseek", compact: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const Light: Story = {
  name: "22 · Light theme",
  args: { agentId: "claude", initialPanel: "settings" },
  globals: { theme: "light" },
};

export const ProductionComposer: Story = {
  name: "23 · App picker in composer",
  render: () => <ComposerRunSettingsLiveStory initialPanel="models" />,
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const capsule = screen.getByTestId("task-chat-composer-assignee");
    const send = screen.getByRole("button", { name: "Send message" });
    await expect(send.getBoundingClientRect().left - capsule.getBoundingClientRect().right).toBeLessThanOrEqual(16);
  },
};

export const ProductionMobileComposer: Story = {
  name: "23b · App picker on mobile",
  render: () => <ComposerRunSettingsLiveStory initialPanel="settings" mobile compact />,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const capsule = screen.getByTestId("task-chat-composer-assignee");
    const send = screen.getByRole("button", { name: "Send message" });
    await expect(send.getBoundingClientRect().left - capsule.getBoundingClientRect().right).toBeLessThanOrEqual(16);
  },
};

export const IntermediateWidthPlan: Story = {
  name: "24 · Narrow desktop with Plan and open picker",
  args: { compact: true, initialMode: "planning", initialPanel: "settings" },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const chip = screen.getByRole("button", { name: "Remove Plan mode" }).getBoundingClientRect();
    const capsule = screen.getByRole("button", { name: "Select assignee, model and effort" }).getBoundingClientRect();
    const send = screen.getByRole("button", { name: "Send message" }).getBoundingClientRect();
    await expect(chip.height).toBe(capsule.height);
    await expect(Math.abs(send.top - capsule.top)).toBeLessThanOrEqual(1);
    await expect(send.left - capsule.right).toBeLessThanOrEqual(16);
    await expect(screen.getByTestId("composer-model-popover")).toBeVisible();
  },
};

export const ProductionIntermediateWidthPlan: Story = {
  name: "24b · App picker at narrow desktop width",
  render: () => <ComposerRunSettingsLiveStory compact initialMode="planning" initialPanel="settings" />,
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const chip = screen.getByRole("button", { name: "Remove Plan mode" }).getBoundingClientRect();
    const capsule = screen.getByTestId("task-chat-composer-assignee").getBoundingClientRect();
    const send = screen.getByRole("button", { name: "Send message" }).getBoundingClientRect();
    await expect(chip.height).toBe(capsule.height);
    await expect(Math.abs(send.top - capsule.top)).toBeLessThanOrEqual(1);
    await expect(send.left - capsule.right).toBeLessThanOrEqual(16);
    await expect(screen.getByTestId("composer-model-popover")).toBeVisible();
  },
};
