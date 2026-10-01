import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { MCP_CONFIG_HELP_PROMPT } from "@paperclipai/shared";
import { BookOpen, KeyRound } from "lucide-react";
import { AgentSetupPrompt } from "@/components/AgentSetupPrompt";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { buildSlackSetupPrompt, SlackSetupPrompt } from "@/pages/apps/chat/SlackSetupPrompt";
import { GitHubSetupPrompt } from "@/pages/apps/chat/GitHubSetupPrompt";
import { McpConfigHelpDialog } from "@/pages/tools/McpConfigHelpDialog";
import { AgentInstructions } from "@/components/routine-triggers/WebhookFields";
import { IssueContinuationHandoff } from "@/components/IssueContinuationHandoff";
import { webhookAgentInstructions } from "../fixtures/routineTriggerWizard";
import { storybookContinuationHandoff } from "../fixtures/paperclipData";

const slackPrompt = buildSlackSetupPrompt(import.meta.env.VITE_PAPERCLIP_INSTANCE_URL ?? "");
const apiPrompt = `Help me connect my agent to the Paperclip API.

First, ask me for my Paperclip instance URL if it is not already available. Read its API documentation and identify the company and agent I want to use.

Guide me through creating a dedicated agent API key. Store it securely in my agent's environment; do not paste it into code, logs, or chat.

Configure the base URL and authentication, then verify the connection with a read-only request. Show me what worked and ask before making any changes to my company.`;

const meta = {
  title: "Components/Agent setup prompt",
  component: AgentSetupPrompt,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "A reusable handoff to an agent. Hover or focus to fan out the logos, click once to copy the prompt and open its preview. Logos travel into the preview; clipboard success stays in place. Supports reduced motion, keyboard dismissal, and manual copying when clipboard access fails. The default story copies the complete production Slack setup prompt." } },
  },
  args: {
    prompt: slackPrompt,
    title: "Agent setup",
    description: "Paste this into your agent to configure your Slack bot.",
    label: "Set up with an agent",
    side: "top",
    align: "start",
    variant: "outline",
  },
  argTypes: {
    variant: { control: "select", options: ["outline", "ghost"] },
    side: { control: "select", options: ["top", "bottom", "left", "right"] },
    align: { control: "select", options: ["start", "center", "end"] },
  },
  render: (args) => <div className="flex min-h-screen items-center justify-center p-6"><AgentSetupPrompt {...args} /></div>,
} satisfies Meta<typeof AgentSetupPrompt>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-8 p-6">
      <div className="flex flex-col gap-3">
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">A little help with setup</span>
        <h1 className="text-3xl font-semibold tracking-tight">Let your agent handle it.</h1>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">Give your agent the instructions. Get back to what you were building.</p>
      </div>
      <div className="flex flex-col gap-6 rounded-xl border border-border bg-card p-6">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <img src="/brands/apps/slack.svg" alt="" className="size-6" />
          </div>
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-medium">Connect Slack</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">Bring your Paperclip agent into your workspace.</p>
          </div>
        </div>
        <div><AgentSetupPrompt {...args} /></div>
      </div>
      <p className="text-xs text-muted-foreground">Hover the logos. Click once to copy and preview.</p>
    </div>
  ),
};

export const ButtonOnly: Story = {};
export const OpenPreview: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Set up with an agent" }));
    await expect(within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Agent setup" })).toBeVisible();
  },
};
export const Light: Story = { ...Playground, globals: { theme: "light" } };
export const Mobile: Story = {
  ...Playground,
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const ApiSetup: Story = {
  args: { prompt: apiPrompt, description: "Paste this into your agent to configure the API.", label: "Configure with an agent" },
};
export const ClipboardCheck: Story = {
  render: (args) => (
    <div className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-4 p-6">
      <div><AgentSetupPrompt {...args} /></div>
      <label htmlFor="clipboard-check" className="text-sm text-muted-foreground">Click the setup button, then paste here to check the full text.</label>
      <Textarea id="clipboard-check" placeholder="Paste the copied prompt here" rows={8} className="font-mono text-xs" />
    </div>
  ),
};
export const QuickAccess: Story = {
  args: { prompt: apiPrompt, description: "Paste this into your agent to configure the API.", variant: "ghost", label: "Agent setup" },
  render: (args) => (
    <div className="flex min-h-screen items-center p-6">
      <div className="flex w-64 flex-col gap-1 rounded-xl border border-border bg-card p-2">
        <p className="px-3 py-2 text-xs text-muted-foreground">Quick access</p>
        <Button variant="ghost" className="justify-start" disabled><KeyRound />API key</Button>
        <AgentSetupPrompt {...args} />
        <Button variant="ghost" className="justify-start" disabled><BookOpen />Documentation</Button>
      </div>
    </div>
  ),
};

export const ClipboardUnavailable: Story = {
  beforeEach: () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const execCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Clipboard disabled for this story"); } } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    return () => {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
      if (execCommand) Object.defineProperty(document, "execCommand", execCommand);
      else Reflect.deleteProperty(document, "execCommand");
    };
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Set up with an agent" }));
    await expect(body.getByRole("alert")).toHaveTextContent("Could not copy automatically");
    await expect(body.getByRole("textbox", { name: "Setup prompt" })).toHaveValue(slackPrompt);
  },
};

export const AppPlacements: Story = {
  render: () => (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 p-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Hand it to your agent</h1>
        <p className="text-sm text-muted-foreground">The same one-click handoff across the app. These are the production controls, with sample data for webhooks and task continuation.</p>
      </div>
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Slack connection</h2>
        <SlackSetupPrompt instanceUrl={import.meta.env.VITE_PAPERCLIP_INSTANCE_URL ?? ""} />
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-medium">GitHub connection</h2>
        <GitHubSetupPrompt instanceUrl={import.meta.env.VITE_PAPERCLIP_INSTANCE_URL ?? ""} />
      </section>
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">MCP configuration help</h2>
          <McpConfigHelpDialog />
        </div>
      </section>
      <AgentInstructions value={webhookAgentInstructions("github")} />
      <IssueContinuationHandoff document={storybookContinuationHandoff} />
    </div>
  ),
};

export const InsideMcpHelp: Story = {
  render: () => <div className="p-6"><McpConfigHelpDialog /></div>,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    // Synthetic play events lack clipboard user activation in some browsers.
    // Restore the real clipboard after the assertions for manual exploration.
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      await userEvent.click(within(canvasElement).getByRole("button", { name: "Get help creating an MCP config" }));
      const trigger = await body.findByRole("button", { name: "Get a config with an agent" });
      await userEvent.click(trigger);
      await waitFor(async () => {
        await expect(body.getByRole("dialog", { name: "MCP configuration" })).toBeVisible();
        await expect(body.getByRole("button", { name: "Copied to clipboard" })).toHaveFocus();
        await expect(writeText).toHaveBeenCalledTimes(1);
        await expect(writeText).toHaveBeenCalledWith(MCP_CONFIG_HELP_PROMPT);
      });
      await userEvent.keyboard("{Escape}");
      await waitFor(async () => {
        await expect(body.queryByRole("dialog", { name: "MCP configuration" })).not.toBeInTheDocument();
        await expect(body.getByRole("dialog", { name: "Ask an agent for an MCP config" })).toBeVisible();
        await expect(trigger).toHaveFocus();
        await expect(writeText).toHaveBeenCalledTimes(1);
      });
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  },
};
