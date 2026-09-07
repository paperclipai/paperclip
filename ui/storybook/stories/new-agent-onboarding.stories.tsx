import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { NewAgentWizard } from "../prototypes/NewAgentWizard";

const meta = {
  title: "Onboarding/New agent",
  component: NewAgentWizard,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Interactive design prototype: name → adapter → simulated creation → connection → configuration → confirmation. Each screen is directly inspectable below. All state is local to the story; subscription and API-key connections are simulated, and actual hiring is deferred. Use Start over to replay. The adapter and runner are fixed after creation." } },
  },
  argTypes: {
    testOutcome: { control: "select", options: ["pass", "fail"] },
    initialTestState: { control: "select", options: ["idle", "running", "pass", "fail"] },
    initialScreen: { control: "select", options: ["name", "adapter", "connect", "runtime", "saved"] },
    initialRunnerProvider: { control: "select", options: ["Codex (app server)", "Claude (ACPX)", "OpenCode"] },
    initialConnectionMethod: { control: "select", options: ["subscription", "api"] },
    initialAdapter: { control: "select", options: [null, "claude_local", "codex_local", "cursor", "cursor_cloud", "gemini_local", "grok_local", "kimi_local", "opencode_local", "pi_local", "hermes_local", "paperclip_runner"] },
  },
  // Remount when Storybook controls change; normal wizard navigation keeps drafts.
  render: args => <NewAgentWizard key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof NewAgentWizard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const InteractiveFlow: Story = { name: "Start here · Interactive flow" };
export const NameYourAgent: Story = { name: "01 · Name your agent", args: { initialName: "Darnold" } };
export const ChooseAdapter: Story = { name: "02 · All adapters", args: { initialScreen: "adapter", initialName: "Darnold" } };
export const AdapterSelected: Story = { name: "03 · Adapter selected", args: { initialScreen: "adapter", initialName: "Darnold", initialAdapter: "opencode_local" } };
export const OpenCodeConfiguration: Story = { name: "04 · OpenCode configuration", args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "opencode_local" } };
export const PiConfiguration: Story = { name: "05 · Pi configuration", args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "pi_local" } };
export const ClaudeConfiguration: Story = { args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "claude_local" } };
export const CodexConfiguration: Story = { args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "codex_local" } };
export const CursorConfiguration: Story = { args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "cursor" } };
export const CursorCloudConfiguration: Story = { args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "cursor_cloud" } };
export const GeminiConfiguration: Story = { args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "gemini_local" } };
export const GrokBuildConfiguration: Story = { args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "grok_local" } };
export const KimiConfiguration: Story = { args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "kimi_local" } };
export const HermesConfiguration: Story = { args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "hermes_local" } };
export const Confirmation: Story = { name: "06 · Confirmation", args: { initialScreen: "saved", initialName: "Darnold", initialAdapter: "opencode_local" } };
export const NewAgentEntryPoint: Story = { name: "New agent entry point", args: { initialOpen: false } };
export const MobileAdapterPicker: Story = { name: "Mobile · Adapter picker", args: { initialScreen: "adapter", initialName: "Darnold" }, globals: { viewport: { value: "mobile1", isRotated: false } } };

export const RunnerAcpxClaude: Story = { name: "Runner · ACPX with Claude", args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "paperclip_runner", initialRunnerProvider: "Claude (ACPX)" } };
export const RunnerOpenCode: Story = { name: "Runner · OpenCode", args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "paperclip_runner", initialRunnerProvider: "OpenCode" } };

export const NativeCodexRunner: Story = { name: "Runner · Native Codex app server", args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "paperclip_runner", initialRunnerProvider: "Codex (app server)" } };
export const ClaudeAdapterApiKey: Story = { name: "Connect · Claude adapter · API key", args: { initialScreen: "connect", initialName: "Darnold", initialAdapter: "claude_local", initialConnectionMethod: "api" } };
export const CodexAdapterApiKey: Story = { name: "Connect · Codex adapter · API key", args: { initialScreen: "connect", initialName: "Darnold", initialAdapter: "codex_local", initialConnectionMethod: "api" } };
export const ClaudeRunnerApiKey: Story = { name: "Connect · Claude runner · API key", args: { initialScreen: "connect", initialName: "Darnold", initialAdapter: "paperclip_runner", initialRunnerProvider: "Claude (ACPX)", initialConnectionMethod: "api" } };
export const CodexRunnerApiKey: Story = { name: "Connect · Native Codex runner · API key", args: { initialScreen: "connect", initialName: "Darnold", initialAdapter: "paperclip_runner", initialRunnerProvider: "Codex (app server)", initialConnectionMethod: "api" } };
export const ClaudeAdapterSubscription: Story = { name: "Connect · Claude adapter · Subscription", args: { initialScreen: "connect", initialName: "Darnold", initialAdapter: "claude_local", initialConnectionWaiting: true } };
export const CodexAdapterSubscription: Story = { name: "Connect · Codex adapter · Subscription", args: { initialScreen: "connect", initialName: "Darnold", initialAdapter: "codex_local", initialConnectionWaiting: true } };
export const ClaudeRunnerSubscription: Story = { name: "Connect · Claude runner · Subscription", args: { initialScreen: "connect", initialName: "Darnold", initialAdapter: "paperclip_runner", initialRunnerProvider: "Claude (ACPX)", initialConnectionWaiting: true } };
export const CodexRunnerSubscription: Story = { name: "Connect · Native Codex runner · Subscription", args: { initialScreen: "connect", initialName: "Darnold", initialAdapter: "paperclip_runner", initialRunnerProvider: "Codex (app server)", initialConnectionWaiting: true } };

export const ConnectYourAgent: Story = { name: "Connect · Choose subscription or API key", args: { initialScreen: "connect", initialName: "Darnold", initialAdapter: "claude_local" } };
export const CodexConfirmation: Story = { name: "Confirmation · Native Codex runner", args: { initialScreen: "saved", initialName: "Darnold", initialAdapter: "paperclip_runner", initialRunnerProvider: "Codex (app server)" } };

export const RuntimeTestSucceeded: Story = { name: "Test · Succeeded", args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "pi_local", initialTestState: "pass" } };
export const RuntimeTestFailed: Story = { name: "Test · Failed", args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "pi_local", initialTestState: "fail", testOutcome: "fail" } };
export const RuntimeTestRunning: Story = { name: "Test · Running", args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "codex_local", initialTestState: "running", testDelayMs: 10000 } };
export const RuntimeTestRetry: Story = { name: "Test · Retry after failure", args: { initialScreen: "runtime", initialName: "Darnold", initialAdapter: "claude_local", initialTestState: "fail", testOutcome: "pass" } };

export const AssignFirstTask: Story = {
  name: "Confirmation · Assign a task",
  args: { initialScreen: "saved", initialName: "Nova", initialAdapter: "codex_local" },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Assign Nova a Task" }));
  },
};
