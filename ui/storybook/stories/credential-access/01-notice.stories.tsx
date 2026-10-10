import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskChatMarker } from "@/components/task-chat/TaskChatMarker";

const meta = {
  title: "Task credential access/01 Notice",
  component: TaskChatMarker,
  parameters: { layout: "centered" },
  decorators: [Story => <div className="w-full max-w-2xl"><Story /></div>],
  args: {
    item: {
      id: "credential-failure", kind: "marker", variant: "interrupted", label: "Run failed",
      retryable: false, runHref: "/agents/agent-codex/runs/credential-run",
      credentialAccess: { agentName: "Codie", credentialName: "Dotta’s API Key", deniedUser: "you", settingsHref: "/agents/agent-codex/runtime" },
    },
  },
} satisfies Meta<typeof TaskChatMarker>;
export default meta;
type Story = StoryObj<typeof meta>;
export const YourAccess: Story = {};
export const AnotherPersonsTask: Story = {
  args: { item: { ...meta.args.item, credentialAccess: { ...meta.args.item.credentialAccess, deniedUser: "Nicky" } } },
};
export const OlderRunWithoutCredentialName: Story = {
  args: { item: { ...meta.args.item, credentialAccess: { ...meta.args.item.credentialAccess, credentialName: undefined } } },
};
export const LongNames: Story = {
  args: { item: { ...meta.args.item, credentialAccess: { ...meta.args.item.credentialAccess,
    agentName: "Codie — product engineering", credentialName: "Dotta’s OpenAI API Key for staging product engineering" } } },
};
export const Light: Story = { globals: { theme: "light" } };
