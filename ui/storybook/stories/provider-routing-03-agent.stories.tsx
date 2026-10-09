import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { AgentSetup } from "../prototypes/provider-routing/AgentSetup";
import { ReviewFrame } from "../prototypes/provider-routing/shared";
import {
  choose,
  reviewLifecycle,
} from "../prototypes/provider-routing/story-support";
const meta = {
  title: "AI Connections/Provider routing/03 Agent",
  component: AgentSetup,
  parameters: { layout: "fullscreen" },
  ...reviewLifecycle,
  decorators: [
    (Story) => (
      <ReviewFrame location="Agents → Nova → Harness / Runtime (/agents/nova/runtime). Existing agent page and sidebar; proposed connection routing fields. The same fields are embedded in Create agent → Configure.">
        <Story />
      </ReviewFrame>
    ),
  ],
  render: (args) => <AgentSetup key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof AgentSetup>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CodexNewRunner: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("combobox", { name: "Connection" }),
    ).toHaveTextContent("My ChatGPT subscription");
    await expect(
      canvas.queryByRole("option", { name: "Engineering gateway" }),
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByText("https://models.example.com/v1"),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(canvas.getByRole("group", { name: "Model selection" })).getByRole(
        "button",
        { name: "gpt-5.4" },
      ),
    );
    const body = within(canvasElement.ownerDocument.body);
    await expect(
      await body.findByPlaceholderText("Search models..."),
    ).toBeVisible();
    await expect(
      body.queryByPlaceholderText("Search models... (type to create)"),
    ).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
  },
};
export const ClaudeDefault: Story = { args: { harness: "claude" } };
export const AdvancedProviders: Story = {
  name: "Advanced model settings",
  args: { initialAdvanced: true },
};
export const ChangeConnection: Story = {
  name: "Connection dropdown",
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("combobox", {
        name: "Connection",
      }),
    );
    const options = within(
      await within(canvasElement.ownerDocument.body).findByRole("listbox"),
    );
    await expect(
      options.getByRole("option", { name: "My ChatGPT subscription" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      options.getByRole("option", { name: "Company OpenAI" }),
    ).toBeVisible();
    await expect(
      options.getByRole("option", { name: "Engineering gateway" }),
    ).toBeVisible();
    await expect(
      options.getByRole("option", { name: "Company OpenRouter" }),
    ).toBeVisible();
    await expect(
      options.getByRole("option", { name: "Company Bedrock" }),
    ).toBeVisible();
    await expect(
      options.queryByRole("option", { name: "My Claude subscription" }),
    ).not.toBeInTheDocument();
    await expect(
      options.queryByRole("option", { name: "Local model service" }),
    ).not.toBeInTheDocument();
  },
};
export const ChangeAccountWalkthrough: Story = {
  args: { initialTest: "pass" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const change = canvas.getByRole("combobox", { name: "Connection" });
    await userEvent.click(change);
    await body.findByRole("listbox");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(change).toHaveFocus());
    await expect(
      canvas.getByRole("button", { name: "Save changes" }),
    ).toBeEnabled();
    await userEvent.click(change);
    await userEvent.click(
      within(await body.findByRole("listbox")).getByRole("option", {
        name: "Company OpenAI",
      }),
    );
    await waitFor(() =>
      expect(body.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    await expect(
      canvas.getByRole("combobox", { name: "Connection" }),
    ).toHaveTextContent("Company OpenAI");
    await expect(
      canvas.getByRole("group", { name: "Model selection" }),
    ).toHaveTextContent("gpt-5.4");
    await expect(
      canvas.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    await expect(
      canvas.getByRole("button", { name: "Advanced model settings" }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(
      canvas.queryByText("https://api.openai.com/v1"),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(change).toHaveFocus());
  },
};
export const HarnessConnectionFiltering: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      within(
        canvas.getByRole("group", { name: "Harness selection" }),
      ).getByRole("button", { name: "Codex" }),
    );
    await userEvent.click(
      await body.findByRole("button", { name: "Claude Code" }),
    );
    await userEvent.click(canvas.getByRole("combobox", { name: "Connection" }));
    const options = within(await body.findByRole("listbox"));
    await expect(
      options.getByRole("option", { name: "My Claude subscription" }),
    ).toBeVisible();
    await expect(
      options.getByRole("option", { name: "Company OpenRouter" }),
    ).toBeVisible();
    await expect(
      options.getByRole("option", { name: "Company Bedrock" }),
    ).toBeVisible();
    for (const name of [
      "My ChatGPT subscription",
      "Company OpenAI",
      "Engineering gateway",
      "Company Gemini",
      "Local model service",
    ]) {
      await expect(
        options.queryByRole("option", { name }),
      ).not.toBeInTheDocument();
    }
    await userEvent.click(
      options.getByRole("option", { name: "My Claude subscription" }),
    );
    await userEvent.click(
      within(canvas.getByRole("group", { name: "Model selection" })).getByRole(
        "button",
        { name: "gpt-5.4" },
      ),
    );
    await userEvent.click(
      await body.findByRole("button", { name: "claude-sonnet-4-6" }),
    );
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};
export const ConfiguredGateway: Story = {
  args: { initialConnectionId: "gateway" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("combobox", { name: "Connection" }),
    ).toHaveTextContent("Engineering gateway");
    await expect(
      canvas.getByRole("group", { name: "Model selection" }),
    ).toHaveTextContent("engineering-coder");
    await expect(
      canvas.queryByText("https://models.example.com/v1"),
    ).not.toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Advanced model settings" }),
    ).toHaveAttribute("aria-expanded", "false");
  },
};
export const CodexLegacy: Story = { args: { runner: "legacy" } };
export const ClaudeBedrock: Story = {
  args: { harness: "claude", initialConnectionId: "bedrock" },
};
export const OpenCodeNewRunner: Story = { args: { harness: "opencode" } };
export const GrokNewRunner: Story = { args: { harness: "grok" } };
export const PiLegacy: Story = { args: { harness: "pi", runner: "legacy" } };
export const GeminiLegacy: Story = {
  args: { harness: "gemini", runner: "legacy", initialConnectionId: "gemini" },
};
export const KimiLegacy: Story = {
  args: { harness: "kimi", runner: "legacy" },
};
export const HermesLocal: Story = {
  args: { harness: "hermes", runner: "legacy", initialConnectionId: "chat" },
};
export const CursorUnverified: Story = {
  args: { harness: "cursor", runner: "legacy" },
};
export const NativePiPending: Story = { args: { harness: "pi" } };
export const NativeCopilotPending: Story = { args: { harness: "copilot" } };
export const NewAgent: Story = { args: { newAgent: true } };
export const NoConnections: Story = { args: { scenario: "empty" } };
export const Loading: Story = { args: { scenario: "loading" } };
export const ModelDiscoveryFailed: Story = {
  args: { scenario: "catalog-error" },
};
export const IncompatibleProtocol: Story = {
  args: { initialConnectionId: "chat" },
};
export const MissingPersonalCredential: Story = {
  args: { initialConnectionId: "gateway", scenario: "missing-personal" },
};
export const SharedAccessDenied: Story = {
  args: { scenario: "denied", initialConnectionId: "router" },
};
export const ReadOnly: Story = { args: { scenario: "readonly" } };
export const AdoptLegacySettings: Story = {
  args: { runner: "legacy", scenario: "legacy" },
};
export const TestRunning: Story = { args: { initialTest: "running" } };
export const TestPassed: Story = { args: { initialTest: "pass" } };
export const ToolSupportFailed: Story = {
  args: { initialTest: "fail", testFailure: "tools" },
};
export const EnvironmentUnreachable: Story = {
  args: { initialTest: "fail", testFailure: "network" },
};
export const Mobile: Story = {
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const ChangeConnectionWalkthrough: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await choose(canvasElement, "Connection", "Engineering gateway");
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(body.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    await expect(
      canvas.getByRole("group", { name: "Harness selection" }),
    ).toHaveTextContent("Codex");
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "previous model is unavailable",
    );
    await expect(
      canvas.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    await userEvent.click(
      within(canvas.getByRole("group", { name: "Model selection" })).getByRole(
        "button",
        { name: "gpt-5.4" },
      ),
    );
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("button", {
        name: "engineering-coder",
      }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Run test" }));
    await expect(
      await canvas.findByText("Connection successful"),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }));
    await expect(canvas.getByText(/Nova’s configuration saved/)).toBeVisible();
    await choose(canvasElement, "Execution environment", "Local machine");
    await expect(
      canvas.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
  },
};
export const CustomModelAlias: Story = {
  args: { initialConnectionId: "gateway" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Advanced model settings" }),
    );
    await userEvent.click(
      within(canvas.getByRole("group", { name: "Model selection" })).getByRole(
        "button",
        { name: "engineering-coder" },
      ),
    );
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.type(
      await body.findByPlaceholderText("Search models... (type to create)"),
      "team-reviewer",
    );
    await userEvent.click(body.getByRole("button", { name: /team-reviewer/ }));
    await expect(
      canvas.getByRole("group", { name: "Model selection" }),
    ).toHaveTextContent("team-reviewer");
    await userEvent.click(
      canvas.getByRole("button", { name: "Advanced model settings" }),
    );
    await expect(
      canvas.getByRole("group", { name: "Model selection" }),
    ).toHaveTextContent("team-reviewer");
    await expect(
      canvas.getByRole("combobox", { name: "Connection" }),
    ).toHaveTextContent("Engineering gateway");
    await expect(
      canvas.queryByRole("region", { name: "Connection" }),
    ).not.toBeInTheDocument();
  },
};
