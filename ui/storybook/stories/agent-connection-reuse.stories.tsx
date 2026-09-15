import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import {
  AgentProviderConnection,
  type ProviderConnection,
} from "@/components/new-agent/AgentProviderConnection";
import {
  resetOnboardingFixtureState,
  setOnboardingFixtureState,
  STORYBOOK_SANDBOX_ENVIRONMENT_ID,
} from "../fixtures/onboardingEnvironment";

function ConnectionStory({
  adapterType = "claude_local",
}: {
  adapterType?: "claude_local" | "codex_local";
}) {
  const [connection, setConnection] = useState<ProviderConnection | null>(null);
  return (
    <div className="w-full max-w-lg p-6">
      <h2 className="mb-6 text-xl font-semibold">Connect a model</h2>
      {connection ? (
        <div role="status">
          Connection selected. Continue to agent configuration.
        </div>
      ) : (
        <AgentProviderConnection
          companyId="company-storybook"
          adapterType={adapterType}
          environmentId={STORYBOOK_SANDBOX_ENVIRONMENT_ID}
          canLogin
          onBack={() => {}}
          onConnected={setConnection}
          testConnection={async (value) => {
            if (
              Object.values(value.env).some(
                (binding) =>
                  typeof binding === "string" || binding.type === "plain",
              )
            )
              throw new Error("Expected a stored reference");
            return true;
          }}
        />
      )}
    </div>
  );
}
const meta = {
  title: "Onboarding/Saved connections",
  component: ConnectionStory,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Production agent connection component with fixture API responses. Provider tests and subsequent hiring are simulated. Choose subscription or API key, reuse a saved connection, or enter a new key.",
      },
    },
  },
  beforeEach: () => {
    resetOnboardingFixtureState();
    return resetOnboardingFixtureState;
  },
} satisfies Meta<typeof ConnectionStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ClaudeSubscription: Story = {
  beforeEach: () => {
    setOnboardingFixtureState({
      savedClaudeLogin: true,
      authSignal: "present",
    });
    return resetOnboardingFixtureState;
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("radio"));
  },
};
export const NewClaudeSubscription: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("radio"));
  },
};
export const NewCodexSubscription: Story = {
  args: { adapterType: "codex_local" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Use subscription instead" }));
    await userEvent.click(canvas.getByRole("radio"));
  },
};
export const ClaudeApiKeys: Story = {
  beforeEach: () => {
    setOnboardingFixtureState({ savedApiKeys: true });
    return resetOnboardingFixtureState;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio"));
    await expect(
      await canvas.findByRole("combobox", { name: "Saved API key" }),
    ).not.toHaveValue("");
  },
};
export const CodexApiKeys: Story = {
  ...ClaudeApiKeys,
  args: { adapterType: "codex_local" },
};
export const ReuseClaudeApiKey: Story = {
  ...ClaudeApiKeys,
  play: async (context) => {
    await ClaudeApiKeys.play!(context);
    const canvas = within(context.canvasElement);
    await userEvent.selectOptions(
      canvas.getByRole("combobox"),
      "user:ANTHROPIC_API_KEY",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Use saved API key" }),
    );
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "Connection selected",
    );
  },
};

export const CodexSubscription: Story = {
  args: { adapterType: "codex_local" },
  beforeEach: () => {
    setOnboardingFixtureState({ savedCodexLogin: true, authSignal: "unknown" });
    return resetOnboardingFixtureState;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("combobox", { name: "Saved subscription" });
    await userEvent.click(canvas.getByRole("radio"));
  },
};
