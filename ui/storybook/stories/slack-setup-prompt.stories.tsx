import type { Meta, StoryObj } from "@storybook/react-vite";
import { SlackSetupPrompt, buildSlackSetupPrompt } from "@/pages/apps/chat/SlackSetupPrompt";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SetupWizardFooter } from "@/components/SetupWizard";

const instanceUrl = import.meta.env.VITE_PAPERCLIP_INSTANCE_URL ?? "";
const meta = {
  title: "Connections/Slack/Setup prompt",
  component: SlackSetupPrompt,
  parameters: {
    layout: "padded",
    docs: { description: { component: "Production copy button and full browser-agent prompt. The surrounding agent selection is a static placement preview; it does not create a connection. Configure PAPERCLIP_STORYBOOK_API_URL to include a real instance origin in copied instructions. Otherwise the prompt asks for the instance URL." } },
  },
  args: { instanceUrl },
} satisfies Meta<typeof SlackSetupPrompt>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChooseAgent: Story = {
  render: (args) => (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-bold">Which agent do you want to chat with?</h1>
        <p className="mt-1 text-sm text-muted-foreground">This agent is permanent for the connection. Connect another channel to represent a different agent.</p>
      </div>
      <SlackSetupPrompt {...args} />
      <Input aria-label="Assigned agent (preview)" value="CEO" readOnly />
      <SetupWizardFooter onSaveExit={() => {}}>
        <Button disabled>Continue</Button>
      </SetupWizardFooter>
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm text-muted-foreground">Read the copied prompt (preview only)</summary>
        <pre className="whitespace-pre-wrap break-words rounded-lg border border-border p-4 font-mono text-xs">{buildSlackSetupPrompt(args.instanceUrl ?? "")}</pre>
      </details>
    </div>
  ),
};
export const ButtonOnly: Story = {};
export const Mobile: Story = {
  ...ChooseAgent,
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
